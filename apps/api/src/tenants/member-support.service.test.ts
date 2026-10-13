import type { HttpException } from '@nestjs/common';
import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PasswordResetService } from '../auth/password-reset.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB, MembershipStatus, Role } from '../database/database.types.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import type { NetworkService } from '../network/network.service.js';
import { MemberSupportService } from './member-support.service.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const TARGET = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const OTRA_RED = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'token-en-claro-que-nunca-sale';
const EXPIRES = new Date('2026-10-11T13:00:00.000Z');

/**
 * El orden de la autorización con dobles: qué se decide sin leer nada, qué se lee con quién en el
 * contexto y que la acción no corre si la regla dice que no. La regla en sí está en
 * tenant-admin.policy.test.ts; contra Postgres, en seats.integration.test.ts y
 * member-support.integration.test.ts.
 */
interface Banco {
  routeRole?: Role | undefined;
  inRoute?: { tenant_id: string; role: Role; status?: MembershipStatus } | undefined;
  active?: Array<{ tenant_id: string; role: Role }>;
  actorRoles?: Array<[string, Role]>;
  /**
   * Las filas de cada consulta de la acción (la 3ª transacción). Sin esto, la acción devuelve 0 sin
   * consultar nada: alcanza para los casos que sólo miran la autorización.
   */
  respond?: (q: CompiledQuery) => unknown[];
  mailOk?: boolean;
}

function banco(opts: Banco = {}) {
  // `in` y no defaults de destructuring: pasar `undefined` a propósito es parte de los casos.
  const routeRole = 'routeRole' in opts ? opts.routeRole : 'tenant_admin';
  const inRoute =
    'inRoute' in opts ? opts.inRoute : { tenant_id: NODO, role: 'vendedor', status: 'active' };
  const active = opts.active ?? [{ tenant_id: NODO, role: 'vendedor' }];
  const actorRoles = opts.actorRoles ?? [[NODO, 'tenant_admin']];
  const network = {
    roleOver: vi.fn(() => Promise.resolve(routeRole)),
    rolesOver: vi.fn(() => Promise.resolve(new Map(actorRoles))),
  };
  const respond = opts.respond;
  const k = scriptedKysely(
    respond ??
      ((q) => {
        throw new Error(`consulta no prevista: ${q.sql}`);
      }),
  );
  // 1ª lectura: la membership en el nodo de la ruta; 2ª: las activas del objetivo; 3ª: la acción.
  const action = vi.fn(<T>(_ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>) =>
    respond ? k.db.transaction().execute(fn) : Promise.resolve(0),
  );
  const db = {
    withRequestContext: vi
      .fn()
      .mockResolvedValueOnce(inRoute)
      .mockResolvedValueOnce(active)
      .mockImplementationOnce(action),
  };
  const audit = {
    emitWithin: vi.fn(() => Promise.resolve()),
    emit: vi.fn(() => Promise.resolve()),
  };
  const resets = {
    issueToken: vi.fn(() => Promise.resolve({ token: TOKEN, expiresAt: EXPIRES })),
    requireReset: vi.fn(() =>
      Promise.resolve({ token: TOKEN, expiresAt: EXPIRES, revokedSessions: 2 }),
    ),
    resetLink: vi.fn((token: string) => `https://panel.example/restablecer?token=${token}`),
    sendResetEmail: vi.fn(() => Promise.resolve(opts.mailOk ?? true)),
  };
  const notices = { notify: vi.fn() };
  const service = new MemberSupportService(
    db as unknown as DatabaseService,
    network as unknown as NetworkService,
    audit as unknown as AuditService,
    resets as unknown as PasswordResetService,
    notices as unknown as SecurityNoticeService,
  );
  return { service, network, db, audit, resets, notices, k };
}

async function motivo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
}

