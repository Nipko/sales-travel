import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PasswordResetService } from '../auth/password-reset.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import {
  countResults,
  LEGACY_PASSWORDS_LIST_MAX,
  LEGACY_RESET_BATCH_EVENT,
  LEGACY_RESET_MAIL_CONCURRENCY,
  LegacyPasswordsService,
  legacySkipReason,
  mapWithConcurrency,
  uniqueIds,
} from './legacy-passwords.service.js';

/*
 * Forzar el cambio de contraseña a las cuentas heredadas (USR-14), con la base sustituida por lo que
 * devolvería: quién puede, cómo se decide cada cuenta, en qué orden van el cambio y el correo, qué se
 * audita y qué vuelve por cuenta. Que el criterio en SQL elige las cuentas correctas lo prueba
 * legacy-passwords.integration.test.ts contra Postgres.
 */

const ACTOR = '99999999-9999-4999-8999-999999999999';
const PLATFORM = '00000000-0000-4000-8000-000000000001';
const NORTE = '11111111-1111-4111-8111-111111111111';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DANI = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EMA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NADIE = '12121212-1212-4121-8121-121212121212';

interface Cuenta {
  email: string;
  status: string;
  has_password: boolean;
  changed: boolean;
  required: boolean;
  legacy: boolean;
}

const HEREDADA: Cuenta = {
  email: 'x@agencia.co',
  status: 'active',
  has_password: true,
  changed: false,
  required: false,
  legacy: true,
};

function candidateRow(id: string, i: number) {
  return {
    id,
    email: `persona${i}@agencia.co`,
    name: i % 2 === 0 ? `Persona ${i}` : null,
    created_at: new Date(Date.UTC(2026, 5, 1, 12, 0, i)),
    last_login_at: i % 3 === 0 ? null : new Date(Date.UTC(2026, 8, 1)),
    active_nodes: '2',
    origin_tenant_id: NORTE,
    origin_tenant_name: 'Agencia Norte',
    created_by_email: i % 2 === 0 ? 'admin@norte.co' : null,
  };
}

function banco(
  opts: {
    superadmin?: boolean;
    cuentas?: Record<string, Cuenta>;
    candidates?: unknown[];
    /** Los correos que no salen. */
    mailFails?: string[];
    /** Las cuentas cuya transacción revienta. */
    dbFails?: string[];
    /** El rastro del lote no entra. */
    batchTraceFails?: boolean;
  } = {},
) {
  const cuentas = opts.cuentas ?? {};
  const timeline: string[] = [];
  let inTrx = false;
  const contexts: unknown[] = [];

  const k = scriptedKysely((q: CompiledQuery) => {
    if (q.sql.includes('CROSS JOIN LATERAL')) return opts.candidates ?? [];
    if (q.sql.includes('FOR NO KEY UPDATE OF u')) {
      const id = q.parameters[0] as string;
      timeline.push(`lock:${id}`);
      if (opts.dbFails?.includes(id)) throw new Error('la base no respondió');
      const cuenta = cuentas[id];
      return cuenta === undefined ? [] : [cuenta];
    }
    if (q.sql.includes('from "memberships" inner join "tenants"')) {
      return [{ tenantId: NORTE, name: 'Agencia Norte', countryCode: 'CO' }];
    }
    if (q.sql.startsWith('select "id" from "tenants"')) return [{ id: PLATFORM }];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });

  const withRequestContext = vi.fn(
    async <T>(ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
      contexts.push(ctx);
      return k.db.transaction().execute(async (trx) => {
        inTrx = true;
        try {
          return await fn(trx);
        } finally {
          inTrx = false;
        }
      });
    },
  );
  const network = { isSuperadmin: vi.fn(() => Promise.resolve(opts.superadmin ?? true)) };
  const audit = {
    emit: vi.fn(() => Promise.resolve()),
    emitWithin: vi.fn((_trx: unknown, event: { eventType: string }) => {
      if (opts.batchTraceFails && event.eventType === LEGACY_RESET_BATCH_EVENT) {
        return Promise.reject(new Error('el rastro no entró'));
      }
      return Promise.resolve();
    }),
  };
  const resets = {
    requireReset: vi.fn(
      (
        _trx: unknown,
        params: { targetUserId: string; tenantId: string | null; batchId?: string },
      ) => {
        timeline.push(`force:${params.targetUserId}`);
        return Promise.resolve({
          token: `token-${params.targetUserId}`,
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedSessions: 2,
        });
      },
    ),
    resetLink: vi.fn((token: string) => `https://panel.example/restablecer?token=${token}`),
    sendResetEmail: vi.fn(
      (_tenantId: string | null, email: string, _link: string, _variant: string) => {
        // El correo nunca sale con la transacción abierta: un aviso de algo que se deshizo sería falso.
        timeline.push(`mail:${email}:${inTrx ? 'en-transaccion' : 'despues'}`);
        return Promise.resolve(!opts.mailFails?.includes(email));
      },
    ),
  };
  const service = new LegacyPasswordsService(
    { db: k.db, withRequestContext } as unknown as DatabaseService,
    network as unknown as NetworkService,
    audit as unknown as AuditService,
    resets as unknown as PasswordResetService,
  );
  return { service, k, network, audit, resets, timeline, contexts };
}

