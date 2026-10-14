import { UnauthorizedException } from '@nestjs/common';
import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { ProfileService } from './profile.service.js';

/*
 * Qué consulta el cambio de nombre y en qué orden, sin Postgres: que la base lo respalda (el
 * trigger de 0069, la transacción con el evento) lo prueba `profile.integration.test.ts`.
 */

const USER = '6f1c2a0e-4b3d-4e5f-8a9b-0c1d2e3f4a5b';

function banco(current: { name: string | null } | null) {
  const k = scriptedKysely((q: CompiledQuery) => {
    if (q.sql.startsWith('select "name" from "users"')) return current ? [current] : [];
    if (q.sql.startsWith('update "users"')) return [];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const audit = { emitWithin: vi.fn(() => Promise.resolve()) };
  const withRequestContext = vi.fn(
    <T>(_ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
      k.db.transaction().execute(fn),
  );
  const service = new ProfileService(
    { db: k.db, withRequestContext } as unknown as DatabaseService,
    audit as unknown as AuditService,
  );
  return { service, k, audit, withRequestContext };
}

describe('ProfileService.updateName', () => {
  it('corre con la cuenta de la sesión en el contexto (lo exige el trigger de 0069)', async () => {
    const { service, withRequestContext } = banco({ name: 'Laura' });
    await service.updateName(USER, 'Laura Gómez');
    expect(withRequestContext).toHaveBeenCalledWith({ userId: USER }, expect.any(Function));
  });

  it('toma la fila, la cambia por id y deja el evento con el antes y el después', async () => {
    const { service, k, audit } = banco({ name: 'Laura' });
    await expect(service.updateName(USER, 'Laura Gómez')).resolves.toEqual({
      name: 'Laura Gómez',
    });

    const select = k.queries[k.indexOf('select "name" from "users"')];
    expect(select?.sql).toMatch(/where "id" = \$1 for update$/);
    expect(select?.parameters).toEqual([USER]);

    const update = k.queries[k.indexOf('update "users"')];
    expect(update?.sql).toBe('update "users" set "name" = $1 where "id" = $2');
    expect(update?.parameters).toEqual(['Laura Gómez', USER]);

    expect(audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(audit.emitWithin).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'UserProfileUpdated',
      actorUserId: USER,
      aggregateType: 'user',
      aggregateId: USER,
      payload: {
        changed: ['name'],
        before: { name: 'Laura' },
        after: { name: 'Laura Gómez' },
      },
    });
  });

  it('una cuenta sin nombre (null) también queda en el historial con el antes vacío', async () => {
    const { service, audit } = banco({ name: null });
    await service.updateName(USER, 'Laura');
    expect(audit.emitWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: { changed: ['name'], before: { name: null }, after: { name: 'Laura' } },
      }),
    );
  });

  it('con el mismo nombre no escribe ni deja evento', async () => {
    const { service, k, audit } = banco({ name: 'Laura Gómez' });
    await expect(service.updateName(USER, 'Laura Gómez')).resolves.toEqual({
      name: 'Laura Gómez',
    });
    expect(k.indexOf('update "users"')).toBe(-1);
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('si la cuenta ya no existe: 401, sin escribir', async () => {
    const { service, k, audit } = banco(null);
    await expect(service.updateName(USER, 'Laura')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(k.indexOf('update "users"')).toBe(-1);
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('si el evento no entra, el error sale y el cambio no se confirma', async () => {
    const { service, audit } = banco({ name: 'Laura' });
    audit.emitWithin.mockRejectedValueOnce(new Error('domain_events no disponible'));
    await expect(service.updateName(USER, 'Laura Gómez')).rejects.toThrow(
      'domain_events no disponible',
    );
  });
});
