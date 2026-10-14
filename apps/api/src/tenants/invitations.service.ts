import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { canGrantRole, isAssignableRole } from '../auth/roles.js';
import type { DB, Role } from '../database/database.types.js';
import { DatabaseService } from '../database/database.service.js';
import { escapeHtml, plainText } from '../mail/mail-text.js';
import { MailerService } from '../mail/mailer.service.js';
import {
  invitationDefect,
  InvitationNoLongerValidError,
  type InvitationBacking,
  type InvitationDefect,
} from './invitation-validity.js';
import { AlreadyMemberError } from './membership.errors.js';
import {
  InvitationAccountMismatchError,
  InvitationAlreadyPendingError,
  InvitationNotPendingError,
  InvitationSignInRequiredError,
} from './onboarding.errors.js';
import { RoleNotGrantableError } from './tenant-admin.policy.js';

// Antes vivían aquí; se reexportan para quien todavía los importe desde este módulo.
export { escapeHtml, plainText } from '../mail/mail-text.js';

const INVITE_TTL_DAYS = 7;

/** El índice de 0066: una invitación pendiente por correo y nodo. */
const PENDING_UNIQUE_INDEX = 'uq_user_invitations_pending';

/** Lo que devuelven invitar y reenviar. Ni el token ni el enlace: ésos viajan sólo en el correo. */
export interface IssuedInvitation {
  id: string;
  expiresAt: Date;
  /**
   * `false` si el correo no salió (no hay correo configurado para el nodo o el envío falló). La
   * invitación queda creada igual y se reenvía; Equipo se lo dice al admin en vez de "enviada".
   */
  emailSent: boolean;
}

/** ¿El error es el 23505 del índice de 0066, de dos invitaciones simultáneas al mismo correo? */
function isPendingDuplicate(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === PENDING_UNIQUE_INDEX;
}

function newLink(): { token: string; expiresAt: Date } {
  return {
    token: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000),
  };
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  invitedByEmail: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/** Una invitación pendiente que su invitador ya no podría emitir. */
export interface OrphanedInvitation {
  id: string;
  tenantId: string;
  defect: InvitationDefect;
}

/** Qué cambio dejó huérfanas las invitaciones. Viaja en la auditoría de cada revocación. */
export type InvitationRevocationCause =
  | 'membership_suspended'
  | 'membership_removed'
  | 'role_changed'
  | 'user_suspended';

interface BackingRow {
  invitation_id: string;
  tenant_id: string;
  role: Role;
  invited_by: string | null;
  inviter_active: boolean;
  tenant_active: boolean;
  inviter_roles: Role[];
}

function backingOf(row: BackingRow): InvitationBacking {
  return {
    invitationId: row.invitation_id,
    tenantId: row.tenant_id,
    role: row.role,
    invitedBy: row.invited_by,
    inviterActive: row.inviter_active,
    tenantActive: row.tenant_active,
    inviterRoles: row.inviter_roles,
  };
}

export async function backingFor(
  trx: Transaction<DB>,
  invitationIds: readonly string[],
): Promise<InvitationBacking[]> {
  const res = await sql<BackingRow>`
    SELECT * FROM invitation_backing(${[...invitationIds]}::uuid[])
  `.execute(trx);
  return res.rows.map(backingOf);
}

