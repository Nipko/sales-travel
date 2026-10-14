import { createHash } from 'node:crypto';
import type { CompiledQuery, Transaction } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { voseoIn } from '../__fixtures__/voseo.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { SecurityNoticeService } from '../mail/security-notice.service.js';
import { PasswordReuseError } from './auth-errors.js';
import { passwordResetEmail } from './password-reset-email.js';
import {
  PasswordResetService,
  REQUIRED_RESET_RESEND_MINUTES,
  RESET_TOKEN_TTL_MINUTES,
} from './password-reset.service.js';
import type { PasswordService } from './password.service.js';
import type { SessionService } from './session.service.js';

/**
 * Los enlaces para restablecer la contraseña, con la base sustituida por lo que devolvería: qué se
 * guarda (sólo el hash), qué se invalida antes y qué sale en la respuesta y en el correo. Contra
 * Postgres, member-support.integration.test.ts y auth-premium.integration.test.ts.
 */
const USER = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const LINK = 'https://app.planetour.cloud/restablecer?token=abc_DEF-123';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * La fila del usuario tomada con FOR NO KEY UPDATE: la que lee "elegir una contraseña nueva" al
 * intentar ingresar y la que toma el canje del enlace antes de marcarlo usado.
 */
interface Cuenta {
  email: string;
  status: string;
  password_reset_required_at: Date | null;
  password_hash?: string;
}

interface Banco {
  user?: { id: string; status: string; password_hash?: string } | undefined;
  membership?: { tenantId: string; name: string } | undefined;
  mailOk?: boolean;
  cuenta?: Cuenta | undefined;
  /** Tiene un enlace pendiente emitido hace menos de 10 minutos. */
  recentToken?: boolean;
  /** Lo que contesta PasswordService.verify, en orden. */
  verify?: boolean[];
}

const REQUERIDA: Cuenta = {
  email: 'ana@agencia.co',
  status: 'active',
  password_reset_required_at: new Date('2026-10-13T10:00:00.000Z'),
};

