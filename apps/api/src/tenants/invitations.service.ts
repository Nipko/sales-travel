import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { canGrantRole, isAssignableRole } from '../auth/roles.js';
import type { DB, Role } from '../database/database.types.js';
import { DatabaseService } from '../database/database.service.js';
import { MailerService } from '../mail/mailer.service.js';
import {
  invitationDefect,
  InvitationNoLongerValidError,
  type InvitationBacking,
  type InvitationDefect,
} from './invitation-validity.js';
import { InvitationNotPendingError } from './onboarding.errors.js';
import { RoleNotGrantableError } from './tenant-admin.policy.js';

const INVITE_TTL_DAYS = 7;

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
export type InvitationRevocationCause = 'membership_suspended' | 'role_changed' | 'user_suspended';

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

async function backingFor(
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

  /** Crea la invitación y manda el correo. La autorización jerárquica la valida el controller. */
  async invite(params: {
    actorUserId: string;
    tenantId: string;
    email: string;
    role: Role;
  }): Promise<{ id: string; expiresAt: Date }> {
    const { actorUserId, tenantId, email, role } = params;

    const existingMember = await this.db.withRequestContext(
      { userId: actorUserId, tenantId },
      (trx) =>
        trx
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select('memberships.id')
          .where('users.email', '=', email)
          .where('memberships.tenant_id', '=', tenantId)
          .executeTakeFirst(),
    );
    if (existingMember) throw new ConflictException('ese email ya pertenece a este tenant');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000);

    const row = await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
      trx
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
        .executeTakeFirstOrThrow(),
    );

    await this.sendInvitationEmail(tenantId, email, token);

    await this.audit.emit({
      eventType: 'UserInvited',
      tenantId,
      actorUserId,
      aggregateType: 'invitation',
      aggregateId: row.id,
      payload: { email, role },
    });

    return { id: row.id, expiresAt };
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
  }): Promise<{ id: string; expiresAt: Date }> {
    const { actorUserId, actorRole, tenantId, invitationId } = params;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000);

    const invitation = await this.db.withRequestContext(
      { userId: actorUserId, tenantId },
      async (trx) => {
        const pending = await trx
          .selectFrom('user_invitations')
          .select(['id', 'email', 'role', 'invited_by'])
          .where('id', '=', invitationId)
          .where('tenant_id', '=', tenantId)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
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

    await this.sendInvitationEmail(tenantId, invitation.email, token);
    return { id: invitation.id, expiresAt };
  }

  /** El correo con el enlace. Best-effort: si falla, la invitación queda y se reenvía. */
  private async sendInvitationEmail(tenantId: string, email: string, token: string): Promise<void> {
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select('name')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    const base = process.env['APP_WEB_URL'] ?? 'https://app.planetour.cloud';
    const link = `${base}/invitacion?token=${encodeURIComponent(token)}`;
    const tenantName = plainText(tenant?.name ?? '') || 'la plataforma';

    try {
      await this.mailer.sendToTenant(tenantId, {
        to: email,
        subject: `Te invitaron a ${tenantName}`,
        html: invitationEmailHtml(link, tenantName, INVITE_TTL_DAYS),
        text: `Te invitaron a ${tenantName}. Aceptá la invitación acá (vence en ${INVITE_TTL_DAYS} días): ${link}`,
      });
    } catch {
      // Best-effort: la invitación queda creada y se puede reenviar.
    }
  }

  async revoke(actorUserId: string, tenantId: string, invitationId: string): Promise<{ ok: true }> {
    await this.db.withRequestContext({ userId: actorUserId, tenantId }, (trx) =>
      trx
        .updateTable('user_invitations')
        .set({ revoked_at: new Date() })
        .where('id', '=', invitationId)
        .where('tenant_id', '=', tenantId)
        .execute(),
    );
    await this.audit.emit({
      eventType: 'UserInvitationRevoked',
      tenantId,
      actorUserId,
      aggregateType: 'invitation',
      aggregateId: invitationId,
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
   * Canje de la invitación. Es PRE-AUTENTICACIÓN, así que la RLS por subárbol no puede aplicar: se
   * resuelve con claim_pending_invitation() (SECURITY DEFINER acotado, 0056), que como máximo
   * devuelve una fila por hash de token y no permite enumerar.
   *
   * Todo va en una transacción: marcar la invitación aceptada, revalidar a quien la emitió y el nodo,
   * y crear usuario y membership. Si la revalidación falla, el rollback la deja pendiente (por
   * ejemplo, su nodo está suspendido y lo reactivan dentro de los 7 días); si una revocación llega en
   * paralelo, una de las dos espera a la otra en la fila de la invitación.
   */
  async accept(params: {
    token: string;
    name: string;
    password: string;
  }): Promise<{ userId: string; tenantId: string }> {
    let rejected: { id: string; tenantId: string; defect: InvitationDefect } | undefined;

    const accepted = await this.db.db
      .transaction()
      .execute(async (trx) => {
        const found = await sql<{
          id: string;
          tenant_id: string;
          email: string;
          role: Role;
        }>`SELECT * FROM claim_pending_invitation(${sha256(params.token)})`.execute(trx);

        const invitation = found.rows[0];
        if (!invitation) throw new BadRequestException('la invitación es inválida o venció');
        // Las invitaciones sólo se crean con roles asignables, pero el rol se relee de la base: una
        // fila con `platform_admin` (retirado, D7 B) o `superadmin` no concede nada.
        if (!isAssignableRole(invitation.role)) {
          throw new BadRequestException('la invitación es inválida o venció');
        }

        const [backing] = await backingFor(trx, [invitation.id]);
        const defect = backing === undefined ? 'inviter_missing' : invitationDefect(backing);
        if (defect !== undefined) {
          rejected = { id: invitation.id, tenantId: invitation.tenant_id, defect };
          throw new InvitationNoLongerValidError();
        }

        const userId = await this.createMember(trx, invitation, params.name, params.password);
        return { userId, invitation };
      })
      .catch(async (err: unknown) => {
        if (err instanceof InvitationNoLongerValidError && rejected !== undefined) {
          // Fuera de la transacción deshecha: el rastro del intento tiene que quedar.
          await this.audit.emit({
            eventType: 'UserInvitationRejected',
            tenantId: rejected.tenantId,
            aggregateType: 'invitation',
            aggregateId: rejected.id,
            payload: { defect: rejected.defect },
          });
        }
        throw err;
      });

    const { userId, invitation } = accepted;
    await this.audit.emit({
      eventType: 'UserInvitationAccepted',
      tenantId: invitation.tenant_id,
      actorUserId: userId,
      aggregateType: 'invitation',
      aggregateId: invitation.id,
      payload: { email: invitation.email, role: invitation.role },
    });

    return { userId, tenantId: invitation.tenant_id };
  }

  /**
   * El usuario del invitado (nuevo, o el que ya existía en otra agencia) y su membership. La
   * contraseña se hashea sólo para un usuario nuevo: un token inválido no llega hasta acá y no le
   * cuesta un bcrypt a la API.
   */
  private async createMember(
    trx: Transaction<DB>,
    invitation: { tenant_id: string; email: string; role: Role },
    name: string,
    password: string,
  ): Promise<string> {
    const existing = await trx
      .selectFrom('users')
      .select(['id', 'password_hash'])
      .where('email', '=', invitation.email)
      .executeTakeFirst();

    let id: string;
    if (existing) {
      // El usuario ya existe en otra agencia de la red: se le suma la membership sin
      // tocarle la contraseña, que es suya y no de quien lo invita.
      id = existing.id;
    } else {
      const created = await trx
        .insertInto('users')
        .values({
          email: invitation.email,
          name,
          password_hash: await this.password.hash(password),
          // Aceptar la invitación demuestra control del buzón: vale como verificación.
          email_verified_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = created.id;
    }

    await sql`SELECT set_config('app.current_tenant_id', ${invitation.tenant_id}, true)`.execute(
      trx,
    );
    await trx
      .insertInto('memberships')
      .values({ tenant_id: invitation.tenant_id, user_id: id, role: invitation.role })
      .execute();

    return id;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Escapa un valor para interpolarlo en HTML, en texto o dentro de un atributo entre comillas.
 *
 * El nombre del nodo lo elige su propio admin (PATCH /tenants/:id/config sólo valida el largo) y la
 * invitación sale con la identidad de la plataforma a cualquier email: sin escapar, una agencia
 * metía enlaces o markup en un correo legítimo, que es phishing servido.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Texto de una sola línea para el asunto y el cuerpo en texto plano: sin caracteres de control. Un
 * salto de línea en el asunto es la puerta a inyectar cabeceras si algún día el correo no pasa por
 * un cliente que las codifique.
 */
export function plainText(value: string): string {
  return value.replace(/\p{Cc}+/gu, ' ').trim();
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
            Aceptá la invitación y elegí tu contraseña. El enlace vence en ${ttlDays} días.
          </p>
          <a href="${href}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">
            Aceptar invitación
          </a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">
            Si no esperabas esta invitación, ignorá este correo.<br>
            <span style="color:#4f46e5;word-break:break-all">${href}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
