import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { MailerService } from '../mail/mailer.service.js';
import { currentContext } from '../request-context/request-context.js';
import { passwordResetEmail, type ResetEmailVariant } from './password-reset-email.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/** Minutos de vida de un enlace para restablecer la contraseña. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/** Un enlace recién emitido. El token en claro sólo sirve para armar el correo. */
export interface IssuedResetToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Recuperación y cambio de contraseña.
 *
 * Antes no existía ninguno de los dos: un usuario bloqueado sólo podía recuperarse
 * pidiéndole a un admin que le fijara una contraseña nueva —que por tanto el admin
 * conocía—, y no había forma de invalidar sesiones tras un cambio.
 *
 * Del token sólo se persiste su SHA-256; el valor en claro viaja una única vez por email, y nunca
 * en una respuesta: tampoco cuando lo pide un admin desde Equipo (MemberSupportService), que no ve
 * ni el enlace ni la contraseña.
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

    const { token } = await this.issueToken(this.db.db, user.id, { invalidatePrevious: false });

    const tenant = await this.db.db
      .selectFrom('memberships')
      .select('tenant_id')
      .where('user_id', '=', user.id)
      .where('status', '=', 'active')
      .orderBy('created_at')
      .executeTakeFirst();

    // El resultado del envío no cambia la respuesta (seguiría siendo un oráculo): queda en la
    // auditoría para quien investigue por qué no llegó.
    const sent = await this.sendResetEmail(
      tenant?.tenant_id ?? null,
      email,
      this.resetLink(token),
      'self',
    );

    await this.audit.emit({
      eventType: 'auth.password_reset.requested',
      actorUserId: user.id,
      aggregateType: 'user',
      aggregateId: user.id,
    });
    if (!sent) {
      await this.audit.emit({
        eventType: 'auth.password_reset.email_failed',
        actorUserId: user.id,
        aggregateType: 'user',
        aggregateId: user.id,
        payload: { targetUserId: user.id, via: 'self' },
      });
    }

    return { sent: true };
  }

  /**
   * Emite un enlace de un solo uso para `userId`: guarda sólo el SHA-256 del token, que vence a los
   * RESET_TOKEN_TTL_MINUTES. Con `invalidatePrevious`, antes da por usados los enlaces pendientes del
   * usuario, así sólo vale el último que se envió.
   *
   * `executor`: la transacción del llamador cuando el enlace tiene que quedar junto con su rastro de
   * auditoría (el que envía un admin).
   */
  async issueToken(
    executor: Kysely<DB>,
    userId: string,
    opts: { invalidatePrevious: boolean },
  ): Promise<IssuedResetToken> {
    if (opts.invalidatePrevious) {
      await executor
        .updateTable('password_reset_tokens')
        .set({ used_at: new Date() })
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .execute();
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000);
    await executor
      .insertInto('password_reset_tokens')
      .values({
        user_id: userId,
        token_hash: sha256(token),
        expires_at: expiresAt,
        requested_ip: currentContext()?.ip ?? null,
      })
      .execute();
    return { token, expiresAt };
  }

  /** El enlace de la página que canjea el token (/restablecer del panel). */
  resetLink(token: string): string {
    const base = process.env['APP_WEB_URL'] ?? 'https://app.planetour.cloud';
    return `${base}/restablecer?token=${encodeURIComponent(token)}`;
  }

  /**
   * Envía el correo con el enlace por el correo del nodo (propio o heredado) o el del sistema.
   * Devuelve si salió; nunca lanza (MailerService.sendToTenant tampoco).
   */
  sendResetEmail(
    tenantId: string | null,
    email: string,
    link: string,
    variant: ResetEmailVariant,
    nodeName?: string | null,
  ): Promise<boolean> {
    return this.mailer.sendToTenant(tenantId, {
      to: email,
      ...passwordResetEmail(variant, link, RESET_TOKEN_TTL_MINUTES, nodeName),
    });
  }

  /**
   * Canjea el token y fija la contraseña nueva. Revoca TODAS las sesiones del usuario y, por
   * `password_changed_at`, también sus equipos de confianza.
   *
   * El canje es un UPDATE condicional (`used_at IS NULL`) dentro de la misma transacción que el
   * cambio: leer y después marcar dejaba que el mismo enlace sirviera dos veces en paralelo. Los
   * demás enlaces pendientes del usuario también se dan por usados.
   */
  async reset(token: string, newPassword: string): Promise<{ ok: true }> {
    const hash = await this.password.hash(newPassword);
    const now = new Date();

    const userId = await this.db.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('password_reset_tokens')
        .set({ used_at: now })
        .where('token_hash', '=', sha256(token))
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .returning('user_id')
        .executeTakeFirst();
      if (!row) {
        throw new BadRequestException('el enlace de restablecimiento es inválido o venció');
      }

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
        .where('user_id', '=', row.user_id)
        .where('used_at', 'is', null)
        .execute();
      return row.user_id;
    });

    // Quien haya entrado con la contraseña vieja queda fuera de inmediato.
    await this.sessions.revokeAllForUser(userId, 'password_reset');

    await this.audit.emit({
      eventType: 'auth.password_reset.completed',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });

    return { ok: true };
  }

  /**
   * Cambio de contraseña autenticado. Revoca TODAS las sesiones (y, por `password_changed_at`, los
   * equipos de confianza). El dispositivo actual sigue porque el controlador le emite una sesión
   * nueva (AuthService.reissueAfterPasswordChange): antes esto prometía conservar la actual y la
   * mataba igual.
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