describe('el criterio, plegado', () => {
  it('por qué no se fuerza una cuenta, en orden', () => {
    expect(legacySkipReason(undefined)).toBe('not_candidate');
    expect(legacySkipReason({ ...HEREDADA, status: 'suspended', required: true })).toBe(
      'suspended',
    );
    expect(legacySkipReason({ ...HEREDADA, required: true, changed: true })).toBe(
      'already_required',
    );
    expect(legacySkipReason({ ...HEREDADA, changed: true })).toBe('password_changed');
    expect(legacySkipReason({ ...HEREDADA, legacy: false })).toBe('not_candidate');
    expect(legacySkipReason({ ...HEREDADA, has_password: false })).toBe('not_candidate');
    expect(legacySkipReason(HEREDADA)).toBeNull();
  });

  it('ids sin repetir (también en mayúsculas), en el orden en que llegaron', () => {
    expect(uniqueIds([BETO, ANA, BETO.toUpperCase(), ANA])).toEqual([BETO, ANA]);
  });

  it('los conteos del lote', () => {
    expect(
      countResults([
        { userId: ANA, status: 'sent', revokedSessions: 1 },
        { userId: BETO, status: 'email_failed', revokedSessions: 0 },
        { userId: CARLA, status: 'skipped', reason: 'self' },
        { userId: DANI, status: 'skipped', reason: 'already_required' },
        { userId: EMA, status: 'failed' },
      ]),
    ).toEqual({ sent: 1, emailFailed: 1, skipped: 2, failed: 1 });
  });

  it('mapWithConcurrency: nunca más de N a la vez y los resultados en orden', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
    await expect(mapWithConcurrency([], 3, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});

describe('list: la lista para revisar', () => {
  it('quien no es superadmin recibe 403 sin que se lea nada', async () => {
    const { service, k } = banco({ superadmin: false });
    await expect(service.list(ACTOR)).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(k.queries).toHaveLength(0);
  });

  it('el criterio en una consulta, sin quien mira y con una fila de más', async () => {
    const { service, k, contexts } = banco({ candidates: [candidateRow(ANA, 0)] });
    await service.list(ACTOR);
    const q = k.queries.find((x) => x.sql.includes('CROSS JOIN LATERAL'));
    expect(q).toBeDefined();
    for (const piece of [
      'm.invited_by IS NOT NULL',
      'm.invited_by <> u.id',
      'm.created_at = u.created_at',
      "u.status = 'active'",
      'u.password_hash IS NOT NULL',
      'u.password_changed_at IS NULL',
      'u.password_reset_required_at IS NULL',
      'ORDER BY u.created_at DESC, u.id DESC',
    ]) {
      expect(q!.sql).toContain(piece);
    }
    expect(q!.parameters).toEqual([ACTOR, LEGACY_PASSWORDS_LIST_MAX + 1]);
    // Con el contexto del superadmin: la RLS de memberships le deja leerlas todas.
    expect(contexts).toEqual([{ userId: ACTOR }]);
  });

  it('cada cuenta con su origen, sus nodos activos y las fechas en ISO', async () => {
    const { service } = banco({ candidates: [candidateRow(ANA, 0), candidateRow(BETO, 1)] });
    const out = await service.list(ACTOR);
    expect(out.truncated).toBe(false);
    expect(out.users).toEqual([
      {
        id: ANA,
        email: 'persona0@agencia.co',
        name: 'Persona 0',
        createdAt: '2026-06-01T12:00:00.000Z',
        lastLoginAt: null,
        activeNodes: 2,
        origin: { tenantId: NORTE, tenantName: 'Agencia Norte', createdByEmail: 'admin@norte.co' },
      },
      {
        id: BETO,
        email: 'persona1@agencia.co',
        name: null,
        createdAt: '2026-06-01T12:00:01.000Z',
        lastLoginAt: '2026-09-01T00:00:00.000Z',
        activeNodes: 2,
        origin: { tenantId: NORTE, tenantName: 'Agencia Norte', createdByEmail: null },
      },
    ]);
  });

  it('con una de más, corta en el tope y lo dice', async () => {
    const rows = Array.from({ length: LEGACY_PASSWORDS_LIST_MAX + 1 }, (_, i) =>
      candidateRow(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, i),
    );
    const { service } = banco({ candidates: rows });
    const out = await service.list(ACTOR);
    expect(out.users).toHaveLength(LEGACY_PASSWORDS_LIST_MAX);
    expect(out.truncated).toBe(true);

    const justo = banco({ candidates: rows.slice(0, LEGACY_PASSWORDS_LIST_MAX) });
    expect((await justo.service.list(ACTOR)).truncated).toBe(false);
  });
});

describe('requireReset: forzar el cambio a las elegidas', () => {
  it('quien no es superadmin recibe 403 sin tocar ninguna cuenta ni dejar rastro', async () => {
    const { service, k, resets, audit } = banco({ superadmin: false });
    await expect(service.requireReset(ACTOR, [ANA])).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    expect(k.queries).toHaveLength(0);
    expect(resets.requireReset).not.toHaveBeenCalled();
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('un resultado por cuenta, en el orden pedido, con el motivo de cada omisión', async () => {
    const { service, resets } = banco({
      cuentas: {
        [ANA]: { ...HEREDADA, email: 'ana@agencia.co' },
        [BETO]: { ...HEREDADA, required: true },
        [CARLA]: { ...HEREDADA, changed: true },
        [DANI]: { ...HEREDADA, status: 'suspended' },
        [EMA]: { ...HEREDADA, legacy: false },
      },
    });

    const out = await service.requireReset(ACTOR, [ANA, BETO, CARLA, DANI, EMA, NADIE, ACTOR]);

    expect(out.results).toEqual([
      { userId: ANA, status: 'sent', revokedSessions: 2 },
      { userId: BETO, status: 'skipped', reason: 'already_required' },
      { userId: CARLA, status: 'skipped', reason: 'password_changed' },
      { userId: DANI, status: 'skipped', reason: 'suspended' },
      { userId: EMA, status: 'skipped', reason: 'not_candidate' },
      { userId: NADIE, status: 'skipped', reason: 'not_candidate' },
      { userId: ACTOR, status: 'skipped', reason: 'self' },
    ]);
    expect(out.counts).toEqual({ sent: 1, emailFailed: 0, skipped: 6, failed: 0 });
    // Sólo la heredada se fuerza; a las demás no se les escribe nada.
    expect(resets.requireReset).toHaveBeenCalledTimes(1);
    expect(resets.sendResetEmail).toHaveBeenCalledTimes(1);
  });

  it('la forzada: con el lote, por su nodo; el correo "legacy" después del commit', async () => {
    const { service, resets, timeline, contexts } = banco({
      cuentas: { [ANA]: { ...HEREDADA, email: 'ana@agencia.co' } },
    });

    await service.requireReset(ACTOR, [ANA]);

    const params = resets.requireReset.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toMatchObject({ actorUserId: ACTOR, targetUserId: ANA, tenantId: NORTE });
    expect(params['batchId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(resets.sendResetEmail).toHaveBeenCalledWith(
      NORTE,
      'ana@agencia.co',
      `https://panel.example/restablecer?token=token-${ANA}`,
      'legacy',
      'Agencia Norte',
    );
    expect(timeline).toEqual([`lock:${ANA}`, `force:${ANA}`, 'mail:ana@agencia.co:despues']);
    // El nodo del correo se lee con la persona en el contexto (mail-node.ts); el cambio, con el
    // superadmin.
    expect(contexts.slice(0, 2)).toEqual([{ userId: ANA }, { userId: ACTOR }]);
  });

  it('un correo que no sale: el cambio queda, se audita el fallo y las demás siguen', async () => {
    const { service, audit } = banco({
      cuentas: {
        [ANA]: { ...HEREDADA, email: 'ana@agencia.co' },
        [BETO]: { ...HEREDADA, email: 'beto@agencia.co' },
      },
      mailFails: ['ana@agencia.co'],
    });

    const out = await service.requireReset(ACTOR, [ANA, BETO]);

    expect(out.results).toEqual([
      { userId: ANA, status: 'email_failed', revokedSessions: 2 },
      { userId: BETO, status: 'sent', revokedSessions: 2 },
    ]);
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const failed = audit.emit.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(failed[0]).toMatchObject({
      eventType: 'auth.password_reset.email_failed',
      tenantId: NORTE,
      actorUserId: ACTOR,
      aggregateType: 'user',
      aggregateId: ANA,
      payload: { targetUserId: ANA, via: 'legacy' },
    });
    // Nunca el correo en el rastro.
    expect(JSON.stringify(audit.emit.mock.calls)).not.toContain('@');
  });

  it('una cuenta cuya transacción falla queda "failed" sin frenar a las demás', async () => {
    const { service, resets } = banco({
      cuentas: {
        [ANA]: { ...HEREDADA, email: 'ana@agencia.co' },
        [BETO]: { ...HEREDADA, email: 'beto@agencia.co' },
      },
      dbFails: [ANA],
    });

    const out = await service.requireReset(ACTOR, [ANA, BETO]);

    expect(out.results).toEqual([
      { userId: ANA, status: 'failed' },
      { userId: BETO, status: 'sent', revokedSessions: 2 },
    ]);
    expect(resets.sendResetEmail).toHaveBeenCalledTimes(1);
  });

  it('un id repetido cuenta una vez', async () => {
    const { service, resets } = banco({
      cuentas: { [ANA]: { ...HEREDADA, email: 'ana@agencia.co' } },
    });
    const out = await service.requireReset(ACTOR, [ANA, ANA.toUpperCase(), ANA]);
    expect(out.results).toHaveLength(1);
    expect(resets.requireReset).toHaveBeenCalledTimes(1);
  });

  it('el rastro del lote: en la raíz platform, con lo pedido y cuántas de cada resultado', async () => {
    const { service, audit, resets } = banco({
      cuentas: {
        [ANA]: { ...HEREDADA, email: 'ana@agencia.co' },
        [BETO]: { ...HEREDADA, email: 'beto@agencia.co' },
        [CARLA]: { ...HEREDADA, required: true },
      },
      mailFails: ['beto@agencia.co'],
      dbFails: [DANI],
    });

    await service.requireReset(ACTOR, [ANA, BETO, CARLA, DANI]);

    const batch = audit.emitWithin.mock.calls.find(
      (c) => c[1].eventType === LEGACY_RESET_BATCH_EVENT,
    );
    expect(batch?.[1]).toEqual({
      eventType: 'auth.password_reset.required_bulk',
      tenantId: PLATFORM,
      actorUserId: ACTOR,
      payload: {
        batchId: (resets.requireReset.mock.calls[0]![1] as { batchId: string }).batchId,
        requested: 4,
        sent: 1,
        emailFailed: 1,
        skipped: 1,
        failed: 1,
      },
    });
    // El mismo lote en las dos cuentas forzadas.
    const lotes = resets.requireReset.mock.calls.map((c) => (c[1] as { batchId: string }).batchId);
    expect(new Set(lotes).size).toBe(1);
  });

  it('si el rastro del lote no entra, la respuesta sale igual: los cambios ya están hechos', async () => {
    const { service } = banco({
      cuentas: { [ANA]: { ...HEREDADA, email: 'ana@agencia.co' } },
      batchTraceFails: true,
    });
    await expect(service.requireReset(ACTOR, [ANA])).resolves.toMatchObject({
      counts: { sent: 1 },
    });
  });

  it(`los correos salen de a ${LEGACY_RESET_MAIL_CONCURRENCY} como mucho`, async () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    const { service, resets } = banco({
      cuentas: Object.fromEntries(
        ids.map((id, i) => [id, { ...HEREDADA, email: `p${i}@agencia.co` }]),
      ),
    });
    let running = 0;
    let peak = 0;
    resets.sendResetEmail.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      return true;
    });
    const out = await service.requireReset(ACTOR, ids);
    expect(out.counts.sent).toBe(12);
    expect(peak).toBe(LEGACY_RESET_MAIL_CONCURRENCY);
  });
});