describe('MemberSupportService: el orden de la autorización', () => {
  it('sobre uno mismo es 403 sin consultar nada', async () => {
    const { service, network, db } = banco();

    expect(await motivo(service.resetMfa(ACTOR, NODO, ACTOR))).toBe('403/MEMBER_SELF_ACTION');
    expect(await motivo(service.revokeSessions(ACTOR, NODO, ACTOR))).toBe('403/MEMBER_SELF_ACTION');
    expect(network.roleOver).not.toHaveBeenCalled();
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('quien no administra el nodo de la ruta recibe 403 antes de saber si el usuario es miembro', async () => {
    const { service, db } = banco({ routeRole: undefined });

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('403/TENANT_NOT_MANAGED');
    expect(await motivo(service.revokeSessions(ACTOR, NODO, TARGET))).toBe(
      '403/TENANT_NOT_MANAGED',
    );
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('un usuario que no es miembro del nodo es 404', async () => {
    const { service, db } = banco({ inRoute: undefined });

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('404/MEMBER_NOT_FOUND');
    expect(db.withRequestContext).toHaveBeenCalledTimes(1);
    expect(db.withRequestContext).toHaveBeenCalledWith(
      { userId: ACTOR, tenantId: NODO },
      expect.any(Function),
    );
  });

  it('las memberships activas se leen con el OBJETIVO en el contexto (todas sus redes)', async () => {
    const { service, db, network } = banco();

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('ok');
    expect(db.withRequestContext).toHaveBeenNthCalledWith(
      2,
      { userId: TARGET },
      expect.any(Function),
    );
    expect(network.rolesOver).toHaveBeenCalledWith(ACTOR, [NODO]);
    // La acción corre con el actor en el contexto.
    expect(db.withRequestContext).toHaveBeenNthCalledWith(
      3,
      { userId: ACTOR },
      expect.any(Function),
    );
  });

  it('si también trabaja en otra red: 403 y la acción no corre', async () => {
    const { service, db, network } = banco({
      active: [
        { tenant_id: NODO, role: 'vendedor' },
        { tenant_id: OTRA_RED, role: 'vendedor' },
      ],
    });

    expect(await motivo(service.revokeSessions(ACTOR, NODO, TARGET))).toBe(
      '403/MEMBER_OUTSIDE_NETWORK',
    );
    expect(network.rolesOver).toHaveBeenCalledWith(ACTOR, [NODO, OTRA_RED]);
    expect(db.withRequestContext).toHaveBeenCalledTimes(2);
  });

  it('la membership del nodo de la ruta cuenta aunque esté suspendida', async () => {
    const { service, db } = banco({
      inRoute: { tenant_id: NODO, role: 'tenant_admin' },
      active: [],
    });

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('403/ROLE_NOT_GRANTABLE');
    expect(db.withRequestContext).toHaveBeenCalledTimes(2);
  });

  it('el superadmin pasa aunque el usuario esté en otra red', async () => {
    const { service, db } = banco({
      routeRole: 'superadmin',
      active: [
        { tenant_id: NODO, role: 'vendedor' },
        { tenant_id: OTRA_RED, role: 'consolidator_admin' },
      ],
      actorRoles: [],
    });

    expect(await motivo(service.revokeSessions(ACTOR, NODO, TARGET))).toBe('ok');
    expect(db.withRequestContext).toHaveBeenCalledTimes(3);
  });
});

interface Objetivo {
  email: string;
  status: string;
  password_reset_required_at: Date | null;
}

const BETO: Objetivo = {
  email: 'beto@agencia.co',
  status: 'active',
  password_reset_required_at: null,
};

/** Lo que contesta la base dentro de la transacción de "Enviar enlace" y de "Forzar cambio". */
function envio(opts: { user?: Objetivo | undefined; recent?: number } = {}) {
  const user = 'user' in opts ? opts.user : BETO;
  const recent = opts.recent ?? 0;
  return (q: CompiledQuery): unknown[] => {
    if (q.sql.startsWith('select "email", "status", "password_reset_required_at" from "users"')) {
      return user ? [user] : [];
    }
    if (q.sql.includes('from "password_reset_tokens"')) return [{ n: String(recent) }];
    if (q.sql.includes('from "tenants"')) return [{ name: 'Agencia Norte' }];
    throw new Error(`consulta no prevista: ${q.sql}`);
  };
}

describe('MemberSupportService.sendPasswordReset', () => {
  it('reusa la autorización: uno mismo, fuera de la red y de rango igual o superior son 403', async () => {
    const self = banco({ respond: envio() });
    expect(await motivo(self.service.sendPasswordReset(ACTOR, NODO, ACTOR))).toBe(
      '403/MEMBER_SELF_ACTION',
    );
    expect(self.db.withRequestContext).not.toHaveBeenCalled();

    const outside = banco({
      respond: envio(),
      active: [
        { tenant_id: NODO, role: 'vendedor' },
        { tenant_id: OTRA_RED, role: 'vendedor' },
      ],
    });
    expect(await motivo(outside.service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe(
      '403/MEMBER_OUTSIDE_NETWORK',
    );

    const outranked = banco({
      respond: envio(),
      inRoute: { tenant_id: NODO, role: 'tenant_admin', status: 'active' },
      active: [{ tenant_id: NODO, role: 'tenant_admin' }],
    });
    expect(await motivo(outranked.service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe(
      '403/ROLE_NOT_GRANTABLE',
    );

    for (const b of [self, outside, outranked]) {
      expect(b.resets.issueToken).not.toHaveBeenCalled();
      expect(b.resets.sendResetEmail).not.toHaveBeenCalled();
      expect(b.audit.emitWithin).not.toHaveBeenCalled();
    }
  });

  it('con su acceso al nodo suspendido es 409 y no emite nada', async () => {
    const { service, db, resets } = banco({
      respond: envio(),
      inRoute: { tenant_id: NODO, role: 'vendedor', status: 'suspended' },
    });

    expect(await motivo(service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe(
      '409/MEMBERSHIP_SUSPENDED',
    );
    expect(db.withRequestContext).toHaveBeenCalledTimes(2);
    expect(resets.issueToken).not.toHaveBeenCalled();
  });

  it('con la cuenta suspendida en la plataforma es 409 y no emite nada', async () => {
    const { service, resets, audit } = banco({
      respond: envio({ user: { ...BETO, status: 'suspended' } }),
    });

    expect(await motivo(service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe(
      '409/MEMBER_ACCOUNT_SUSPENDED',
    );
    expect(resets.issueToken).not.toHaveBeenCalled();
    expect(resets.sendResetEmail).not.toHaveBeenCalled();
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });

  it('con 3 enlaces en los últimos 15 minutos es 429; con 2, sale el tercero', async () => {
    const limited = banco({ respond: envio({ recent: 3 }) });
    expect(await motivo(limited.service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe(
      '429/PASSWORD_RESET_RATE_LIMITED',
    );
    expect(limited.resets.issueToken).not.toHaveBeenCalled();
    const count = limited.k.queries.find((q) => q.sql.includes('from "password_reset_tokens"'));
    expect(count?.sql).toContain('"user_id" = $1');
    expect(count?.sql).toContain('created_at > now() - make_interval(mins => $2)');
    expect(count?.parameters).toEqual([TARGET, 15]);

    const third = banco({ respond: envio({ recent: 2 }) });
    expect(await motivo(third.service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe('ok');
  });

  it('emite el enlace invalidando los anteriores, lo audita en la transacción y envía después', async () => {
    const { service, db, resets, audit, k } = banco({ respond: envio() });

    const res = await service.sendPasswordReset(ACTOR, NODO, TARGET);

    expect(res).toEqual({ sent: true, expiresAt: EXPIRES.toISOString() });
    // Ni el token ni el enlace llegan al admin.
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(JSON.stringify(res)).not.toContain('restablecer');

    expect(db.withRequestContext).toHaveBeenNthCalledWith(
      3,
      { userId: ACTOR },
      expect.any(Function),
    );
    // La fila del usuario queda tomada: dos envíos en paralelo se ordenan para el límite.
    expect(k.queries[0]?.sql).toMatch(/from "users" where "id" = \$1 for no key update$/);
    expect(resets.issueToken).toHaveBeenCalledWith(expect.anything(), TARGET, {
      invalidatePrevious: true,
    });
    expect(audit.emitWithin).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'auth.password_reset.sent_by_admin',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'user',
      aggregateId: TARGET,
      payload: { targetUserId: TARGET, expiresAt: EXPIRES.toISOString() },
    });
    // El evento no lleva el token.
    expect(JSON.stringify(audit.emitWithin.mock.calls)).not.toContain(TOKEN);

    expect(resets.sendResetEmail).toHaveBeenCalledWith(
      NODO,
      'beto@agencia.co',
      `https://panel.example/restablecer?token=${TOKEN}`,
      'admin',
      'Agencia Norte',
    );
    // El correo sale con la transacción ya cerrada (el enlace y su rastro existen).
    const auditOrder = audit.emitWithin.mock.invocationCallOrder[0]!;
    const sendOrder = resets.sendResetEmail.mock.invocationCallOrder[0]!;
    expect(sendOrder).toBeGreaterThan(auditOrder);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('si el correo no sale: sent:false y el fallo queda auditado', async () => {
    const { service, audit } = banco({ respond: envio(), mailOk: false });

    expect(await service.sendPasswordReset(ACTOR, NODO, TARGET)).toEqual({
      sent: false,
      expiresAt: EXPIRES.toISOString(),
    });
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: 'auth.password_reset.email_failed',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'user',
      aggregateId: TARGET,
      payload: { targetUserId: TARGET, via: 'admin' },
    });
  });

  it('si el usuario desapareció entre la autorización y la acción, 404', async () => {
    const { service, resets } = banco({ respond: envio({ user: undefined }) });
    expect(await motivo(service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe(
      '404/MEMBER_NOT_FOUND',
    );
    expect(resets.issueToken).not.toHaveBeenCalled();
  });
});

describe('MemberSupportService.sendPasswordReset con el cambio forzado pendiente', () => {
  it('el correo es el de "elegir una contraseña nueva": no dice que la actual sigue funcionando', async () => {
    const { service, resets } = banco({
      respond: envio({ user: { ...BETO, password_reset_required_at: new Date() } }),
    });

    expect(await motivo(service.sendPasswordReset(ACTOR, NODO, TARGET))).toBe('ok');
    expect(resets.sendResetEmail).toHaveBeenCalledWith(
      NODO,
      'beto@agencia.co',
      expect.any(String),
      'required',
      'Agencia Norte',
    );
  });
});

describe('MemberSupportService.requirePasswordReset', () => {
  it('reusa la autorización: uno mismo, fuera de la red y de rango igual o superior son 403', async () => {
    const self = banco({ respond: envio() });
    expect(await motivo(self.service.requirePasswordReset(ACTOR, NODO, ACTOR))).toBe(
      '403/MEMBER_SELF_ACTION',
    );
    expect(self.db.withRequestContext).not.toHaveBeenCalled();

    const outside = banco({
      respond: envio(),
      active: [
        { tenant_id: NODO, role: 'vendedor' },
        { tenant_id: OTRA_RED, role: 'vendedor' },
      ],
    });
    expect(await motivo(outside.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe(
      '403/MEMBER_OUTSIDE_NETWORK',
    );

    const outranked = banco({
      respond: envio(),
      inRoute: { tenant_id: NODO, role: 'tenant_admin', status: 'active' },
      active: [{ tenant_id: NODO, role: 'tenant_admin' }],
    });
    expect(await motivo(outranked.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe(
      '403/ROLE_NOT_GRANTABLE',
    );

    for (const b of [self, outside, outranked]) {
      expect(b.resets.requireReset).not.toHaveBeenCalled();
      expect(b.resets.sendResetEmail).not.toHaveBeenCalled();
    }
  });

  it('los mismos 409: su acceso al nodo o su cuenta suspendidos, sin marcar nada', async () => {
    const membership = banco({
      respond: envio(),
      inRoute: { tenant_id: NODO, role: 'vendedor', status: 'suspended' },
    });
    expect(await motivo(membership.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe(
      '409/MEMBERSHIP_SUSPENDED',
    );
    expect(membership.db.withRequestContext).toHaveBeenCalledTimes(2);

    const account = banco({ respond: envio({ user: { ...BETO, status: 'suspended' } }) });
    expect(await motivo(account.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe(
      '409/MEMBER_ACCOUNT_SUSPENDED',
    );

    const gone = banco({ respond: envio({ user: undefined }) });
    expect(await motivo(gone.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe(
      '404/MEMBER_NOT_FOUND',
    );

    for (const b of [membership, account, gone]) {
      expect(b.resets.requireReset).not.toHaveBeenCalled();
      expect(b.resets.sendResetEmail).not.toHaveBeenCalled();
    }
  });

  it('marca y cierra sesiones en la transacción del actor, y el correo sale después', async () => {
    const { service, db, resets, audit, k } = banco({ respond: envio({ recent: 9 }) });

    const res = await service.requirePasswordReset(ACTOR, NODO, TARGET);

    expect(res).toEqual({ sent: true, revokedSessions: 2 });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(db.withRequestContext).toHaveBeenNthCalledWith(
      3,
      { userId: ACTOR },
      expect.any(Function),
    );
    expect(k.queries[0]?.sql).toMatch(/from "users" where "id" = \$1 for no key update$/);
    // La primera vez no mira el límite de enlaces: nunca impide cortar una contraseña comprometida.
    expect(k.indexOf('from "password_reset_tokens"')).toBe(-1);
    expect(resets.requireReset).toHaveBeenCalledWith(expect.anything(), {
      actorUserId: ACTOR,
      targetUserId: TARGET,
      tenantId: NODO,
    });

    expect(resets.sendResetEmail).toHaveBeenCalledWith(
      NODO,
      'beto@agencia.co',
      `https://panel.example/restablecer?token=${TOKEN}`,
      'required',
      'Agencia Norte',
    );
    const markOrder = resets.requireReset.mock.invocationCallOrder[0]!;
    const sendOrder = resets.sendResetEmail.mock.invocationCallOrder[0]!;
    expect(sendOrder).toBeGreaterThan(markOrder);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('si ya estaba obligado, pedirlo de nuevo cuenta para el límite de enlaces: 429 con 3', async () => {
    const pendiente = { ...BETO, password_reset_required_at: new Date() };

    const limited = banco({ respond: envio({ user: pendiente, recent: 3 }) });
    expect(await motivo(limited.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe(
      '429/PASSWORD_RESET_RATE_LIMITED',
    );
    expect(limited.resets.requireReset).not.toHaveBeenCalled();

    const again = banco({ respond: envio({ user: pendiente, recent: 2 }) });
    expect(await motivo(again.service.requirePasswordReset(ACTOR, NODO, TARGET))).toBe('ok');
    expect(again.resets.requireReset).toHaveBeenCalledTimes(1);
  });

  it('si el correo no sale: sent:false, las sesiones igual se cerraron y el fallo queda auditado', async () => {
    const { service, audit } = banco({ respond: envio(), mailOk: false });

    expect(await service.requirePasswordReset(ACTOR, NODO, TARGET)).toEqual({
      sent: false,
      revokedSessions: 2,
    });
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: 'auth.password_reset.email_failed',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'user',
      aggregateId: TARGET,
      payload: { targetUserId: TARGET, via: 'required' },
    });
  });
});

describe('MemberSupportService.unlock', () => {
  const LOCKED_UNTIL = new Date('2026-10-11T12:15:00.000Z');
  const desbloqueo =
    (row: { locked_until: Date } | undefined) =>
    (q: CompiledQuery): unknown[] => {
      if (q.sql.includes('WITH prev AS')) return row ? [row] : [];
      throw new Error(`consulta no prevista: ${q.sql}`);
    };

  it('reusa la autorización: sobre uno mismo es 403 sin consultar nada', async () => {
    const { service, db } = banco({ respond: desbloqueo(undefined) });
    expect(await motivo(service.unlock(ACTOR, NODO, ACTOR))).toBe('403/MEMBER_SELF_ACTION');
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('si no estaba bloqueado: unlocked:false y sin auditoría', async () => {
    const { service, audit } = banco({ respond: desbloqueo(undefined) });

    expect(await service.unlock(ACTOR, NODO, TARGET)).toEqual({ unlocked: false });
    expect(audit.emitWithin).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('si estaba bloqueado: unlocked:true y el evento con el bloqueo que levantó', async () => {
    const { service, audit, k } = banco({ respond: desbloqueo({ locked_until: LOCKED_UNTIL }) });

    expect(await service.unlock(ACTOR, NODO, TARGET)).toEqual({ unlocked: true });
    expect(audit.emitWithin).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'auth.lockout.cleared_by_admin',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'user',
      aggregateId: TARGET,
      payload: { targetUserId: TARGET, lockedUntil: LOCKED_UNTIL.toISOString() },
    });

    // Sólo el contador y el bloqueo vigente: ni contraseña, ni 2FA, ni estado.
    expect(k.queries).toHaveLength(1);
    const update = k.queries[0];
    expect(update?.sql).toMatch(/SET failed_login_attempts = 0,\s+locked_until = NULL/);
    expect(update?.sql).toContain('prev.locked_until > now()');
    expect(update?.sql).not.toMatch(/password|mfa|status/i);
    expect(update?.parameters).toEqual([TARGET, TARGET]);
  });
});

describe('MemberSupportService: la persona se entera por su correo', () => {
  /** La transacción de restablecer el 2FA, de cerrar sesiones o de desbloquear. */
  const accion =
    (opts: { revoked?: number; lockedUntil?: Date | null } = {}) =>
    (q: CompiledQuery): unknown[] => {
      if (q.sql.startsWith('select "mfa_enabled_at" from "users"')) {
        return [{ mfa_enabled_at: new Date() }];
      }
      if (q.sql.includes('admin_reset_user_mfa')) return [];
      if (q.sql.includes('revoke_user_sessions')) return [{ revoked: opts.revoked ?? 2 }];
      if (q.sql.includes('WITH prev AS')) {
        const lockedUntil = opts.lockedUntil === undefined ? new Date() : opts.lockedUntil;
        return lockedUntil === null ? [] : [{ locked_until: lockedUntil }];
      }
      throw new Error(`consulta no prevista: ${q.sql}`);
    };

  it.each([
    [
      'restablecer el 2FA',
      'mfa_reset',
      (s: MemberSupportService) => s.resetMfa(ACTOR, NODO, TARGET),
    ],
    [
      'cerrar sus sesiones',
      'sessions_revoked',
      (s: MemberSupportService) => s.revokeSessions(ACTOR, NODO, TARGET),
    ],
    ['desbloquear', 'unlocked', (s: MemberSupportService) => s.unlock(ACTOR, NODO, TARGET)],
  ])('%s: UN aviso, después del commit y por el nodo de la ruta', async (_q, kind, call) => {
    const { service, audit, notices } = banco({ respond: accion() });
    // Mientras la transacción sigue abierta, todavía no hubo aviso.
    audit.emitWithin.mockImplementationOnce(() => {
      expect(notices.notify).not.toHaveBeenCalled();
      return Promise.resolve();
    });

    await call(service);

    expect(audit.emitWithin).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith(kind, { userId: TARGET, tenantId: NODO });
  });

  it('sin sesiones abiertas no hay nada que contarle; sin bloqueo vigente, tampoco', async () => {
    const sinSesiones = banco({ respond: accion({ revoked: 0 }) });
    expect(await sinSesiones.service.revokeSessions(ACTOR, NODO, TARGET)).toEqual({ revoked: 0 });
    expect(sinSesiones.notices.notify).not.toHaveBeenCalled();

    const sinBloqueo = banco({ respond: accion({ lockedUntil: null }) });
    expect(await sinBloqueo.service.unlock(ACTOR, NODO, TARGET)).toEqual({ unlocked: false });
    expect(sinBloqueo.notices.notify).not.toHaveBeenCalled();
  });

  it('ningún rechazo avisa: uno mismo, fuera del nodo, sin membership, otra red o sin rango', async () => {
    const casos: Array<{ b: ReturnType<typeof banco>; target: string }> = [
      { b: banco({ respond: accion() }), target: ACTOR },
      { b: banco({ respond: accion(), routeRole: undefined }), target: TARGET },
      { b: banco({ respond: accion(), inRoute: undefined }), target: TARGET },
      {
        b: banco({
          respond: accion(),
          active: [
            { tenant_id: NODO, role: 'vendedor' },
            { tenant_id: OTRA_RED, role: 'vendedor' },
          ],
        }),
        target: TARGET,
      },
      {
        b: banco({
          respond: accion(),
          inRoute: { tenant_id: NODO, role: 'tenant_admin', status: 'active' },
          active: [{ tenant_id: NODO, role: 'tenant_admin' }],
        }),
        target: TARGET,
      },
    ];
    for (const { b, target } of casos) {
      expect(await motivo(b.service.resetMfa(ACTOR, NODO, target))).not.toBe('ok');
      expect(b.notices.notify).not.toHaveBeenCalled();
    }
  });

  it('si la auditoría falla, la transacción se deshace y no hay aviso', async () => {
    const { service, audit, notices } = banco({ respond: accion() });
    audit.emitWithin.mockRejectedValueOnce(new Error('el evento no entró'));

    await expect(service.resetMfa(ACTOR, NODO, TARGET)).rejects.toThrow('el evento no entró');
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('enviar el enlace y forzar el cambio no suman otro aviso: su correo ya lo es', async () => {
    const enviar = banco({ respond: envio() });
    await enviar.service.sendPasswordReset(ACTOR, NODO, TARGET);
    expect(enviar.resets.sendResetEmail).toHaveBeenCalledTimes(1);
    expect(enviar.notices.notify).not.toHaveBeenCalled();

    const forzar = banco({ respond: envio() });
    await forzar.service.requirePasswordReset(ACTOR, NODO, TARGET);
    expect(forzar.resets.sendResetEmail).toHaveBeenCalledTimes(1);
    expect(forzar.notices.notify).not.toHaveBeenCalled();
  });
});
