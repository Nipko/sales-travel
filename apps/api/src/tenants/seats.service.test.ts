import type { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { NetworkService } from '../network/network.service.js';
import { SeatsService } from './seats.service.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const SESION = '44444444-4444-4444-8444-444444444444';

/**
 * Quién llega a los puestos de un nodo, con dobles. Lo que pasa contra Postgres (qué sesiones se
 * ven y se liberan) está en seats.integration.test.ts.
 */
function banco() {
  const network = { canManageTenant: vi.fn(() => Promise.resolve(false)) };
  const db = { withRequestContext: vi.fn() };
  const service = new SeatsService(
    db as unknown as DatabaseService,
    network as unknown as NetworkService,
    { emitWithin: vi.fn() } as unknown as AuditService,
  );
  return { service, network, db };
}

async function motivo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    return `${http.getStatus()}/${http.reason ?? '?'} ${http.message}`;
  }
}

describe('SeatsService: quien no administra el nodo', () => {
  it('recibe 403 con motivo y en castellano, sin que se lea nada de la base', async () => {
    const { service, network, db } = banco();

    expect(await motivo(service.view(ACTOR, NODO))).toBe(
      '403/TENANT_NOT_MANAGED No administrás este nodo.',
    );
    expect(await motivo(service.release(ACTOR, NODO, SESION))).toBe(
      '403/TENANT_NOT_MANAGED No administrás este nodo.',
    );
    expect(network.canManageTenant).toHaveBeenCalledWith(ACTOR, NODO);
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });
});
