import type { HttpException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { voseoIn } from '../__fixtures__/voseo.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PasswordService } from '../auth/password.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import type { MailerService } from '../mail/mailer.service.js';
import {
  escapeHtml,
  invitationEmailHtml,
  InvitationsService,
  plainText,
} from './invitations.service.js';

const LINK = 'https://app.planetour.cloud/invitacion?token=abc_DEF-123';

describe('correo de invitación: el nombre del nodo no inyecta HTML', () => {
  it('un nombre con un enlace sale como texto, no como markup', () => {
    const html = invitationEmailHtml(
      LINK,
      'Viajes <a href="https://evil.example/login">Verifica tu cuenta</a>',
      7,
    );

    expect(html).not.toContain('<a href="https://evil.example');
    expect(html).not.toContain('evil.example/login">');
    expect(html).toContain(
      'Te invitaron a Viajes &lt;a href=&quot;https://evil.example/login&quot;&gt;Verifica tu cuenta&lt;/a&gt;',
    );
    // El único enlace del correo es el de la invitación.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${LINK}"`);
  });

  it('ni imágenes ni cierre de atributo', () => {
    const html = invitationEmailHtml(LINK, `"><img src=x onerror=alert(1)>`, 7);
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapeHtml cubre texto y atributos con comillas simples o dobles', () => {
    expect(escapeHtml(`Tom & Jerry's <b>"viajes"</b>`)).toBe(
      'Tom &amp; Jerry&#39;s &lt;b&gt;&quot;viajes&quot;&lt;/b&gt;',
    );
  });

  it('va en tú: aceptar (con la contraseña de siempre o una nueva) e ignorar si no se esperaba', () => {
    const html = invitationEmailHtml(LINK, 'Viajes Sur', 7);
    // A quien ya tiene cuenta no se le pide otra contraseña (USR-17).
    expect(html).toContain(
      'Acepta la invitación: si ya tienes cuenta, ingresas con tu contraseña de siempre; si no, eliges una. El enlace vence en 7 días.',
    );
    expect(html).toContain('Si no esperabas esta invitación, ignora este correo.');
    expect(voseoIn(html)).toEqual([]);
  });

  it('el asunto y el texto plano no llevan saltos de línea ni caracteres de control', () => {
    expect(plainText('Agencia\r\nBcc: todos@example.com')).toBe('Agencia Bcc: todos@example.com');
    expect(plainText('  Viajes\u0000Sur\t')).toBe('Viajes Sur');
    expect(plainText('Viajes Ñandú')).toBe('Viajes Ñandú');
  });
});

const ACTOR = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const NUEVA = '22222222-2222-4222-8222-222222222222';
const PENDIENTE = '33333333-3333-4333-8333-333333333333';
const CORREO = 'beto@agencia.co';

interface Escena {
  member?: boolean;
  /** Lo que devuelve cada lectura de la pendiente de ese correo, en orden (la 2ª es tras un 23505). */
  pending?: Array<string | undefined>;
  insertError?: Error;
  /** La fila que toman revocar y reenviar. */
  locked?: { role: Role } | undefined;
  mailOk?: boolean;
}

/** Un error de Postgres como lo lanza `pg`: con su SQLSTATE y la restricción. */
function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
  });
}

/**
 * El servicio con la base guionada (scripted-kysely) y dobles del correo y la auditoría: qué consulta,
 * en qué transacción y qué audita. Que el SQL hace lo que dice lo prueba
 * onboarding-invitation.integration.test.ts contra Postgres.
 */
