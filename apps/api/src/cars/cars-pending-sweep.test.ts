import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCarReservationStatus } from './car-reservation-status.js';
import {
  CAR_PENDING_CALL_GAP_MS,
  CAR_PENDING_MAX_AGE_DAYS,
  CAR_PENDING_PER_TENANT_LIMIT,
  CarsPendingSweepService,
  type CarPendingSweepReport,
} from './cars-pending-sweep.service.js';

/*
 * Las reservas de autos en espera / on request quedaban `pending` para siempre (A3 de
 * docs/platform/19). El barrido las lee en AgentCars con la credencial del tenant y mueve la orden
 * cuando se resolvió, con su domain event; lo que sigue en espera o no se entiende no se toca.
 */

describe('classifyCarReservationStatus', () => {
  it.each([
    ['Activo', 'confirmed'],
    ['Active', 'confirmed'],
    ['activated', 'confirmed'],
    ['Confirmada', 'confirmed'],
    ['On Hold', 'pending'],
    ['on_request', 'pending'],
    ['En espera', 'pending'],
    ['Pendiente de confirmación', 'pending'],
    ['Cancelada', 'cancelled'],
    ['Cancelled', 'cancelled'],
    ['Inactivo', 'cancelled'],
    ['Expired', 'cancelled'],
    ['Rechazada', 'rejected'],
    ['Rejected', 'rejected'],
    ['', 'unknown'],
    ['XYZ', 'unknown'],
  ])('«%s» → %s', (raw, expected) => {
    expect(classifyCarReservationStatus(raw)).toBe(expected);
  });
});

const NOW = Date.parse('2026-11-19T12:00:00Z');
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

interface Row {
  id: string;
  user_id: string;
  provider_order_id: string | null;
  passengers: unknown;
  search_criteria: unknown;
}

function row(id: string, code: string, pickUpDate = '2026-12-20', surname = 'García'): Row {
  return {
    id,
    user_id: 'user-1',
    provider_order_id: code,
    passengers: [{ givenName: 'Ana', surname, paxType: 'DRIVER' }],
    search_criteria: { vertical: 'cars', pickUpDate },
  };
}

