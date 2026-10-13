import type { HttpException } from '@nestjs/common';
import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { MemberDetailService } from './member-detail.service.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const TARGET = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const HIJO = '22222222-2222-4222-8222-222222222222';
const OTRA_RED = '33333333-3333-4333-8333-333333333333';
const SESION = '44444444-4444-4444-8444-444444444444';
const OTRA_SESION = '55555555-5555-4555-8555-555555555555';
const INVITACION = '66666666-6666-4666-8666-666666666666';

const ALTA = new Date('2026-09-01T12:00:00.000Z');
const MFA = new Date('2026-09-02T12:00:00.000Z');
const ULTIMO = new Date('2026-10-12T09:30:00.000Z');
const VENCE = new Date('2026-10-20T00:00:00.000Z');

/**
 * La ficha de un usuario con dobles: el orden de la autorización (qué se decide sin leer nada, qué
 * se lee con quién en el contexto), el rango para cerrar una sesión, el pase del superadmin y que la
 * respuesta no traiga hashes ni secretos. Que el SQL hace lo que dice, y las funciones de 0064 como
 * `app_user`, lo prueba member-detail.integration.test.ts.
 */
interface Banco {
  /** roleOver del actor sobre el nodo de la ruta y, si se pide, sobre el de la sesión. */
  routeRole?: Role | undefined;
  sessionRole?: Role | undefined;
  superadmin?: boolean;
  /** Los nodos que el actor administra (rolesOver). */
  administered?: Array<[string, Role]>;
  /** Las filas de cada consulta; las que no se definen salen de {@link filasPorDefecto}. */
  rows?: Partial<Record<Consulta, unknown[]>>;
}

type Consulta =
  | 'enSubarbol'
  | 'usuario'
  | 'seguridad'
  | 'memberships'
  | 'sesiones'
  | 'invitadoPor'
  | 'pendientes'
  | 'enviadas'
  | 'sesionARevocar'
  | 'rolDelObjetivo'
  | 'revocar';

function consulta(q: CompiledQuery): Consulta {
  const s = q.sql;
  if (s.includes('revoke_session')) return 'revocar';
  if (s.includes('SELECT s.tenant_id') && s.includes('admin_user_sessions'))
    return 'sesionARevocar';
  if (s.includes('admin_user_sessions')) return 'sesiones';
  if (s.includes('admin_user_security')) return 'seguridad';
  if (s.includes('select "m"."id" from "memberships"')) return 'enSubarbol';
  if (s.includes('"tenants" as "mt"')) return 'rolDelObjetivo';
  if (s.includes('from "memberships"')) return 'memberships';
  if (s.includes('from "users"')) return 'usuario';
  if (s.includes('"inviter"')) return 'invitadoPor';
  if (s.includes('count(*)')) return 'pendientes';
  if (s.includes('from "user_invitations"')) return 'enviadas';
  throw new Error(`consulta no prevista: ${s}`);
}

const USUARIO = {
  id: TARGET,
  email: 'ana@agencia.test',
  name: 'Ana',
  status: 'active',
  created_at: ALTA,
  email_verified_at: ALTA,
  last_login_at: ULTIMO,
  password_changed_at: null,
  password_reset_required_at: null,
};

