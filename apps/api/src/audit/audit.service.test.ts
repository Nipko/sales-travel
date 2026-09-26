import { Logger } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { AuditService } from './audit.service.js';

/**
 * `emit` es best-effort y `emitWithin` no: el segundo existe para las lecturas que sólo pueden
 * devolver datos si su rastro quedó escrito (la bóveda de payloads, docs/tbo/09 PR-4.9).
 */

function insertador(fallo?: Error) {
  const execute = vi.fn(() => (fallo === undefined ? Promise.resolve([]) : Promise.reject(fallo)));
  const values = vi.fn(() => ({ execute }));
  const insertInto = vi.fn(() => ({ values }));
  return { insertInto, values, execute };
}

const EVENTO = {
  eventType: 'ProviderPayloadsExported',
  tenantId: '33333333-3333-4333-8333-333333333333',
  aggregateType: 'provider_payload',
  aggregateId: 'req-1',
  payload: { records: 1 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditService', () => {
  it('emitWithin escribe en la transacción de quien llama, con actor y request del contexto', async () => {
    const trx = insertador();
    const base = insertador();
    const audit = new AuditService({ db: base } as unknown as DatabaseService);

    await requestContextStorage.run(
      { userId: 'u-1', requestId: 'http-1', ip: '10.0.0.1', userAgent: 'vitest', sessionId: 's-1' },
      () => audit.emitWithin(trx as unknown as Transaction<DB>, EVENTO),
    );

    expect(base.insertInto).not.toHaveBeenCalled();
    expect(trx.insertInto).toHaveBeenCalledWith('domain_events');
    expect(trx.values).toHaveBeenCalledWith({
      tenant_id: EVENTO.tenantId,
      actor_user_id: 'u-1',
      event_type: 'ProviderPayloadsExported',
      aggregate_type: 'provider_payload',
      aggregate_id: 'req-1',
      payload: JSON.stringify({ records: 1 }),
      meta: JSON.stringify({
        requestId: 'http-1',
        ip: '10.0.0.1',
        userAgent: 'vitest',
        sessionId: 's-1',
      }),
    });
  });

  it('emitWithin NO se traga el fallo: la transacción de quien llama se deshace con él', async () => {
    const trx = insertador(new Error('domain_events no disponible'));
    const audit = new AuditService({ db: insertador() } as unknown as DatabaseService);

    await expect(audit.emitWithin(trx as unknown as Transaction<DB>, EVENTO)).rejects.toThrow(
      'domain_events no disponible',
    );
  });

  it('emit sigue siendo best-effort: un fallo se avisa y no llega a quien llama', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const audit = new AuditService({
      db: insertador(new Error('sin base')),
    } as unknown as DatabaseService);

    await expect(audit.emit(EVENTO)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('no se pudo registrar ProviderPayloadsExported: sin base');
  });
});