function banco(opts: Banco = {}) {
  const user = 'user' in opts ? opts.user : { id: USER, status: 'active' };
  const membership =
    'membership' in opts ? opts.membership : { tenantId: NODO, name: 'Agencia Norte' };
  const cuenta = 'cuenta' in opts ? opts.cuenta : REQUERIDA;
  const k = scriptedKysely((q: CompiledQuery) => {
    if (q.sql.includes('from "users"') && q.sql.endsWith('for no key update')) {
      return cuenta ? [cuenta] : [];
    }
    if (q.sql.includes('from "users"')) return user ? [user] : [];
    if (q.sql.includes('from "memberships"')) return membership ? [membership] : [];
    if (q.sql.startsWith('select "id" from "password_reset_tokens"')) {
      return opts.recentToken ? [{ id: 'enlace-reciente' }] : [];
    }
    if (q.sql.startsWith('select "user_id" from "password_reset_tokens"')) {
      return [{ user_id: USER }];
    }
    if (q.sql.startsWith('update "password_reset_tokens"') && q.sql.includes('returning')) {
      return [{ user_id: USER }];
    }
    if (q.sql.includes('"password_reset_tokens"')) return [];
    if (q.sql.startsWith('update "users"')) return [];
    if (q.sql.includes('revoke_user_sessions')) return [{ revoked: 2 }];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const mailer = { sendToTenant: vi.fn(() => Promise.resolve(opts.mailOk ?? true)) };
  const audit = {
    emit: vi.fn(() => Promise.resolve()),
    emitWithin: vi.fn(() => Promise.resolve()),
  };
  const verify = vi.fn();
  for (const answer of opts.verify ?? []) verify.mockResolvedValueOnce(answer);
  const password = { hash: vi.fn(() => Promise.resolve('hash-nuevo')), verify };
  const sessions = { revokeAllForUser: vi.fn(() => Promise.resolve(1)) };
  const notices = { notify: vi.fn() };
  const withRequestContext = vi.fn(
    <T>(_ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
      k.db.transaction().execute(fn),
  );
  const service = new PasswordResetService(
    { db: k.db, withRequestContext } as unknown as DatabaseService,
    password as unknown as PasswordService,
    mailer as unknown as MailerService,
    audit as unknown as AuditService,
    sessions as unknown as SessionService,
    notices as unknown as SecurityNoticeService,
  );
  const inserted = () => {
    const q = k.queries.find((x) => x.sql.startsWith('insert into "password_reset_tokens"'));
    return q?.parameters ?? [];
  };
  return { service, k, mailer, audit, inserted, sessions, notices, withRequestContext };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('issueToken', () => {
  it('guarda sólo el hash del token, con 60 minutos de vida', async () => {
    const { service, k, inserted } = banco();
    const before = Date.now();

    const { token, expiresAt } = await service.issueToken(k.db, USER, {
      invalidatePrevious: false,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserted()).toContain(USER);
    expect(inserted()).toContain(sha256(token));
    expect(inserted()).not.toContain(token);
    const ttl = expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(RESET_TOKEN_TTL_MINUTES * 60_000);
    expect(ttl).toBeLessThan(RESET_TOKEN_TTL_MINUTES * 60_000 + 5_000);
    // Sin invalidar: los enlaces anteriores quedan como estaban.
    expect(k.indexOf('update "password_reset_tokens"')).toBe(-1);
  });

  it('con invalidatePrevious da por usados los pendientes del usuario ANTES de emitir el nuevo', async () => {
    const { service, k } = banco();

    await service.issueToken(k.db, USER, { invalidatePrevious: true });

    const invalidate = k.indexOf('update "password_reset_tokens"');
    const insert = k.indexOf('insert into "password_reset_tokens"');
    expect(invalidate).toBeGreaterThanOrEqual(0);
    expect(invalidate).toBeLessThan(insert);
    const q = k.queries[invalidate]!;
    expect(q.sql).toContain('"used_at" = $1');
    expect(q.sql).toContain('"user_id" = $2');
    expect(q.sql).toContain('"used_at" is null');
    expect(q.parameters[1]).toBe(USER);
  });

  it('dos enlaces seguidos nunca comparten token', async () => {
    const { service, k } = banco();
    const a = await service.issueToken(k.db, USER, { invalidatePrevious: true });
    const b = await service.issueToken(k.db, USER, { invalidatePrevious: true });
    expect(a.token).not.toBe(b.token);
  });
});

describe('resetLink y sendResetEmail', () => {
  it('el enlace va a /restablecer del panel, con el token codificado', () => {
    vi.stubEnv('APP_WEB_URL', 'https://panel.example');
    const { service } = banco();
    expect(service.resetLink('a+b/c')).toBe('https://panel.example/restablecer?token=a%2Bb%2Fc');
  });

  it('devuelve lo que contestó el correo, por el nodo indicado', async () => {
    const { service, mailer } = banco({ mailOk: false });

    expect(await service.sendResetEmail(NODO, 'ana@agencia.co', LINK, 'admin', 'Viajes Sur')).toBe(
      false,
    );
    expect(mailer.sendToTenant).toHaveBeenCalledWith(
      NODO,
      expect.objectContaining({
        to: 'ana@agencia.co',
        subject: 'Restablece tu contraseña · PlaneTour',
        text: expect.stringContaining(
          'Un administrador de Viajes Sur te envió este enlace',
        ) as unknown,
      }),
    );
  });
});

describe('request: "Olvidé mi contraseña" no enumera cuentas', () => {
  it('un email desconocido responde {sent:true} sin emitir enlace ni correo', async () => {
    const { service, k, mailer, audit } = banco({ user: undefined });

    expect(await service.request('nadie@example.com')).toEqual({ sent: true });
    expect(k.indexOf('password_reset_tokens')).toBe(-1);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('una cuenta suspendida responde lo mismo, sin enlace', async () => {
    const { service, k, mailer } = banco({ user: { id: USER, status: 'suspended' } });

    expect(await service.request('ana@agencia.co')).toEqual({ sent: true });
    expect(k.indexOf('password_reset_tokens')).toBe(-1);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
  });

  it('una cuenta activa recibe el enlace por el correo de su nodo; la respuesta no lo trae', async () => {
    vi.stubEnv('APP_WEB_URL', 'https://panel.example');
    const { service, k, mailer, audit, inserted, withRequestContext } = banco();

    const res = await service.request('ana@agencia.co');

    expect(res).toEqual({ sent: true });
    expect(JSON.stringify(res)).not.toMatch(/token|restablecer/);
    // No invalida los anteriores: pedir otro no le corta a nadie el enlace que ya recibió.
    expect(k.indexOf('update "password_reset_tokens"')).toBe(-1);

    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    const [tenantId, mail] = mailer.sendToTenant.mock.calls[0] as unknown as [
      string,
      { to: string; text: string; html: string },
    ];
    expect(tenantId).toBe(NODO);
    // Su nodo se lee con SU id en el contexto: sin él, la RLS de memberships no muestra ninguna y el
    // correo salía siempre por el del sistema.
    expect(withRequestContext).toHaveBeenCalledWith({ userId: USER }, expect.any(Function));
    expect(mail.to).toBe('ana@agencia.co');
    expect(mail.text).toContain('Recibimos un pedido para cambiar tu contraseña');
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
    expect(mail.text).toContain('https://panel.example/restablecer?token=');
    // El token del correo es el que se guardó hasheado.
    expect(inserted()).toContain(sha256(token));

    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'auth.password_reset.requested', aggregateId: USER }),
    );
  });

  it('sin nodo activo sale por el correo del sistema', async () => {
    const { service, mailer } = banco({ membership: undefined });
    await service.request('ana@agencia.co');
    expect(mailer.sendToTenant).toHaveBeenCalledWith(null, expect.anything());
  });

  it('si el correo no sale, igual responde {sent:true} y el fallo queda auditado', async () => {
    const { service, audit } = banco({ mailOk: false });

    expect(await service.request('ana@agencia.co')).toEqual({ sent: true });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth.password_reset.email_failed',
        payload: { targetUserId: USER, via: 'self' },
      }),
    );
  });
});

describe('requireReset: obligar a elegir una contraseña nueva', () => {
  const ACTOR = '99999999-9999-4999-8999-999999999999';

  it('marca, cierra sus sesiones, deja un solo enlace vigente y lo audita, todo en la transacción', async () => {
    const { service, k, audit, inserted } = banco();

    const res = await k.db
      .transaction()
      .execute((trx) =>
        service.requireReset(trx, { actorUserId: ACTOR, targetUserId: USER, tenantId: NODO }),
      );

    expect(res.revokedSessions).toBe(2);
    expect(inserted()).toContain(sha256(res.token));
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const mark = k.indexOf('update "users"');
    const revoke = k.indexOf('revoke_user_sessions');
    const invalidate = k.indexOf('update "password_reset_tokens"');
    const insert = k.indexOf('insert into "password_reset_tokens"');
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(invalidate);
    expect(invalidate).toBeLessThan(insert);
    // Si ya estaba marcada, conserva desde cuándo.
    expect(k.queries[mark]!.sql).toContain(
      'set "password_reset_required_at" = COALESCE(password_reset_required_at, now())',
    );
    expect(k.queries[mark]!.parameters).toEqual([USER]);
    expect(k.queries[revoke]!.parameters).toEqual([USER, 'password_reset_required']);

    expect(audit.emitWithin).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'auth.password_reset.required_by_admin',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'user',
      aggregateId: USER,
      payload: { targetUserId: USER, revokedSessions: 2 },
    });
    expect(JSON.stringify(audit.emitWithin.mock.calls)).not.toContain(res.token);
  });

  it('en bloque (USR-14), el evento dice que fue en bloque y con qué lote', async () => {
    const { service, k, audit } = banco();
    const LOTE = '77777777-7777-4777-8777-777777777777';

    await k.db.transaction().execute((trx) =>
      service.requireReset(trx, {
        actorUserId: ACTOR,
        targetUserId: USER,
        tenantId: null,
        batchId: LOTE,
      }),
    );

    expect(audit.emitWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'auth.password_reset.required_by_admin',
        tenantId: null,
        payload: { targetUserId: USER, revokedSessions: 2, bulk: true, batchId: LOTE },
      }),
    );
  });
});