function setup(opts: {
  rows: Record<string, Row[]>;
  statuses: Record<string, string | Error>;
  enabled?: boolean;
  casMisses?: string[];
}) {
  const selects: { tenantId: string; wheres: unknown[][]; limit?: number }[] = [];
  const updates: { tenantId: string; id: string; status: string }[] = [];
  const withTenant = vi.fn((tenantId: string, fn: (trx: unknown) => Promise<unknown>) => {
    const sel = { tenantId, wheres: [] as unknown[][], limit: undefined as number | undefined };
    const upd = { tenantId, id: '', status: '' };
    const selectChain = {
      select: () => selectChain,
      where: (...args: unknown[]) => {
        sel.wheres.push(args);
        return selectChain;
      },
      orderBy: () => selectChain,
      limit: (n: number) => {
        sel.limit = n;
        return selectChain;
      },
      execute: () => {
        selects.push(sel);
        return Promise.resolve(opts.rows[tenantId] ?? []);
      },
    };
    const updateChain = {
      set: (v: { status: string }) => {
        upd.status = v.status;
        return updateChain;
      },
      where: (col: string, _op: string, value: string) => {
        if (col === 'id') upd.id = value;
        return updateChain;
      },
      returning: () => updateChain,
      executeTakeFirst: () => {
        if (opts.casMisses?.includes(upd.id)) return Promise.resolve(undefined);
        updates.push(upd);
        return Promise.resolve({ id: upd.id });
      },
    };
    return fn({ selectFrom: () => selectChain, updateTable: () => updateChain });
  });
  const tenants = Object.keys(opts.rows).map((id) => ({ id }));
  const tenantChain = {
    select: () => tenantChain,
    orderBy: () => tenantChain,
    execute: () => Promise.resolve(tenants),
  };
  const db = { db: { selectFrom: () => tenantChain }, withTenant };
  const adapter = {
    myReservation: vi.fn((q: { confirmationCode: string; lastName: string }) => {
      const s = opts.statuses[q.confirmationCode];
      if (s instanceof Error) return Promise.reject(s);
      return Promise.resolve({ confirmationCode: q.confirmationCode, status: s ?? '' });
    }),
  };
  const factory = { forTenant: vi.fn(() => Promise.resolve(adapter)) };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const governance = { isEnabled: vi.fn(() => Promise.resolve(opts.enabled ?? true)) };
  const service = new CarsPendingSweepService(
    db as never,
    factory as never,
    audit as never,
    governance as never,
  );
  const pause = vi
    .spyOn(service as unknown as { pause: (ms: number) => Promise<void> }, 'pause')
    .mockResolvedValue(undefined);
  return { service, adapter, factory, audit, governance, selects, updates, pause };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('CarsPendingSweepService', () => {
  it('mueve las resueltas con su evento y deja las que siguen en espera', async () => {
    const s = setup({
      rows: {
        [T1]: [row('o1', 'AAA111'), row('o2', 'BBB222'), row('o3', 'CCC333'), row('o4', 'DDD444')],
      },
      statuses: { AAA111: 'Activo', BBB222: 'On Hold', CCC333: 'Cancelada', DDD444: 'Rechazada' },
    });
    const report = await s.service.sweep(NOW);
    expect(report).toMatchObject<Partial<CarPendingSweepReport>>({
      tenants: 1,
      examined: 4,
      confirmed: 1,
      cancelled: 1,
      rejected: 1,
      unchanged: 1,
      failed: 0,
    });
    expect(s.updates).toEqual([
      { tenantId: T1, id: 'o1', status: 'confirmed' },
      { tenantId: T1, id: 'o3', status: 'cancelled' },
      { tenantId: T1, id: 'o4', status: 'failed' },
    ]);
    const events = s.audit.emit.mock.calls.map(
      (c) => (c as unknown as [{ eventType: string; aggregateId: string }])[0],
    );
    expect(events.map((e) => [e.eventType, e.aggregateId])).toEqual([
      ['CarReservationConfirmed', 'o1'],
      ['CarReservationCancelled', 'o3'],
      ['CarReservationRejected', 'o4'],
    ]);
    // Lee con el apellido del conductor y el código guardados.
    expect(s.adapter.myReservation).toHaveBeenCalledWith({
      lastName: 'García',
      confirmationCode: 'AAA111',
    });
  });

  it('una lectura a la vez, con pausa entre ellas, y con la credencial de cada tenant', async () => {
    const s = setup({
      rows: { [T1]: [row('o1', 'AAA111'), row('o2', 'BBB222')], [T2]: [row('o3', 'CCC333')] },
      statuses: { AAA111: 'On Hold', BBB222: 'On Hold', CCC333: 'On Hold' },
    });
    await s.service.sweep(NOW);
    expect(s.factory.forTenant.mock.calls).toEqual([[T1], [T2]]);
    expect(s.pause).toHaveBeenCalledTimes(1);
    expect(s.pause).toHaveBeenCalledWith(CAR_PENDING_CALL_GAP_MS);
  });

  it('acota por antigüedad y por tenant, y sólo mira órdenes pending de agent-cars', async () => {
    const s = setup({ rows: { [T1]: [] }, statuses: {} });
    await s.service.sweep(NOW);
    const [sel] = s.selects;
    expect(sel?.limit).toBe(CAR_PENDING_PER_TENANT_LIMIT);
    expect(sel?.wheres).toEqual(
      expect.arrayContaining([
        ['tenant_id', '=', T1],
        ['provider', '=', 'agent-cars'],
        ['status', '=', 'pending'],
        [expect.anything(), '>=', new Date(NOW - CAR_PENDING_MAX_AGE_DAYS * 24 * 60 * 60_000)],
      ]),
    );
    // Sin nada que mirar no se resuelve credencial ni se llama al proveedor.
    expect(s.factory.forTenant).not.toHaveBeenCalled();
  });

  it('no mira una reserva cuyo retiro ya pasó hace más de unos días', async () => {
    const s = setup({
      rows: { [T1]: [row('o1', 'AAA111', '2026-11-01'), row('o2', 'BBB222', '2026-11-18')] },
      statuses: { AAA111: 'Activo', BBB222: 'Activo' },
    });
    await s.service.sweep(NOW);
    expect(s.adapter.myReservation).toHaveBeenCalledTimes(1);
    expect(s.updates.map((u) => u.id)).toEqual(['o2']);
  });

  it('con el proveedor apagado para el tenant no sale al proveedor', async () => {
    const s = setup({ rows: { [T1]: [row('o1', 'AAA111')] }, statuses: {}, enabled: false });
    await s.service.sweep(NOW);
    expect(s.adapter.myReservation).not.toHaveBeenCalled();
  });

  it('una lectura que falla o un estado raro no tocan la orden; el resto sigue', async () => {
    const s = setup({
      rows: { [T1]: [row('o1', 'AAA111'), row('o2', 'BBB222'), row('o3', 'CCC333')] },
      statuses: { AAA111: new Error('not found'), BBB222: '???', CCC333: 'Active' },
    });
    const report = await s.service.sweep(NOW);
    expect(report).toMatchObject({ examined: 3, failed: 1, unchanged: 1, confirmed: 1 });
    expect(s.updates.map((u) => u.id)).toEqual(['o3']);
  });

  it('si otro ya movió la orden (CAS), no se emite el evento', async () => {
    const s = setup({
      rows: { [T1]: [row('o1', 'AAA111')] },
      statuses: { AAA111: 'Activo' },
      casMisses: ['o1'],
    });
    const report = await s.service.sweep(NOW);
    expect(report).toMatchObject({ confirmed: 0, unchanged: 1 });
    expect(s.audit.emit).not.toHaveBeenCalled();
  });

  it('un tenant que falla no frena a los demás', async () => {
    const s = setup({
      rows: { [T1]: [row('o1', 'AAA111')], [T2]: [row('o2', 'BBB222')] },
      statuses: { AAA111: 'Activo', BBB222: 'Activo' },
    });
    s.factory.forTenant.mockImplementationOnce(() => Promise.reject(new Error('sin credencial')));
    const report = await s.service.sweep(NOW);
    expect(report).toMatchObject({ tenants: 2, tenantsFailed: 1, confirmed: 1 });
    expect(s.updates.map((u) => u.id)).toEqual(['o2']);
  });
});
