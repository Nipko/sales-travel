import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { currentContext } from '../request-context/request-context.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

const TOKEN_TTL_MINUTES = 60;

/**
 * Recuperación y cambio de contraseña.
 *
 * Antes no existía ninguno de los dos: un usuario bloqueado sólo podía recuperarse
 * pidiéndole a un admin que le fijara una contraseña nueva —que por tanto el admin
 * conocía—, y no había forma de invalidar sesiones tras un cambio.
 *
 * Del token sólo se persiste su SHA-256; el valor en claro viaja una única vez por email.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Solicita un reset. SIEMPRE responde lo mismo exista o no la cuenta: de lo contrario
   * el endpoint sería un oráculo de enumeración de emails de toda la red.
   */
  async request(email: string): Promise<{ sent: true }> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['id', 'status'])
      .where('email', '=', email)
      .executeTakeFirst();

    if (!user || user.status !== 'active') return { sent: true };

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

    await this.db.db
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: sha256(token),
        expires_at: expiresAt,
        requested_ip: currentContext()?.ip ?? null,
      })
      .execute();

    const tenant = await this.db.db
      .selectFrom('memberships')
      .select('tenant_id')
      .where('user_id', '=', user.id)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .executeTakeFirst();

    const base = process.env['APP_WEB_URL'] ?? 'https://app.planetour.cloud';
    const link = `${base}/restablecer?token=${encodeURIComponent(token)}`;

    try {
      await this.mailer.sendToTenant(tenant?.tenant_id ?? null, {
        to: email,
        subject: 'Restablecé tu contraseña · PlaneTour',
        html: resetEmailHtml(link, TOKEN_TTL_MINUTES),
        text: `Restablecé tu contraseña entrando a este enlace (vence en ${TOKEN_TTL_MINUTES} minutos): ${link}`,
      });
    } catch {
      // Best-effort: no revelamos fallos de envío al cliente (seguiría siendo un oráculo).
    }

    await this.audit.emit({
      eventType: 'auth.password_reset.requested',
      actorUserId: user.id,
      aggregateType: 'user',
      aggregateId: user.id,
    });

    return { sent: true };
  }

  /** Canjea el token y fija la contraseña nueva. Revoca TODAS las sesiones del usuario. */
  async reset(token: string, newPassword: string): Promise<{ ok: true }> {
    const row = await this.db.db
      .selectFrom('password_reset_tokens')
      .select(['id', 'user_id', 'expires_at', 'used_at'])
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();

    if (!row || row.used_at !== null || row.expires_at.getTime() <= Date.now()) {
      throw new BadRequestException('el enlace de restablecimiento es inválido o venció');
    }

    const hash = await this.password.hash(newPassword);
    const now = new Date();

    await this.db.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({
          password_hash: hash,
          password_changed_at: now,
          // Un reset exitoso también levanta el lockout: el dueño legítimo recuperó la cuenta.
          failed_login_attempts: 0,
          locked_until: null,
        })
        .where('id', '=', row.user_id)
        .execute();
      await trx
        .updateTable('password_reset_tokens')
        .set({ used_at: now })
        .where('id', '=', row.id)
        .execute();
    });

    // Quien haya entrado con la contraseña vieja queda fuera de inmediato.
    await this.sessions.revokeAllForUser(row.user_id, 'password_reset');

    await this.audit.emit({
      eventType: 'auth.password_reset.completed',
      actorUserId: row.user_id,
      aggregateType: 'user',
      aggregateId: row.user_id,
    });

    return { ok: true };
  }

  /**
   * Cambio de contraseña autenticado. Revoca las demás sesiones pero conserva la actual,
   * para no echar al usuario del panel justo después de cambiarla.
   */
  async change(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const user = await this.db.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', userId)
      .executeTakeFirst();

    if (
      !user?.password_hash ||
      !(await this.password.verify(currentPassword, user.password_hash))
    ) {
      throw new UnauthorizedException('la contraseña actual no es correcta');
    }
    if (await this.password.verify(newPassword, user.password_hash)) {
      throw new BadRequestException('la contraseña nueva debe ser distinta de la actual');
    }

    await this.db.db
      .updateTable('users')
      .set({
        password_hash: await this.password.hash(newPassword),
        password_changed_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();

    await this.sessions.revokeAllForUser(userId, 'password_changed');

    await this.audit.emit({
      eventType: 'auth.password_changed',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });

    return { ok: true };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resetEmailHtml(link: string, ttlMinutes: number): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#18181b">Restablecé tu contraseña</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#52525b">
            Recibimos un pedido para cambiar tu contraseña. El enlace vence en ${ttlMinutes} minutos.
          </p>
          <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">
            Elegir contraseña nueva
          </a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">
            Si no pediste esto, ignorá este correo: tu contraseña no cambia.<br>
            <span style="color:#4f46e5;word-break:break-all">${link}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