/**
 * Invitaciones de usuario por token.
 *
 * Reemplaza el patrón de `POST /admin/users`, donde el admin ELEGÍA la contraseña del
 * invitado: toda contraseña inicial de la red nacía conocida por un tercero y no había
 * forma de saber si el usuario la había cambiado. Acá el invitado elige la suya y el
 * admin nunca la ve.
 *
 * Del token se persiste sólo el SHA-256; el valor en claro viaja una vez por email.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Crea la invitación y manda el correo. La autorización jerárquica la valida el controller.
   *
   * Si ya hay una pendiente para ese correo en el nodo (vencida o no), 409 con su id: lo que sirve es
   * reenviarla, no sumar otro enlace vigente. El índice de 0066 respalda la regla cuando dos pedidos
   * llegan a la vez; su 23505 sale como el mismo 409.
   *
   * Quien ya es miembro del nodo (activo o suspendido) no se invita: 409. Quien fue quitado del nodo
   * (USR-11) sí: es la única forma de que vuelva, y al aceptar se reactiva su misma membership.
   *
   * La invitación y su UserInvited van en una transacción; el correo sale después, con la invitación
   * ya escrita, y `emailSent` dice si salió.
   */
  async invite(params: {
    actorUserId: string;
    tenantId: string;
    email: string;
    role: Role;
  }): Promise<IssuedInvitation> {
    const { actorUserId, tenantId, email, role } = params;
    const { token, expiresAt } = newLink();

    const id = await this.db
      .withRequestContext({ userId: actorUserId, tenantId }, async (trx) => {
        const existingMember = await trx
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select('memberships.id')
          .where('users.email', '=', email)
          .where('memberships.tenant_id', '=', tenantId)
          .where('memberships.status', '!=', 'removed')
          .executeTakeFirst();
        if (existingMember) throw new ConflictException('Ese correo ya es miembro de este nodo.');

        const pending = await pendingFor(trx, tenantId, email);
        if (pending) throw new InvitationAlreadyPendingError(pending.id);

        const row = await trx
          .insertInto('user_invitations')
          .values({
            tenant_id: tenantId,
            email,
            role,
            token_hash: sha256(token),
            invited_by: actorUserId,
            expires_at: expiresAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.emitWithin(trx, {
          eventType: 'UserInvited',
          tenantId,
          actorUserId,
          aggregateType: 'invitation',
          aggregateId: row.id,
          payload: { email, role },
        });
        return row.id;
      })
      .catch(async (err: unknown): Promise<never> => {
        if (!isPendingDuplicate(err)) throw err;
        // Otro pedido la creó entre la lectura y el insert: se ofrece reenviar la que ganó.
        const winner = await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
          pendingFor(trx, tenantId, email),
        );
        throw new InvitationAlreadyPendingError(winner?.id);
      });

    const emailSent = await this.sendInvitationEmail({
      actorUserId,
      tenantId,
      invitationId: id,
      email,
      token,
      via: 'invite',
    });
    return { id, expiresAt, emailSent };
  }

  /** Invitaciones pendientes del tenant. La RLS de 0028 ya acota al subárbol administrado. */
  async listPending(actorUserId: string, tenantId: string): Promise<PendingInvitation[]> {
    const rows = await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
      trx
        .selectFrom('user_invitations')
        .leftJoin('users', 'users.id', 'user_invitations.invited_by')
        .select([
          'user_invitations.id',
          'user_invitations.email',
          'user_invitations.role',
          'user_invitations.expires_at',
          'user_invitations.created_at',
          'users.email as invitedByEmail',
        ])
        .where('user_invitations.tenant_id', '=', tenantId)
        .where('user_invitations.accepted_at', 'is', null)
        .where('user_invitations.revoked_at', 'is', null)
        .orderBy('user_invitations.created_at', 'desc')
        .execute(),
    );

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedByEmail: r.invitedByEmail,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * Reenvía una invitación pendiente con un enlace nuevo: el anterior deja de valer y vence a los
   * INVITE_TTL_DAYS de ahora, también si ya había vencido. Es el "Reenviar" del correo que no llegó.
   *
   * Reenviar es volver a emitir: exige el rango que pide invitar con ese rol, medido con `actorRole`
   * (el rol con que el actor administra el nodo, lo resuelve el controller), y quien reenvía pasa a
   * ser `invited_by`, el que la respalda desde ahora. El anterior queda en la auditoría. La RLS de
   * 0028 acota la lectura al subárbol que administra.
   */
  async resend(params: {
    actorUserId: string;
    actorRole: Role;
    tenantId: string;
    invitationId: string;
  }): Promise<IssuedInvitation> {
    const { actorUserId, actorRole, tenantId, invitationId } = params;
    const { token, expiresAt } = newLink();

    const invitation = await this.db.withRequestContext(
      { userId: actorUserId, tenantId },
      async (trx) => {
        const pending = await lockPending(trx, tenantId, invitationId);
        if (!pending) throw new InvitationNotPendingError();
        if (!canGrantRole(actorRole, pending.role)) {
          throw new RoleNotGrantableError(
            'No puedes reenviar una invitación con un rol igual o superior al tuyo.',
          );
        }

        await trx
          .updateTable('user_invitations')
          .set({ token_hash: sha256(token), expires_at: expiresAt, invited_by: actorUserId })
          .where('id', '=', pending.id)
          .execute();
        await this.audit.emitWithin(trx, {
          eventType: 'UserInvitationResent',
          tenantId,
          actorUserId,
          aggregateType: 'invitation',
          aggregateId: pending.id,
          payload: {
            role: pending.role,
            previousInvitedBy: pending.invited_by,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return pending;
      },
    );

    const emailSent = await this.sendInvitationEmail({
      actorUserId,
      tenantId,
      invitationId: invitation.id,
      email: invitation.email,
      token,
      via: 'resend',
    });
    return { id: invitation.id, expiresAt, emailSent };
  }

  /**
   * El correo con el enlace. Devuelve si salió: el mailer nunca lanza, contesta `false` si no hay
   * correo configurado para el nodo o el envío falló. La invitación queda igual y se reenvía.
   *
   * Un correo que no salió queda en la auditoría (best-effort) con el id de la invitación y nunca la
   * dirección: el id alcanza para encontrarla y el evento no suma PII.
   */
  private async sendInvitationEmail(params: {
    actorUserId: string;
    tenantId: string;
    invitationId: string;
    email: string;
    token: string;
    via: 'invite' | 'resend';
  }): Promise<boolean> {
    const { actorUserId, tenantId, invitationId, email, token, via } = params;
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select('name')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    const base = process.env['APP_WEB_URL'] ?? 'https://app.planetour.cloud';
    const link = `${base}/invitacion?token=${encodeURIComponent(token)}`;
    const tenantName = plainText(tenant?.name ?? '') || 'la plataforma';

    const sent = await this.mailer.sendToTenant(tenantId, {
      to: email,
      subject: `Te invitaron a ${tenantName}`,
      html: invitationEmailHtml(link, tenantName, INVITE_TTL_DAYS),
      text: `Te invitaron a ${tenantName}. Acepta la invitación aquí (vence en ${INVITE_TTL_DAYS} días): ${link}`,
    });
    if (!sent) {
      await this.audit.emit({
        eventType: 'UserInvitationEmailFailed',
        tenantId,
        actorUserId,
        aggregateType: 'invitation',
        aggregateId: invitationId,
        payload: { invitationId, via },
      });
    }
    return sent;
  }

  /**
   * Revoca una invitación pendiente del nodo. Como reenviar, exige el rango que pide emitirla con ese
   * rol, medido con `actorRole` (el rol con que el actor administra el nodo, lo resuelve el
   * controller): un admin no deja sin efecto la invitación de un tenant_admin.
   *
   * Lectura con bloqueo, cambio y UserInvitationRevoked en una transacción: una invitación que ya no
   * está pendiente (aceptada, revocada, de otro nodo o inexistente) es 404 y no deja rastro, y una
   * aceptación en paralelo espera a la revocación o la revocación a ella.
   */
  async revoke(
    actorUserId: string,
    actorRole: Role,
    tenantId: string,
    invitationId: string,
  ): Promise<{ ok: true }> {
    await this.db.withRequestContext({ userId: actorUserId, tenantId }, async (trx) => {
      const pending = await lockPending(trx, tenantId, invitationId);
      if (!pending) throw new InvitationNotPendingError();
      if (!canGrantRole(actorRole, pending.role)) {
        throw new RoleNotGrantableError(
          'No puedes revocar una invitación con un rol igual o superior al tuyo.',
        );
      }

      await trx
        .updateTable('user_invitations')
        .set({ revoked_at: sql<Date>`now()` })
        .where('id', '=', pending.id)
        .execute();
      await this.audit.emitWithin(trx, {
        eventType: 'UserInvitationRevoked',
        tenantId,
        actorUserId,
        aggregateType: 'invitation',
        aggregateId: pending.id,
        payload: { role: pending.role, cause: 'manual' },
      });
    });
    return { ok: true };
  }

  /**
   * Las invitaciones pendientes que `inviterUserId` emitió en el subárbol de `rootTenantId` (en
   * cualquier nodo si no viene) y que ya no podría emitir (invitation-validity.ts).
   *
   * Corre en `trx`, así que ve el cambio que la transacción acaba de hacer (la membership suspendida o
   * degradada, el usuario suspendido). Las invitaciones se leen con la RLS de `trx` (0028: el
   * subárbol que administra su usuario), que cubre el subárbol de un nodo que el actor administra; lo
   * que respalda a cada una se lee de todas las memberships del invitador (invitation_backing), porque
   * un rol suyo fuera de la red del actor puede seguir respaldándola.
   */
  async orphanedInvitations(
    trx: Transaction<DB>,
    scope: { inviterUserId: string; rootTenantId?: string },
  ): Promise<OrphanedInvitation[]> {
    let query = trx
      .selectFrom('user_invitations')
      .select('user_invitations.id')
      .where('user_invitations.invited_by', '=', scope.inviterUserId)
      .where('user_invitations.accepted_at', 'is', null)
      .where('user_invitations.revoked_at', 'is', null)
      .where('user_invitations.expires_at', '>', sql<Date>`now()`);
    if (scope.rootTenantId !== undefined) {
      query = query.where(
        sql<boolean>`user_invitations.tenant_id IN (
          SELECT t.id
            FROM tenants t
            JOIN tenants root ON root.id = ${scope.rootTenantId}::uuid
           WHERE t.path OPERATOR(public.<@) root.path
        )`,
      );
    }
    const pending = await query.execute();
    if (pending.length === 0) return [];

    const backing = await backingFor(
      trx,
      pending.map((p) => p.id),
    );
    return backing.flatMap((b) => {
      const defect = invitationDefect(b);
      return defect === undefined ? [] : [{ id: b.invitationId, tenantId: b.tenantId, defect }];
    });
  }

  /**
   * Revoca, dentro de `trx`, las {@link orphanedInvitations} y deja un `UserInvitationRevoked` por
   * cada una en la misma transacción: si algo falla, ni el cambio que las dejó huérfanas ni la
   * revocación quedan a medias. Devuelve las revocadas.
   */
  async revokeOrphaned(
    trx: Transaction<DB>,
    params: {
      inviterUserId: string;
      rootTenantId?: string;
      actorUserId: string;
      cause: InvitationRevocationCause;
    },
  ): Promise<OrphanedInvitation[]> {
    const orphaned = await this.orphanedInvitations(trx, params);
    if (orphaned.length === 0) return [];

    const revoked = await trx
      .updateTable('user_invitations')
      .set({ revoked_at: sql<Date>`now()` })
      .where(
        'id',
        'in',
        orphaned.map((o) => o.id),
      )
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute();
    const revokedIds = new Set(revoked.map((r) => r.id));
    const done = orphaned.filter((o) => revokedIds.has(o.id));

    for (const invitation of done) {
      await this.audit.emitWithin(trx, {
        eventType: 'UserInvitationRevoked',
        tenantId: invitation.tenantId,
        actorUserId: params.actorUserId,
        aggregateType: 'invitation',
        aggregateId: invitation.id,
        payload: {
          cause: params.cause,
          defect: invitation.defect,
          invitedBy: params.inviterUserId,
        },
      });
    }
    return done;
  }

  /**
   * Canje con cuenta nueva (`POST /invitations/accept`): el invitado elige su nombre y su contraseña.
   * Es PRE-AUTENTICACIÓN, así que la RLS por subárbol no puede aplicar: se resuelve con
   * claim_pending_invitation() (SECURITY DEFINER acotado, 0056), que como máximo devuelve una fila
   * por hash de token y no permite enumerar.
   *
   * Si el correo invitado ya tiene una cuenta, 409 `INVITATION_SIGN_IN_REQUIRED` y la invitación queda
   * pendiente (USR-17): quien ya tiene cuenta ingresa con la suya y acepta con {@link acceptSignedIn}.
   * Antes se le sumaba la membership ignorando la contraseña que había escrito, sin que la cuenta se
   * autenticara. El 409 sale sólo con un token vigente: no dice nada que la vista previa no le diga ya
   * a quien controla ese buzón.
   *
   * La contraseña se hashea sólo para crear la cuenta: un token inválido no llega hasta acá y no le
   * cuesta un bcrypt a la API.
   */
  async accept(params: {
    token: string;
    name: string;
    password: string;
  }): Promise<{ userId: string; tenantId: string }> {
    return this.redeem(params.token, {
      join: async (trx, invitation) => {
        if ((await accountFor(trx, invitation.email)) !== undefined) {
          throw new InvitationSignInRequiredError();
        }
        const userId = await this.createUser(trx, invitation.email, params.name, params.password);
        return { userId, rejoined: await addMembership(trx, invitation, userId) };
      },
    });
  }

  /**
   * Canje con la sesión abierta (`POST /invitations/join`, USR-17): quien ya tiene cuenta ingresó con
   * la suya (contraseña, y 2FA si lo tiene) y acepta sin elegir otra contraseña.
   *
   * La cuenta de la sesión tiene que ser la dueña del correo invitado (`users.email` y la invitación
   * son CITEXT: sin distinguir mayúsculas). Si no, 403 `INVITATION_ACCOUNT_MISMATCH`, la invitación
   * queda pendiente y el intento queda en la auditoría: un token no se canjea en otra cuenta. Se mira
   * antes que cualquier otra cosa de la invitación.
   *
   * Si lo habían quitado del nodo (USR-11), vuelve con su misma membership; si ya está (activa o
   * suspendida), 409 `ALREADY_MEMBER`.
   */
  async acceptSignedIn(params: {
    token: string;
    userId: string;
  }): Promise<{ userId: string; tenantId: string }> {
    const { token, userId } = params;
    return this.redeem(token, {
      signedInAs: userId,
      join: async (trx, invitation) => ({
        userId,
        rejoined: await addMembership(trx, invitation, userId),
      }),
    });
  }

  /**
   * Lo común a los dos canjes, en una transacción: marcar la invitación aceptada, (con sesión) mirar
   * que la cuenta sea la del correo invitado, revalidar a quien la emitió y el nodo, y `join`. Si algo
   * falla, el rollback la deja pendiente (por ejemplo, su nodo está suspendido y lo reactivan dentro
   * de los 7 días); si una revocación llega en paralelo, una de las dos espera a la otra en la fila de
   * la invitación. Un rechazo por el invitador o por la cuenta deja su rastro fuera de la transacción.
   */
  private async redeem(
    token: string,
    steps: {
      /** La cuenta de la sesión que acepta, si se acepta con sesión. */
      signedInAs?: string;
      join: (
        trx: Transaction<DB>,
        invitation: ClaimedInvitation,
      ) => Promise<{ userId: string; rejoined: boolean }>;
    },
  ): Promise<{ userId: string; tenantId: string }> {
    const { signedInAs } = steps;
    let trail:
      | { eventType: string; invitation: ClaimedInvitation; payload: Record<string, unknown> }
      | undefined;

    const run = async (trx: Transaction<DB>) => {
      const found = await sql<ClaimedInvitation>`
        SELECT * FROM claim_pending_invitation(${invitationTokenHash(token)})
      `.execute(trx);

      const invitation = found.rows[0];
      if (!invitation) throw new BadRequestException('la invitación es inválida o venció');
      // Las invitaciones sólo se crean con roles asignables, pero el rol se relee de la base: una
      // fila con `platform_admin` (retirado, D7 B) o `superadmin` no concede nada.
      if (!isAssignableRole(invitation.role)) {
        throw new BadRequestException('la invitación es inválida o venció');
      }

      if (signedInAs !== undefined && (await accountFor(trx, invitation.email)) !== signedInAs) {
        trail = { eventType: 'UserInvitationAccountMismatch', invitation, payload: {} };
        throw new InvitationAccountMismatchError();
      }

      const [backing] = await backingFor(trx, [invitation.id]);
      const defect = backing === undefined ? 'inviter_missing' : invitationDefect(backing);
      if (defect !== undefined) {
        trail = { eventType: 'UserInvitationRejected', invitation, payload: { defect } };
        throw new InvitationNoLongerValidError();
      }

      return { ...(await steps.join(trx, invitation)), invitation };
    };

    const accepted = await (
      signedInAs === undefined
        ? this.db.db.transaction().execute(run)
        : this.db.withRequestContext({ userId: signedInAs }, run)
    ).catch(async (err: unknown) => {
      if (trail !== undefined) {
        // Fuera de la transacción deshecha: el rastro del intento tiene que quedar.
        await this.audit.emit({
          eventType: trail.eventType,
          tenantId: trail.invitation.tenant_id,
          ...(signedInAs !== undefined ? { actorUserId: signedInAs } : {}),
          aggregateType: 'invitation',
          aggregateId: trail.invitation.id,
          payload: trail.payload,
        });
      }
      throw err;
    });

    const { userId, rejoined, invitation } = accepted;
    await this.audit.emit({
      eventType: 'UserInvitationAccepted',
      tenantId: invitation.tenant_id,
      actorUserId: userId,
      aggregateType: 'invitation',
      aggregateId: invitation.id,
      payload: {
        email: invitation.email,
        role: invitation.role,
        // Aceptó con la sesión de la cuenta que ya tenía (USR-17), no creando una.
        ...(signedInAs !== undefined ? { existingAccount: true } : {}),
        // Volvió al nodo del que lo habían quitado: se reactivó su membership de antes.
        ...(rejoined ? { rejoined: true } : {}),
      },
    });

    return { userId, tenantId: invitation.tenant_id };
  }

  /**
   * La cuenta nueva del invitado. Si otro canje creó la misma cuenta en el medio (dos invitaciones al
   * mismo correo aceptadas a la vez), la UNIQUE del correo responde como si ya existiera: 409
   * `INVITATION_SIGN_IN_REQUIRED`, en vez de un 500.
   */
  private async createUser(
    trx: Transaction<DB>,
    email: string,
    name: string,
    password: string,
  ): Promise<string> {
    const passwordHash = await this.password.hash(password);
    try {
      const created = await trx
        .insertInto('users')
        .values({
          email,
          name,
          password_hash: passwordHash,
          // Aceptar la invitación demuestra control del buzón: vale como verificación.
          email_verified_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return created.id;
    } catch (err) {
      if (isUniqueViolation(err, USERS_EMAIL_UNIQUE)) throw new InvitationSignInRequiredError();
      throw err;
    }
  }
}

/** Lo que devuelve claim_pending_invitation() (0056). */
interface ClaimedInvitation {
  id: string;
  tenant_id: string;
  email: string;
  role: Role;
}

/** La UNIQUE de `users.email` (0001). */
const USERS_EMAIL_UNIQUE = 'users_email_key';

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === constraint;
}

/** La cuenta dueña del correo, si la hay. `users.email` es CITEXT: sin distinguir mayúsculas. */
async function accountFor(trx: Transaction<DB>, email: string): Promise<string | undefined> {
  const row = await trx
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  return row?.id;
}

/**
 * La membership del invitado en el nodo de la invitación. Devuelve si fue una vuelta (`rejoined`).
 *
 * Si lo habían quitado de este nodo (USR-11), su membership `removed` vuelve a estar activa con el
 * rol de la invitación: la UNIQUE (tenant_id, user_id) no deja crear otra, y la misma fila conserva su
 * historial. Si ya tiene una vigente (activa o suspendida), el canje se deshace con un 409: una
 * invitación no reactiva a alguien suspendido.
 */
async function addMembership(
  trx: Transaction<DB>,
  invitation: { tenant_id: string; role: Role },
  userId: string,
): Promise<boolean> {
  await sql`SELECT set_config('app.current_tenant_id', ${invitation.tenant_id}, true)`.execute(trx);
  const written = await trx
    .insertInto('memberships')
    .values({ tenant_id: invitation.tenant_id, user_id: userId, role: invitation.role })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'user_id'])
        .doUpdateSet((eb) => ({
          status: 'active',
          role: eb.ref('excluded.role'),
          removed_at: null,
          removed_by: null,
        }))
        .where('memberships.status', '=', 'removed'),
    )
    // xmax = 0 sólo en una fila recién insertada: distingue el alta de la vuelta.
    .returning(sql<boolean>`NOT (xmax = 0)`.as('rejoined'))
    .executeTakeFirst();
  if (written === undefined) throw new AlreadyMemberError();
  return written.rejoined;
}

/** El hash con que se guarda y se busca el token de una invitación. Del token sólo se guarda esto. */
export function invitationTokenHash(token: string): string {
  return sha256(token);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** La invitación pendiente (vencida o no) de ese correo en el nodo, si la hay. La acota la RLS de 0028. */
function pendingFor(
  trx: Transaction<DB>,
  tenantId: string,
  email: string,
): Promise<{ id: string } | undefined> {
  return trx
    .selectFrom('user_invitations')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', email)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
}

/** La invitación pendiente del nodo, con la fila tomada hasta el final de la transacción. */
function lockPending(
  trx: Transaction<DB>,
  tenantId: string,
  invitationId: string,
): Promise<{ id: string; email: string; role: Role; invited_by: string | null } | undefined> {
  return trx
    .selectFrom('user_invitations')
    .select(['id', 'email', 'role', 'invited_by'])
    .where('id', '=', invitationId)
    .where('tenant_id', '=', tenantId)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
}

export function invitationEmailHtml(link: string, tenantName: string, ttlDays: number): string {
  const name = escapeHtml(tenantName);
  const href = escapeHtml(link);
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#18181b">Te invitaron a ${name}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#52525b">
            Acepta la invitación: si ya tienes cuenta, ingresas con tu contraseña de siempre; si no, eliges una. El enlace vence en ${ttlDays} días.
          </p>
          <a href="${href}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">
            Aceptar invitación
          </a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">
            Si no esperabas esta invitación, ignora este correo.<br>
            <span style="color:#4f46e5;word-break:break-all">${href}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