function filasPorDefecto(): Record<Consulta, unknown[]> {
  return {
    enSubarbol: [{ id: 'm-1' }],
    usuario: [USUARIO],
    seguridad: [
      {
        mfa_enabled_at: MFA,
        recovery_codes_left: '7',
        trusted_devices_active: 2,
        password_changed_at: null,
        failed_login_attempts: 3,
        locked_until: null,
      },
    ],
    memberships: [
      {
        tenant_id: NODO,
        tenant_name: 'Agencia Norte',
        tenant_type: 'agency',
        role: 'vendedor',
        status: 'active',
        created_at: ALTA,
      },
      {
        tenant_id: OTRA_RED,
        tenant_name: 'Agencia de otra red',
        tenant_type: 'agency',
        role: 'admin',
        status: 'active',
        created_at: ALTA,
      },
    ],
    sesiones: [
      {
        id: SESION,
        tenant_id: HIJO,
        tenant_name: 'Sucursal',
        issued_at: ALTA,
        last_seen_at: ULTIMO,
        expires_at: VENCE,
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
        mfa_verified: true,
        seat_tenant_id: NODO,
      },
    ],
    invitadoPor: [{ inviter_email: 'jefa@agencia.test', accepted_at: ALTA }],
    pendientes: [{ n: '1' }],
    enviadas: [
      {
        id: INVITACION,
        email: 'beto@agencia.test',
        role: 'vendedor',
        tenant_name: 'Agencia Norte',
        expires_at: VENCE,
      },
    ],
    sesionARevocar: [{ tenant_id: HIJO }],
    rolDelObjetivo: [{ role: 'vendedor' }],
    revocar: [{ revoked: true }],
  };
}

function banco(opts: Banco = {}) {
  // `in` y no defaults de destructuring: pasar `undefined` a propósito es parte de los casos.
  const routeRole = 'routeRole' in opts ? opts.routeRole : 'tenant_admin';
  const sessionRole = 'sessionRole' in opts ? opts.sessionRole : routeRole;
  const rows = { ...filasPorDefecto(), ...opts.rows };

  const network = {
    roleOver: vi.fn((_user: string, tenantId: string) =>
      Promise.resolve(tenantId === NODO ? routeRole : sessionRole),
    ),
    rolesOver: vi.fn(() => Promise.resolve(new Map(opts.administered ?? [[NODO, 'tenant_admin']]))),
    isSuperadmin: vi.fn(() => Promise.resolve(opts.superadmin ?? false)),
  };
  const k = scriptedKysely((q) => rows[consulta(q)]);
  /** El contexto de cada transacción, en orden, y la transacción que recibió `fn`. */
  const contexts: Array<{ userId?: string; tenantId?: string }> = [];
  const trxs: Array<Transaction<DB>> = [];
  const db = {
    withRequestContext: vi.fn(
      <T>(ctx: { userId?: string }, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
        contexts.push(ctx);
        return k.db.transaction().execute((trx) => {
          trxs.push(trx);
          return fn(trx);
        });
      },
    ),
  };
  const audit = { emitWithin: vi.fn(() => Promise.resolve()) };
  const service = new MemberDetailService(
    db as unknown as DatabaseService,
    network as unknown as NetworkService,
    audit as unknown as AuditService,
  );
  const ran = (c: Consulta) => k.queries.filter((q) => consulta(q) === c);
  return { service, network, db, audit, k, contexts, trxs, ran };
}

async function motivo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    if (typeof http.getStatus !== 'function') throw err;
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
}

