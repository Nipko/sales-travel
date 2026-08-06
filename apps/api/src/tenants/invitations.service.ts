import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { Role } from '../database/database.types.js';
import { DatabaseService } from '../database/database.service.js';
import { MailerService } from '../mail/mailer.service.js';

const INVITE_TTL_DAYS = 7;

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  invitedByEmail: string | null;
  expiresAt: Date;
  createdAt: Date;
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

    const tenant = await this.db.db
      .selectFrom('tenants')
      .select('name')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    const base = process.env['APP_WEB_URL'] ?? 'https://app.planetour.cloud';
    const link = `${base}/invitacion?token=${encodeURIComponent(token)}`;

    try {
      await this.mailer.sendToTenant(tenantId, {
        to: email,
        subject: `Te invitaron a ${tenant?.name ?? 'la plataforma'}`,
        html: invitationEmailHtml(link, tenant?.name ?? 'la plataforma', INVITE_TTL_DAYS),
        text: `Te invitaron a ${tenant?.name ?? 'la plataforma'}. Aceptá la invitación acá (vence en ${INVITE_TTL_DAYS} días): ${link}`,
      });
    } catch {
      // Best-effort: la invitación queda creada y se puede reenviar.
    }

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
   * Canje de la invitación. Es PRE-AUTENTICACIÓN, así que la RLS por subárbol no puede
   * aplicar: se resuelve con find_pending_invitation() (SECURITY DEFINER acotado, 0028),
   * que devuelve como máximo una fila por hash de token y no permite enumerar.
   */
  async accept(params: {
    token: string;
    name: string;
    password: string;
  }): Promise<{ userId: string; tenantId: string }> {
    const found = await sql<{
      id: string;
      tenant_id: string;
      email: string;
      role: Role;
    }>`SELECT * FROM find_pending_invitation(${sha256(params.token)})`.execute(this.db.db);

    const invitation = found.rows[0];
    if (!invitation) throw new BadRequestException('la invitación es inválida o venció');

    const hash = await this.password.hash(params.password);

    const userId = await this.db.db.transaction().execute(async (trx) => {
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
            name: params.name,
            password_hash: hash,
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
    });

    await sql`SELECT accept_invitation(${invitation.id}::uuid)`.execute(this.db.db);

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
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invitationEmailHtml(link: string, tenantName: string, ttlDays: number): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#18181b">Te invitaron a ${tenantName}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#52525b">
            Aceptá la invitación y elegí tu contraseña. El enlace vence en ${ttlDays} días.
          </p>
          <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">
            Aceptar invitación
          </a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">
            Si no esperabas esta invitación, ignorá este correo.<br>
            <span style="color:#4f46e5;word-break:break-all">${link}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