function escena(opts: Escena = {}) {
  const pending = [...(opts.pending ?? [undefined])];
  const locked = 'locked' in opts ? opts.locked : { role: 'vendedor' as Role };
  const k = scriptedKysely((q) => {
    if (q.sql.includes('from "memberships"')) return opts.member ? [{ id: 'm-1' }] : [];
    if (q.sql.startsWith('select "id" from "user_invitations"')) {
      const id = pending.length > 1 ? pending.shift() : pending[0];
      return id === undefined ? [] : [{ id }];
    }
    if (q.sql.startsWith('insert into "user_invitations"')) {
      if (opts.insertError !== undefined) throw opts.insertError;
      return [{ id: NUEVA }];
    }
    if (q.sql.startsWith('select "id", "email", "role", "invited_by" from "user_invitations"')) {
      return locked === undefined
        ? []
        : [{ id: PENDIENTE, email: CORREO, invited_by: null, ...locked }];
    }
    if (q.sql.startsWith('update "user_invitations"')) return [];
    if (q.sql.includes('from "tenants"')) return [{ name: 'Agencia Norte' }];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const transactions: Transaction<DB>[] = [];
  const db = {
    db: k.db,
    withRequestContext: vi.fn(<T>(_ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>) =>
      k.db.transaction().execute((trx) => {
        transactions.push(trx);
        return fn(trx);
      }),
    ),
  };
  const audit = {
    emitWithin: vi.fn(() => Promise.resolve()),
    emit: vi.fn(() => Promise.resolve()),
  };
  const mailer = { sendToTenant: vi.fn(() => Promise.resolve(opts.mailOk ?? true)) };
  const service = new InvitationsService(
    db as unknown as DatabaseService,
    {} as PasswordService,
    mailer as unknown as MailerService,
    audit as unknown as AuditService,
  );
  return { service, db, audit, mailer, k, transactions };
}

type Rechazo = HttpException & { reason?: string; publicDetails?: unknown };

async function rechazo(p: Promise<unknown>): Promise<Rechazo> {
  try {
    await p;
  } catch (err) {
    return err as Rechazo;
  }
  throw new Error('esperaba un rechazo');
}

const invitar = (s: InvitationsService) =>
  s.invite({ actorUserId: ACTOR, tenantId: NODO, email: CORREO, role: 'vendedor' });

describe('InvitationsService.invite', () => {
  it('la invitación y su UserInvited van en una transacción, y el correo sale después', async () => {
    const { service, audit, mailer, k, transactions } = escena();

    const res = await invitar(service);

    expect(res).toMatchObject({ id: NUEVA, emailSent: true });
    expect(res.expiresAt).toBeInstanceOf(Date);
    expect(transactions).toHaveLength(1);
    expect(k.indexOf('insert into "user_invitations"')).toBeGreaterThan(
      k.indexOf('select "id" from "user_invitations"'),
    );
    expect(audit.emitWithin).toHaveBeenCalledWith(transactions[0], {
      eventType: 'UserInvited',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'invitation',
      aggregateId: NUEVA,
      payload: { email: CORREO, role: 'vendedor' },
    });
    expect(audit.emit).not.toHaveBeenCalled();
    const auditOrder = audit.emitWithin.mock.invocationCallOrder[0]!;
    expect(mailer.sendToTenant.mock.invocationCallOrder[0]!).toBeGreaterThan(auditOrder);
    // El token viaja sólo en el correo, nunca en la respuesta.
    expect(Object.keys(res).sort()).toEqual(['emailSent', 'expiresAt', 'id']);
  });

  it('con una pendiente para ese correo en el nodo: 409 con su id, sin insertar ni mandar nada', async () => {
    const { service, audit, mailer, k } = escena({ pending: [PENDIENTE] });

    const err = await rechazo(invitar(service));

    expect(`${err.getStatus()}/${err.reason}`).toBe('409/INVITATION_ALREADY_PENDING');
    expect(err.message).toBe(
      'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
    );
    expect(err.publicDetails).toEqual({ invitationId: PENDIENTE });
    expect(k.indexOf('insert into')).toBe(-1);
    expect(audit.emitWithin).not.toHaveBeenCalled();
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
    // La pendiente del nodo y ese correo, vencida o no.
    const read = k.queries.find((q) => q.sql.startsWith('select "id" from "user_invitations"'));
    expect(read?.sql).toContain('"accepted_at" is null and "revoked_at" is null');
    expect(read?.sql).not.toContain('expires_at');
    expect(read?.parameters).toEqual([NODO, CORREO]);
  });

  it('si ya es miembro del nodo: 409 antes de mirar las invitaciones', async () => {
    const { service, k } = escena({ member: true });
    const err = await rechazo(invitar(service));
    expect(err.getStatus()).toBe(409);
    expect(err.message).toBe('Ese correo ya es miembro de este nodo.');
    expect(k.indexOf('from "user_invitations"')).toBe(-1);
  });

  it('la carrera que pierde contra el índice de 0066 sale como el mismo 409, con la que ganó', async () => {
    const { service, mailer, transactions } = escena({
      pending: [undefined, PENDIENTE],
      insertError: pgError('23505', 'uq_user_invitations_pending'),
    });

    const err = await rechazo(invitar(service));

    expect(`${err.getStatus()}/${err.reason}`).toBe('409/INVITATION_ALREADY_PENDING');
    expect(err.publicDetails).toEqual({ invitationId: PENDIENTE });
    // La que ganó se relee en otra transacción: la del insert ya se deshizo.
    expect(transactions).toHaveLength(2);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
  });

  it('si la que ganó ya no se puede releer, el 409 sale sin id', async () => {
    const { service } = escena({
      pending: [undefined, undefined],
      insertError: pgError('23505', 'uq_user_invitations_pending'),
    });
    const err = await rechazo(invitar(service));
    expect(err.reason).toBe('INVITATION_ALREADY_PENDING');
    expect(err.publicDetails).toBeUndefined();
  });

  it('otra violación de unicidad no se disfraza de invitación pendiente', async () => {
    const choque = pgError('23505', 'user_invitations_token_hash_key');
    const { service } = escena({ insertError: choque });
    await expect(invitar(service)).rejects.toBe(choque);
  });

  it('si el correo no sale: emailSent false y el fallo auditado sin la dirección', async () => {
    const { service, audit } = escena({ mailOk: false });

    const res = await invitar(service);

    expect(res.emailSent).toBe(false);
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: 'UserInvitationEmailFailed',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'invitation',
      aggregateId: NUEVA,
      payload: { invitationId: NUEVA, via: 'invite' },
    });
    expect(JSON.stringify(audit.emit.mock.calls)).not.toContain(CORREO);
  });
});