describe('remindRequiredReset: al intentar ingresar con el cambio pendiente', () => {
  it('sin un enlace reciente le envía uno con el texto de "elegir una contraseña nueva"', async () => {
    vi.stubEnv('APP_WEB_URL', 'https://panel.example');
    const { service, k, mailer, audit, inserted } = banco();

    expect(await service.remindRequiredReset(USER)).toEqual({ linkSent: true });

    // La fila queda tomada mientras se decide: dos intentos en paralelo no envían dos correos.
    expect(k.queries[0]!.sql).toMatch(/from "users" where "id" = \$1 for no key update$/);
    const recent = k.queries.find((q) =>
      q.sql.startsWith('select "id" from "password_reset_tokens"'),
    );
    expect(recent?.sql).toContain('"used_at" is null');
    expect(recent?.sql).toContain('expires_at > now()');
    expect(recent?.sql).toContain('created_at > now() - make_interval(mins => $2)');
    expect(recent?.parameters).toEqual([USER, REQUIRED_RESET_RESEND_MINUTES, 1]);
    // No deja sin efecto el que ya tiene en el buzón.
    expect(k.indexOf('update "password_reset_tokens"')).toBe(-1);

    const [tenantId, mail] = mailer.sendToTenant.mock.calls[0] as unknown as [
      string,
      { to: string; subject: string; text: string },
    ];
    expect(tenantId).toBe(NODO);
    expect(mail.to).toBe('ana@agencia.co');
    expect(mail.subject).toBe('Elige una contraseña nueva · PlaneTour');
    expect(mail.text).toContain('Un administrador de Agencia Norte te pidió');
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
    expect(inserted()).toContain(sha256(token));
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it(`con un enlace pendiente de los últimos ${REQUIRED_RESET_RESEND_MINUTES} minutos no envía otro`, async () => {
    const { service, k, mailer } = banco({ recentToken: true });

    expect(await service.remindRequiredReset(USER)).toEqual({ linkSent: false });
    expect(k.indexOf('insert into "password_reset_tokens"')).toBe(-1);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
  });

  it('sin la marca, suspendida o inexistente, no hace nada', async () => {
    for (const cuenta of [
      { ...REQUERIDA, password_reset_required_at: null },
      { ...REQUERIDA, status: 'suspended' },
      undefined,
    ]) {
      const { service, k, mailer } = banco({ cuenta });
      expect(await service.remindRequiredReset(USER)).toEqual({ linkSent: false });
      expect(k.indexOf('"password_reset_tokens"')).toBe(-1);
      expect(mailer.sendToTenant).not.toHaveBeenCalled();
    }
  });

  it('si el correo no sale: linkSent false y el fallo queda auditado', async () => {
    const { service, audit } = banco({ mailOk: false });

    expect(await service.remindRequiredReset(USER)).toEqual({ linkSent: false });
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: 'auth.password_reset.email_failed',
      actorUserId: USER,
      aggregateType: 'user',
      aggregateId: USER,
      payload: { targetUserId: USER, via: 'required' },
    });
  });

  it('sin nodo activo sale por el correo del sistema, firmado por "la plataforma"', async () => {
    const { service, mailer } = banco({ membership: undefined });
    await service.remindRequiredReset(USER);
    expect(mailer.sendToTenant).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        text: expect.stringContaining('Un administrador de la plataforma te pidió') as unknown,
      }),
    );
  });
});

