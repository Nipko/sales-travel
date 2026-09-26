import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkService } from '../network/network.service.js';
import {
  ReconciliationController,
  ReconciliationRequestSchema,
} from './reconciliation.controller.js';
import type { ReconciliationService } from './reconciliation.service.js';

/**
 * El botón "forzar conciliación" y el reporte del dueño de la cuenta (docs/tbo/09 PR-5.5; D-TBO-24
 * A, D-TBO-27 A): sólo quien gestiona el tenant dueño, como las credenciales.
 */

const DUENO = 'c0000000-0000-4000-8000-000000000001';
const CUENTA = '10000000-0000-4000-8000-000000000001';
const USUARIO = '30000000-0000-4000-8000-000000000003';

function controllerCon(puedeGestionar = true) {
  const force = vi.fn<ReconciliationService['force']>(() =>
    Promise.resolve({ accountId: CUENTA, providerCode: 'tbo-hotels', queued: true }),
  );
  const report = vi.fn<ReconciliationService['report']>(() =>
    Promise.resolve({
      runs: [
        {
          id: 'run-1',
          trigger: 'forced',
          status: 'completed',
          windows: [{ from: '2026-09-24', to: '2026-09-26', leg: 'A' }],
          rowsRead: 3,
          rowsMatched: 2,
          discrepancies: 1,
          summary: { findings: { R2: 1 } },
          errorClass: null,
          startedAt: new Date('2026-09-26T04:30:00Z'),
          finishedAt: new Date('2026-09-26T04:31:00Z'),
        },
      ],
      items: [
        {
          id: 'item-1',
          runId: 'run-1',
          kind: 'R2',
          severity: 'info',
          action: 'reported',
          orderId: null,
          providerBookingId: 'EXT001',
          details: { bookingDate: '2026-09-25' },
          createdAt: new Date('2026-09-26T04:31:00Z'),
        },
      ],
    }),
  );
  const canManageTenant = vi.fn(() => Promise.resolve(puedeGestionar));
  const controller = new ReconciliationController(
    { force, report } as unknown as ReconciliationService,
    { canManageTenant } as unknown as NetworkService,
  );
  return { controller, force, report, canManageTenant };
}

describe('POST /provider-accounts/:accountId/reconciliation', () => {
  it('fuerza la corrida con el usuario como actor, sobre el tenant dueño', async () => {
    const c = controllerCon();

    await expect(c.controller.force(USUARIO, CUENTA, { tenantId: DUENO })).resolves.toEqual({
      accountId: CUENTA,
      providerCode: 'tbo-hotels',
      queued: true,
    });
    expect(c.canManageTenant).toHaveBeenCalledWith(USUARIO, DUENO);
    expect(c.force).toHaveBeenCalledWith(DUENO, CUENTA, USUARIO);
  });

  it('sin sesión, 401; sin gestionar el tenant, 403 y no se toca nada', async () => {
    const sinSesion = controllerCon();
    await expect(
      sinSesion.controller.force(undefined, CUENTA, { tenantId: DUENO }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const ajeno = controllerCon(false);
    await expect(
      ajeno.controller.force(USUARIO, CUENTA, { tenantId: DUENO }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ajeno.force).not.toHaveBeenCalled();
  });

  it('el cuerpo es sólo el tenant dueño, un UUID', () => {
    expect(ReconciliationRequestSchema.safeParse({ tenantId: DUENO }).success).toBe(true);
    expect(ReconciliationRequestSchema.safeParse({ tenantId: 'x' }).success).toBe(false);
    expect(
      ReconciliationRequestSchema.safeParse({ tenantId: DUENO, accountId: CUENTA }).success,
    ).toBe(false);
  });
});

describe('GET /provider-accounts/:accountId/reconciliation', () => {
  it('devuelve las corridas y el reporte del dueño con fechas ISO', async () => {
    const c = controllerCon();

    const out = await c.controller.report(USUARIO, CUENTA, DUENO);

    expect(c.report).toHaveBeenCalledWith(DUENO, CUENTA);
    expect(out.runs[0]).toMatchObject({
      id: 'run-1',
      status: 'completed',
      startedAt: '2026-09-26T04:30:00.000Z',
      finishedAt: '2026-09-26T04:31:00.000Z',
    });
    expect(out.items).toEqual([
      expect.objectContaining({
        kind: 'R2',
        providerBookingId: 'EXT001',
        createdAt: '2026-09-26T04:31:00.000Z',
      }),
    ]);
  });

  it('sin gestionar el tenant, 403', async () => {
    const c = controllerCon(false);
    await expect(c.controller.report(USUARIO, CUENTA, DUENO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(c.report).not.toHaveBeenCalled();
  });
});