describe('InvitationsService.resend', () => {
  const reenviar = (s: InvitationsService) =>
    s.resend({
      actorUserId: ACTOR,
      actorRole: 'tenant_admin',
      tenantId: NODO,
      invitationId: PENDIENTE,
    });

  it('devuelve si el correo salió', async () => {
    const { service, audit } = escena();
    const res = await reenviar(service);
    expect(res).toMatchObject({ id: PENDIENTE, emailSent: true });
    expect(res.expiresAt).toBeInstanceOf(Date);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('si el correo no sale: emailSent false y el fallo auditado', async () => {
    const { service, audit } = escena({ mailOk: false });
    expect((await reenviar(service)).emailSent).toBe(false);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'UserInvitationEmailFailed',
        aggregateId: PENDIENTE,
        payload: { invitationId: PENDIENTE, via: 'resend' },
      }),
    );
  });
});

describe('InvitationsService.revoke', () => {
  it('toma la fila, la revoca y deja UserInvitationRevoked en la misma transacción', async () => {
    const { service, audit, k, transactions } = escena();

    expect(await service.revoke(ACTOR, 'tenant_admin', NODO, PENDIENTE)).toEqual({ ok: true });

    const lock = k.queries[0];
    expect(lock?.sql).toMatch(/for update$/);
    expect(lock?.sql).toContain('"accepted_at" is null and "revoked_at" is null');
    expect(lock?.parameters).toEqual([PENDIENTE, NODO]);
    const update = k.queries[1];
    expect(update?.sql).toBe('update "user_invitations" set "revoked_at" = now() where "id" = $1');
    expect(update?.parameters).toEqual([PENDIENTE]);
    expect(transactions).toHaveLength(1);
    expect(audit.emitWithin).toHaveBeenCalledWith(transactions[0], {
      eventType: 'UserInvitationRevoked',
      tenantId: NODO,
      actorUserId: ACTOR,
      aggregateType: 'invitation',
      aggregateId: PENDIENTE,
      payload: { role: 'vendedor', cause: 'manual' },
    });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('una invitación que ya no está pendiente es 404 y no deja rastro', async () => {
    const { service, audit, k } = escena({ locked: undefined });

    const err = await rechazo(service.revoke(ACTOR, 'tenant_admin', NODO, PENDIENTE));

    expect(`${err.getStatus()}/${err.reason}`).toBe('404/INVITATION_NOT_PENDING');
    expect(k.indexOf('update "user_invitations"')).toBe(-1);
    expect(audit.emitWithin).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('con un rol igual o superior al de quien revoca: 403 y queda pendiente', async () => {
    const { service, audit, k } = escena({ locked: { role: 'admin' } });

    const err = await rechazo(service.revoke(ACTOR, 'admin', NODO, PENDIENTE));

    expect(`${err.getStatus()}/${err.reason}`).toBe('403/ROLE_NOT_GRANTABLE');
    expect(err.message).toBe(
      'No puedes revocar una invitación con un rol igual o superior al tuyo.',
    );
    expect(k.indexOf('update "user_invitations"')).toBe(-1);
    expect(audit.emitWithin).not.toHaveBeenCalled();
  });
});

const CUENTA = '55555555-5555-4555-8555-555555555555';
const OTRA_CUENTA = '66666666-6666-4666-8666-666666666666';

interface Canje {
  /** La cuenta dueña del correo invitado, si la hay. */
  owner?: string;
  /** El error del insert del usuario nuevo (la carrera contra la UNIQUE del correo). */
  userInsertError?: Error;
}

/**
 * Los dos canjes (USR-17) con la base guionada: qué se consulta, en qué orden y qué se audita. Los
 * casos contra Postgres están en invitation-preview.integration.test.ts.
 */
function canje(opts: Canje = {}) {
  const k = scriptedKysely((q) => {
    if (q.sql.includes('claim_pending_invitation')) {
      return [{ id: PENDIENTE, tenant_id: NODO, email: CORREO, role: 'vendedor' }];
    }
    if (q.sql.startsWith('select "id" from "users"')) {
      return opts.owner === undefined ? [] : [{ id: opts.owner }];
    }
    if (q.sql.includes('invitation_backing')) {
      return [
        {
          invitation_id: PENDIENTE,
          tenant_id: NODO,
          role: 'vendedor',
          invited_by: ACTOR,
          inviter_active: true,
          tenant_active: true,
          inviter_roles: ['tenant_admin'],
        },
      ];
    }
    if (q.sql.startsWith('insert into "users"')) {
      if (opts.userInsertError !== undefined) throw opts.userInsertError;
      return [{ id: NUEVA }];
    }
    if (q.sql.includes('set_config')) return [];
    if (q.sql.startsWith('insert into "memberships"')) return [{ rejoined: false }];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const db = {
    db: k.db,
    withRequestContext: vi.fn(<T>(_ctx: unknown, fn: (trx: Transaction<DB>) => Promise<T>) =>
      k.db.transaction().execute(fn),
    ),
  };
  const audit = { emit: vi.fn(() => Promise.resolve()), emitWithin: vi.fn() };
  const password = { hash: vi.fn(() => Promise.resolve('hash-nuevo')) };
  const service = new InvitationsService(
    db as unknown as DatabaseService,
    password as unknown as PasswordService,
    {} as MailerService,
    audit as unknown as AuditService,
  );
  return { service, db, audit, password, k };
}

const CLAVE = 'una-clave-larga-123';

describe('InvitationsService.accept: sólo cuenta nueva (USR-17)', () => {
  it('si el correo ya tiene cuenta: 409 sin hashear, sin escribir y sin evento de aceptada', async () => {
    const { service, audit, password, k } = canje({ owner: CUENTA });

    const err = await rechazo(service.accept({ token: 'tok', name: 'Beto', password: CLAVE }));

    expect(`${err.getStatus()}/${err.reason}`).toBe('409/INVITATION_SIGN_IN_REQUIRED');
    expect(password.hash).not.toHaveBeenCalled();
    expect(k.indexOf('insert into')).toBe(-1);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('crea la cuenta y la membership, sin sesión de por medio', async () => {
    const { service, db, audit, password, k } = canje();

    expect(await service.accept({ token: 'tok', name: 'Beto', password: CLAVE })).toEqual({
      userId: NUEVA,
      tenantId: NODO,
    });
    expect(password.hash).toHaveBeenCalledWith(CLAVE);
    expect(k.indexOf('insert into "users"')).toBeLessThan(k.indexOf('insert into "memberships"'));
    expect(db.withRequestContext).not.toHaveBeenCalled();
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'UserInvitationAccepted',
        payload: { email: CORREO, role: 'vendedor' },
      }),
    );
  });

  it('otra aceptación creó la cuenta en el medio: el mismo 409, no un 500', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'users_email_key',
    });
    const { service } = canje({ userInsertError: duplicate });

    const err = await rechazo(service.accept({ token: 'tok', name: 'Beto', password: CLAVE }));

    expect(`${err.getStatus()}/${err.reason}`).toBe('409/INVITATION_SIGN_IN_REQUIRED');
  });

  it('otra violación de unicidad no se disfraza', async () => {
    const other = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'otra',
    });
    const { service } = canje({ userInsertError: other });

    await expect(service.accept({ token: 'tok', name: 'Beto', password: CLAVE })).rejects.toBe(
      other,
    );
  });
});