describe('reset y change levantan la marca de "elegir una contraseña nueva"', () => {
  it('reset: la marca se limpia en el mismo UPDATE que fija la contraseña', async () => {
    const { service, k, sessions } = banco();

    expect(await service.reset('token-del-correo', 'una-contraseña-nueva-larga')).toEqual({
      ok: true,
    });

    const update = k.queries.find((q) => q.sql.startsWith('update "users"'));
    expect(update?.sql).toContain('"password_hash" = $1');
    expect(update?.sql).toContain('"password_reset_required_at" = $');
    const columns = /set (.*) where/.exec(update!.sql)![1]!.split(', ');
    const at = columns.findIndex((c) => c.startsWith('"password_reset_required_at"'));
    expect(update?.parameters[at]).toBeNull();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER, 'password_reset');
  });

  it('reset: toma la fila del usuario antes que la del enlace (el orden de forzar el cambio)', async () => {
    const { service, k } = banco();

    await service.reset('token-del-correo', 'una-contraseña-nueva-larga');

    const lock = k.queries.findIndex(
      (q) => q.sql.includes('from "users"') && q.sql.endsWith('for no key update'),
    );
    const redeem = k.queries.findIndex(
      (q) => q.sql.startsWith('update "password_reset_tokens"') && q.sql.includes('returning'),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(redeem).toBeGreaterThan(lock);
  });

  it('reset con el cambio forzado: la misma contraseña de antes es PASSWORD_REUSED y no cambia nada', async () => {
    const { service, k, sessions, audit, notices } = banco({
      cuenta: { ...REQUERIDA, password_hash: 'hash-viejo' },
      verify: [true],
    });

    const err = await service
      .reset('token-del-correo', 'la-misma-de-antes')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PasswordReuseError);
    expect((err as PasswordReuseError).getStatus()).toBe(400);
    expect((err as PasswordReuseError).reason).toBe('PASSWORD_REUSED');
    expect(k.queries.some((q) => q.sql.startsWith('update "users"'))).toBe(false);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('reset con el cambio forzado y una contraseña distinta: la acepta', async () => {
    const { service, k } = banco({
      cuenta: { ...REQUERIDA, password_hash: 'hash-viejo' },
      verify: [false],
    });

    expect(await service.reset('token-del-correo', 'una-contraseña-nueva-larga')).toEqual({
      ok: true,
    });
    expect(k.queries.some((q) => q.sql.startsWith('update "users"'))).toBe(true);
  });

  it('reset sin el cambio forzado: no compara con la anterior ("Olvidé mi contraseña")', async () => {
    const { service } = banco({
      cuenta: { ...REQUERIDA, password_reset_required_at: null, password_hash: 'hash-viejo' },
      verify: [true],
    });

    expect(await service.reset('token-del-correo', 'la-misma-de-antes')).toEqual({ ok: true });
  });

  it('reset con un enlace que no existe, ya usado o vencido: 400 sin tocar al usuario', async () => {
    const notices = { notify: vi.fn() };
    const k = scriptedKysely((q: CompiledQuery) => {
      if (q.sql.includes('"password_reset_tokens"')) return [];
      throw new Error(`consulta no prevista: ${q.sql}`);
    });
    const service = new PasswordResetService(
      { db: k.db } as unknown as DatabaseService,
      { hash: vi.fn(() => Promise.resolve('hash-nuevo')) } as unknown as PasswordService,
      {} as MailerService,
      {} as AuditService,
      {} as SessionService,
      notices as unknown as SecurityNoticeService,
    );

    await expect(service.reset('token-desconocido', 'una-contraseña-nueva-larga')).rejects.toThrow(
      'el enlace de restablecimiento es inválido o venció',
    );
    expect(k.queries.some((q) => q.sql.includes('"users"'))).toBe(false);
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('change: igual en el cambio autenticado', async () => {
    const { service, k } = banco({
      user: { id: USER, status: 'active', password_hash: 'hash-viejo' },
      verify: [true, false],
    });

    expect(await service.change(USER, 'la-actual', 'una-contraseña-nueva-larga')).toEqual({
      ok: true,
    });

    const update = k.queries.find((q) => q.sql.startsWith('update "users"'));
    const columns = /set (.*) where/.exec(update!.sql)![1]!.split(', ');
    const at = columns.findIndex((c) => c.startsWith('"password_reset_required_at"'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(update?.parameters[at]).toBeNull();
  });
});

describe('reset y change: la persona se entera por su correo de que la contraseña cambió', () => {
  it('reset: UN aviso, sin nodo de por medio, después de cerrar sus sesiones y auditar', async () => {
    const { service, notices, sessions, audit } = banco();

    await service.reset('token-del-correo', 'una-contraseña-nueva-larga');

    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('password_changed', {
      userId: USER,
      tenantId: null,
    });
    const notifyOrder = notices.notify.mock.invocationCallOrder[0]!;
    expect(notifyOrder).toBeGreaterThan(sessions.revokeAllForUser.mock.invocationCallOrder[0]!);
    expect(notifyOrder).toBeGreaterThan(audit.emit.mock.invocationCallOrder[0]!);
  });

  it('change: UN aviso después del cambio autenticado', async () => {
    const { service, notices, audit } = banco({
      user: { id: USER, status: 'active', password_hash: 'hash-viejo' },
      verify: [true, false],
    });

    await service.change(USER, 'la-actual', 'una-contraseña-nueva-larga');

    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith('password_changed', {
      userId: USER,
      tenantId: null,
    });
    expect(notices.notify.mock.invocationCallOrder[0]!).toBeGreaterThan(
      audit.emit.mock.invocationCallOrder[0]!,
    );
  });

  it('change rechazado (la actual no es, o la nueva es la misma): sin aviso', async () => {
    const actualMal = banco({
      user: { id: USER, status: 'active', password_hash: 'hash-viejo' },
      verify: [false],
    });
    await expect(
      actualMal.service.change(USER, 'otra', 'una-contraseña-nueva-larga'),
    ).rejects.toThrow('la contraseña actual no es correcta');
    expect(actualMal.notices.notify).not.toHaveBeenCalled();

    const misma = banco({
      user: { id: USER, status: 'active', password_hash: 'hash-viejo' },
      verify: [true, true],
    });
    await expect(misma.service.change(USER, 'la-actual', 'la-actual')).rejects.toThrow(
      'la contraseña nueva debe ser distinta de la actual',
    );
    expect(misma.notices.notify).not.toHaveBeenCalled();
  });

  it('pedir el enlace o recordarlo al ingresar no es un cambio: sin aviso', async () => {
    const pedir = banco();
    await pedir.service.request('ana@agencia.co');
    expect(pedir.notices.notify).not.toHaveBeenCalled();

    const recordar = banco();
    await recordar.service.remindRequiredReset(USER);
    expect(recordar.notices.notify).not.toHaveBeenCalled();
  });
});

describe('correo para restablecer la contraseña', () => {
  const HOSTIL = 'Viajes <a href="https://evil.example/login">Verifica tu cuenta</a>\r\nBcc: x@y.z';

  it('el nombre del nodo sale como texto, no como markup', () => {
    const { html, text, subject } = passwordResetEmail('admin', LINK, 60, HOSTIL);

    expect(html).not.toContain('<a href="https://evil.example');
    expect(html).toContain(
      'Un administrador de Viajes &lt;a href=&quot;https://evil.example/login&quot;&gt;Verifica tu cuenta&lt;/a&gt; Bcc: x@y.z te envió',
    );
    // El único enlace del correo es el de restablecer.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${LINK}"`);
    // Ni el asunto ni el texto plano llevan saltos del nombre (inyección de cabeceras).
    expect(subject).toBe('Restablece tu contraseña · PlaneTour');
    expect(text).toContain('Un administrador de Viajes <a href=');
    expect(text).not.toContain('\r');
  });

  it('un enlace con comillas no cierra el atributo', () => {
    const { html } = passwordResetEmail('self', 'https://x.example/?t="><img src=x>', 60);
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://x.example/?t=&quot;&gt;&lt;img src=x&gt;"');
  });

  it('enviado por un admin: de qué nodo viene, que vence y que la actual sigue', () => {
    const { html, text } = passwordResetEmail('admin', LINK, 60, 'Viajes Sur');
    for (const body of [html, text]) {
      expect(body).toContain('Restablece tu contraseña');
      expect(body).toContain(
        'Un administrador de Viajes Sur te envió este enlace para que elijas una contraseña nueva. Vence en 60 minutos.',
      );
      expect(body).toContain('Elegir contraseña nueva');
      expect(body).toContain(
        'Si no lo esperabas, ignora este correo: tu contraseña actual sigue funcionando. Si crees que es un error, avísale a tu administrador.',
      );
    }
  });

  it('sin nombre legible del nodo dice "la plataforma"', () => {
    expect(passwordResetEmail('admin', LINK, 60, ' \u0000 ').text).toContain(
      'Un administrador de la plataforma te envió',
    );
    expect(passwordResetEmail('admin', LINK, 60).text).toContain('de la plataforma');
  });

  it('pedido por la persona: el texto de siempre', () => {
    const { html, text } = passwordResetEmail('self', LINK, 60);
    for (const body of [html, text]) {
      expect(body).toContain(
        'Recibimos un pedido para cambiar tu contraseña. El enlace vence en 60 minutos.',
      );
      expect(body).toContain('Si no pediste esto, ignora este correo: tu contraseña no cambia.');
      expect(body).not.toContain('administrador');
    }
  });

  it('obligado por un admin: que no puede ingresar hasta elegirla y que el enlace se renueva', () => {
    const { html, text, subject } = passwordResetEmail('required', LINK, 60, 'Viajes Sur');
    expect(subject).toBe('Elige una contraseña nueva · PlaneTour');
    for (const body of [html, text]) {
      expect(body).toContain('Elige una contraseña nueva');
      expect(body).toContain(
        'Un administrador de Viajes Sur te pidió que elijas una contraseña nueva. Hasta que lo hagas no vas a poder ingresar. El enlace vence en 60 minutos; si vence, al intentar ingresar te llega otro.',
      );
      expect(body).toContain('Elegir contraseña nueva');
      // No puede decir que la actual sigue funcionando: ya no sirve.
      expect(body).not.toContain('sigue funcionando');
    }
    const hostil = passwordResetEmail('required', LINK, 60, HOSTIL);
    expect(hostil.html).not.toContain('<a href="https://evil.example');
    expect(hostil.html.match(/<a /g)).toHaveLength(1);
  });

  it('cuenta heredada (USR-14): por qué se lo pedimos, que no puede ingresar y que el enlace se renueva', () => {
    const { html, text, subject } = passwordResetEmail('legacy', LINK, 60, 'Viajes Sur');
    expect(subject).toBe('Elige una contraseña nueva · PlaneTour');
    for (const body of [html, text]) {
      expect(body).toContain('Elige una contraseña nueva');
      expect(body).toContain(
        'Tu cuenta en Viajes Sur se creó con una contraseña que eligió un administrador. Para que sólo tú la conozcas, elige una nueva. Hasta que lo hagas no vas a poder ingresar. El enlace vence en 60 minutos; si vence, al intentar ingresar te llega otro.',
      );
      expect(body).toContain('Si crees que es un error, avísale a tu administrador.');
      expect(body).not.toContain('sigue funcionando');
    }
    const hostil = passwordResetEmail('legacy', LINK, 60, HOSTIL);
    expect(hostil.html).not.toContain('<a href="https://evil.example');
    expect(hostil.html.match(/<a /g)).toHaveLength(1);
    expect(hostil.subject).toBe('Elige una contraseña nueva · PlaneTour');
    expect(hostil.text).not.toContain('\r');
    expect(passwordResetEmail('legacy', LINK, 60).text).toContain(
      'Tu cuenta en la plataforma se creó',
    );
  });

  it('los cuatro van en tú', () => {
    for (const variant of ['self', 'admin', 'required', 'legacy'] as const) {
      const { html, text, subject } = passwordResetEmail(variant, LINK, 60, 'Viajes Sur');
      expect(voseoIn(`${subject}\n${html}\n${text}`)).toEqual([]);
    }
  });
});