describe('MemberDetailService.detail: el orden de la autorización', () => {
  it('quien no administra el nodo recibe 403 sin que se lea nada del usuario', async () => {
    const { service, db, network } = banco({ routeRole: undefined });

    expect(await motivo(service.detail(ACTOR, NODO, TARGET))).toBe('403/TENANT_NOT_MANAGED');
    expect(network.roleOver).toHaveBeenCalledWith(ACTOR, NODO);
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('un usuario sin membership en el subárbol es 404, leído con la RLS del actor', async () => {
    const { service, contexts, k, ran } = banco({ rows: { enSubarbol: [] } });

    expect(await motivo(service.detail(ACTOR, NODO, TARGET))).toBe('404/MEMBER_NOT_FOUND');
    expect(contexts).toEqual([{ userId: ACTOR }]);
    const [check] = ran('enSubarbol');
    expect(check?.sql).toContain('OPERATOR(public.<@)');
    expect(check?.parameters).toEqual([TARGET, NODO, 1]);
    // Nada más: ni la cuenta, ni su seguridad, ni sus sesiones.
    expect(k.queries).toHaveLength(1);
  });

  it('arma la ficha acotada al subárbol del nodo de la ruta', async () => {
    const { service, ran } = banco();

    const detail = await service.detail(ACTOR, NODO, TARGET);

    expect(detail.user).toEqual({
      id: TARGET,
      email: 'ana@agencia.test',
      name: 'Ana',
      status: 'active',
      createdAt: ALTA.toISOString(),
      emailVerified: true,
      lastLoginAt: ULTIMO.toISOString(),
      passwordChangedAt: null,
      passwordResetRequired: false,
    });
    expect(detail.security).toEqual({
      mfaEnabled: true,
      mfaEnabledAt: MFA.toISOString(),
      recoveryCodesLeft: 7,
      trustedDevices: 2,
      lockedUntil: null,
      failedLoginAttempts: 3,
    });
    expect(detail.sessions).toEqual([
      {
        id: SESION,
        tenantId: HIJO,
        tenantName: 'Sucursal',
        issuedAt: ALTA.toISOString(),
        lastSeenAt: ULTIMO.toISOString(),
        expiresAt: VENCE.toISOString(),
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        mfaVerified: true,
        seatTenantId: NODO,
        current: false,
      },
    ]);
    expect(detail.invitedBy).toEqual({ email: 'jefa@agencia.test', at: ALTA.toISOString() });
    expect(detail.invitationsSent).toEqual({
      pending: 1,
      items: [
        {
          id: INVITACION,
          email: 'beto@agencia.test',
          role: 'vendedor',
          tenantName: 'Agencia Norte',
          expiresAt: VENCE.toISOString(),
        },
      ],
    });

    // Sesiones e invitaciones, del subárbol del nodo de la ruta.
    expect(ran('sesiones')[0]?.parameters).toEqual([TARGET, NODO]);
    expect(ran('seguridad')[0]?.parameters).toEqual([TARGET]);
    for (const c of ['invitadoPor', 'pendientes', 'enviadas'] as const) {
      expect(ran(c)[0]?.sql).toContain('OPERATOR(public.<@)');
      expect(ran(c)[0]?.parameters).toContain(NODO);
    }
    expect(ran('invitadoPor')[0]?.parameters).toContain('ana@agencia.test');
    expect(ran('enviadas')[0]?.parameters).toContain(20);
  });

  it('de los nodos sólo deja los que el actor administra (rolesOver)', async () => {
    const { service, network } = banco();

    const detail = await service.detail(ACTOR, NODO, TARGET);

    expect(network.rolesOver).toHaveBeenCalledWith(ACTOR, [NODO, OTRA_RED]);
    expect(detail.memberships).toEqual([
      {
        tenantId: NODO,
        tenantName: 'Agencia Norte',
        tenantType: 'agency',
        role: 'vendedor',
        status: 'active',
        createdAt: ALTA.toISOString(),
      },
    ]);
  });

  it('el superadmin ve todos sus nodos sin pasar por rolesOver', async () => {
    const { service, network } = banco({ routeRole: 'superadmin' });

    const detail = await service.detail(ACTOR, NODO, TARGET);

    expect(network.rolesOver).not.toHaveBeenCalled();
    expect(detail.memberships.map((m) => m.tenantId)).toEqual([NODO, OTRA_RED]);
  });

  it('uno mismo puede verse, y la sesión desde la que mira va marcada', async () => {
    const { service } = banco();

    const detail = await requestContextStorage.run({ sessionId: SESION }, () =>
      service.detail(TARGET, NODO, TARGET),
    );

    expect(detail.sessions.map((s) => s.current)).toEqual([true]);
  });

  it('la sesión de quien mira a OTRO nunca va marcada', async () => {
    const { service } = banco();

    const detail = await requestContextStorage.run({ sessionId: SESION }, () =>
      service.detail(ACTOR, NODO, TARGET),
    );

    expect(detail.sessions.map((s) => s.current)).toEqual([false]);
  });

  it('sin quien lo invitó ni invitaciones, null y cero', async () => {
    const { service } = banco({ rows: { invitadoPor: [], pendientes: [], enviadas: [] } });

    const detail = await service.detail(ACTOR, NODO, TARGET);

    expect(detail.invitedBy).toBeNull();
    expect(detail.invitationsSent).toEqual({ pending: 0, items: [] });
  });

  it('si la cuenta desaparece en el medio, 404', async () => {
    const { service } = banco({ rows: { usuario: [] } });

    expect(await motivo(service.detail(ACTOR, NODO, TARGET))).toBe('404/MEMBER_NOT_FOUND');
  });

  it('si la función de seguridad calla a quien la API autorizó, falla en vez de inventar ceros', async () => {
    const { service } = banco({ rows: { seguridad: [] } });

    await expect(service.detail(ACTOR, NODO, TARGET)).rejects.toThrow(/admin_user_security/);
  });

  it('la respuesta no trae hashes, secretos ni contraseñas aunque la base los devolviera', async () => {
    const { service } = banco({
      rows: {
        usuario: [
          {
            ...USUARIO,
            password_hash: 'hash-secreto',
            mfa_secret: 'secreto-mfa',
          },
        ],
      },
    });

    const json = JSON.stringify(await service.detail(ACTOR, NODO, TARGET));

    expect(json).not.toMatch(/hash-secreto|secreto-mfa|token_hash|code_hash|password_hash/);
  });
});

describe('MemberDetailService.platformDetail', () => {
  it('a quien no es superadmin, 403 sin leer nada de la cuenta', async () => {
    const { service, db } = banco({ superadmin: false });

    expect(await motivo(service.platformDetail(ACTOR, TARGET))).toBe('403/SUPERADMIN_ONLY');
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('una cuenta que no existe es 404', async () => {
    const { service } = banco({ superadmin: true, rows: { usuario: [] } });

    expect(await motivo(service.platformDetail(ACTOR, TARGET))).toBe('404/USER_NOT_FOUND');
  });

  it('el superadmin ve todo: sesiones sin raíz y nada acotado a un subárbol', async () => {
    const { service, ran, network, contexts } = banco({ superadmin: true });

    const detail = await service.platformDetail(ACTOR, TARGET);

    expect(contexts).toEqual([{ userId: ACTOR }]);
    expect(ran('sesiones')[0]?.parameters).toEqual([TARGET, null]);
    for (const c of ['invitadoPor', 'pendientes', 'enviadas'] as const) {
      expect(ran(c)[0]?.sql).not.toContain('OPERATOR(public.<@)');
    }
    expect(ran('enSubarbol')).toHaveLength(0);
    expect(network.rolesOver).not.toHaveBeenCalled();
    expect(detail.memberships).toHaveLength(2);
  });
});

describe('MemberDetailService.revokeSession', () => {
  it('sobre uno mismo es 403 sin consultar nada, y dice dónde cerrar las propias', async () => {
    const { service, network, db } = banco();

    const err = await service.revokeSession(ACTOR, NODO, ACTOR, SESION).catch((e: unknown) => e);

    expect(err).toMatchObject({ reason: 'MEMBER_SELF_ACTION' });
    expect((err as Error).message).toMatch(/Mi cuenta → Seguridad/);
    expect(network.roleOver).not.toHaveBeenCalled();
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('quien no administra el nodo recibe 403 antes de buscar la sesión', async () => {
    const { service, db } = banco({ routeRole: undefined });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe(
      '403/TENANT_NOT_MANAGED',
    );
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('una sesión que no está abierta en el subárbol (o es de otro) es 404 y no se revoca nada', async () => {
    const { service, ran, audit } = banco({ rows: { sesionARevocar: [] } });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, OTRA_SESION))).toBe(
      '404/SESSION_NOT_FOUND',
    );
    expect(ran('sesionARevocar')[0]?.parameters).toEqual([TARGET, NODO, OTRA_SESION]);
    expect(ran('revocar')).toHaveLength(0);
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('el rango se mide sobre el nodo de la sesión, con el rol del objetivo leído en SU contexto', async () => {
    const { service, network, contexts, ran } = banco();

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe('ok');
    expect(network.roleOver).toHaveBeenNthCalledWith(2, ACTOR, HIJO);
    expect(contexts[1]).toEqual({ userId: TARGET });
    const [rol] = ran('rolDelObjetivo');
    // Su membership en el nodo de la sesión o en un ancestro, o un rol de plataforma.
    expect(rol?.sql).toContain('OPERATOR(public.@>)');
    expect(rol?.parameters).toEqual([TARGET, 'superadmin', 'platform_admin', HIJO]);
  });

  it.each<[Role, Role]>([
    ['tenant_admin', 'tenant_admin'],
    ['tenant_admin', 'consolidator_admin'],
    ['admin', 'agency_admin'],
    ['consolidator_admin', 'superadmin'],
  ])('un %s no cierra la sesión de un %s: 403 y no se revoca', async (actorRole, targetRole) => {
    const { service, ran, audit } = banco({
      routeRole: actorRole,
      rows: { rolDelObjetivo: [{ role: 'vendedor' }, { role: targetRole }] },
    });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe(
      '403/ROLE_NOT_GRANTABLE',
    );
    expect(ran('revocar')).toHaveLength(0);
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('si el actor no administra el nodo de la sesión, 403', async () => {
    const { service, ran } = banco({ sessionRole: undefined });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe(
      '403/ROLE_NOT_GRANTABLE',
    );
    expect(ran('revocar')).toHaveLength(0);
  });

  it('sin rol del objetivo sobre ese nodo no hay a quién superar: se cierra', async () => {
    const { service, ran } = banco({ rows: { rolDelObjetivo: [] } });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe('ok');
    expect(ran('revocar')).toHaveLength(1);
  });

  it('revoca con motivo revoked_by_admin y audita en la MISMA transacción', async () => {
    const { service, ran, audit, trxs, contexts } = banco();

    expect(await service.revokeSession(ACTOR, NODO, TARGET, SESION)).toEqual({ ok: true });

    expect(ran('revocar')[0]?.parameters).toEqual([SESION, 'revoked_by_admin']);
    expect(contexts.at(-1)).toEqual({ userId: ACTOR });
    expect(audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(audit.emitWithin).toHaveBeenCalledWith(trxs.at(-1), {
      eventType: 'auth.session.revoked_by_admin',
      tenantId: HIJO,
      actorUserId: ACTOR,
      aggregateType: 'session',
      aggregateId: SESION,
      payload: { targetUserId: TARGET, sessionId: SESION, viaTenantId: NODO },
    });
  });

  it('el superadmin no pasa por el rango', async () => {
    const { service, network, contexts, ran } = banco({
      routeRole: 'superadmin',
      rows: { rolDelObjetivo: [{ role: 'consolidator_admin' }] },
    });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe('ok');
    expect(network.roleOver).toHaveBeenCalledTimes(1);
    expect(ran('rolDelObjetivo')).toHaveLength(0);
    expect(contexts.some((c) => c.userId === TARGET)).toBe(false);
    expect(ran('revocar')).toHaveLength(1);
  });

  it('si se cerró entre la lectura y la revocación, 404 y sin evento', async () => {
    const { service, audit } = banco({ rows: { revocar: [{ revoked: false }] } });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe(
      '404/SESSION_NOT_FOUND',
    );
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('una sesión sin nodo no se toca desde un nodo', async () => {
    const { service, ran } = banco({ rows: { sesionARevocar: [{ tenant_id: null }] } });

    expect(await motivo(service.revokeSession(ACTOR, NODO, TARGET, SESION))).toBe(
      '404/SESSION_NOT_FOUND',
    );
    expect(ran('revocar')).toHaveLength(0);
  });
});