describe('InvitationsService.acceptSignedIn (USR-17)', () => {
  it('con la cuenta dueña del correo: la membership de esa cuenta, sin crear otra', async () => {
    const { service, db, audit, password, k } = canje({ owner: CUENTA });

    expect(await service.acceptSignedIn({ token: 'tok', userId: CUENTA })).toEqual({
      userId: CUENTA,
      tenantId: NODO,
    });

    expect(db.withRequestContext).toHaveBeenCalledWith({ userId: CUENTA }, expect.any(Function));
    expect(password.hash).not.toHaveBeenCalled();
    expect(k.indexOf('insert into "users"')).toBe(-1);
    const membership = k.queries[k.indexOf('insert into "memberships"')];
    expect(membership?.parameters).toContain(CUENTA);
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: 'UserInvitationAccepted',
      tenantId: NODO,
      actorUserId: CUENTA,
      aggregateType: 'invitation',
      aggregateId: PENDIENTE,
      payload: { email: CORREO, role: 'vendedor', existingAccount: true },
    });
  });

  it('con otra cuenta: 403 antes de revalidar al invitador, sin escribir y con el intento auditado sin correos', async () => {
    const { service, audit, k } = canje({ owner: CUENTA });

    const err = await rechazo(service.acceptSignedIn({ token: 'tok', userId: OTRA_CUENTA }));

    expect(`${err.getStatus()}/${err.reason}`).toBe('403/INVITATION_ACCOUNT_MISMATCH');
    expect(k.indexOf('invitation_backing')).toBe(-1);
    expect(k.indexOf('insert into')).toBe(-1);
    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: 'UserInvitationAccountMismatch',
      tenantId: NODO,
      actorUserId: OTRA_CUENTA,
      aggregateType: 'invitation',
      aggregateId: PENDIENTE,
      payload: {},
    });
  });

  it('si el correo invitado no tiene cuenta, ninguna sesión es la dueña', async () => {
    const { service, k } = canje();

    const err = await rechazo(service.acceptSignedIn({ token: 'tok', userId: OTRA_CUENTA }));

    expect(`${err.getStatus()}/${err.reason}`).toBe('403/INVITATION_ACCOUNT_MISMATCH');
    expect(k.indexOf('insert into')).toBe(-1);
  });
});
