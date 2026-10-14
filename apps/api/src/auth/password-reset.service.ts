import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { mailNodeOf } from '../mail/mail-node.js';
import { MailerService } from '../mail/mailer.service.js';
import { SecurityNoticeService } from '../mail/security-notice.service.js';
import { currentContext } from '../request-context/request-context.js';
import { PasswordReuseError } from './auth-errors.js';
import { passwordResetEmail, type ResetEmailVariant } from './password-reset-email.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/** Minutos de vida de un enlace para restablecer la contraseña. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Con un enlace pendiente emitido hace menos que esto, intentar ingresar con la marca de "elegir una
 * contraseña nueva" no envía otro: así el login repetido no le llena el buzón a nadie.
 */
export const REQUIRED_RESET_RESEND_MINUTES = 10;

/** Motivo con que quedan revocadas las sesiones cuando un admin fuerza el cambio de contraseña. */
export const REVOKED_PASSWORD_RESET_REQUIRED = 'password_reset_required';

/** Un enlace recién emitido. El token en claro sólo sirve para armar el correo. */
export interface IssuedResetToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Lo que dejó forzar el cambio de contraseña: el enlace para el correo y las sesiones cerradas. */
export interface RequiredReset extends IssuedResetToken {
  readonly revokedSessions: number;
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
    private readonly notices: SecurityNoticeService,
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

    const node = await mailNodeOf(this.db, user.id);

    // El resultado del envío no cambia la respuesta (seguiría siendo un oráculo): queda en la
    // auditoría para quien investigue por qué no llegó.
    const sent = await this.sendResetEmail(
      node?.tenantId ?? null,
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
   * Obliga a `targetUserId` a elegir una contraseña nueva antes de volver a ingresar: lo marca
   * (`password_reset_required_at`; si ya estaba, conserva desde cuándo), cierra todas sus sesiones,
   * deja sin efecto sus enlaces pendientes y emite uno nuevo, y lo audita. Todo en `trx`, la
   * transacción del llamador: la marca sin su rastro, o sin las sesiones cerradas, no debe existir.
   *
   * No autoriza ni envía el correo: el llamador decide quién puede (MemberSupportService) y envía el
   * enlace después del commit con la variante `required`. El token en claro sólo sirve para ese
   * correo.
   */
  async requireReset(
    trx: Transaction<DB>,
    params: { actorUserId: string; targetUserId: string; tenantId: string | null },
  ): Promise<RequiredReset> {
    const { actorUserId, targetUserId, tenantId } = params;
    await trx
      .updateTable('users')
      .set({ password_reset_required_at: sql<Date>`COALESCE(password_reset_required_at, now())` })
      .where('id', '=', targetUserId)
      .execute();

    const res = await sql<{ revoked: number | string }>`
      SELECT revoke_user_sessions(${targetUserId}::uuid, ${REVOKED_PASSWORD_RESET_REQUIRED}) AS revoked
    `.execute(trx);
    const revokedSessions = Number(res.rows[0]?.revoked ?? 0);

    const { token, expiresAt } = await this.issueToken(trx, targetUserId, {
      invalidatePrevious: true,
    });

    await this.audit.emitWithin(trx, {
      eventType: 'auth.password_reset.required_by_admin',
      tenantId,
      actorUserId,
      aggregateType: 'user',
      aggregateId: targetUserId,
      payload: { targetUserId, revokedSessions },
    });
    return { token, expiresAt, revokedSessions };
  }

  /**
   * Quien tiene que elegir una contraseña nueva intentó ingresar (con la contraseña correcta): si no
   * tiene un enlace pendiente emitido en los últimos REQUIRED_RESET_RESEND_MINUTES, le envía uno. Así
   * un enlace vencido no lo deja afuera para siempre y el login repetido no le llena el buzón.
   *
   * La fila del usuario queda tomada mientras se decide: dos intentos en paralelo se ordenan y el
   * segundo ya ve el enlace del primero. No invalida los anteriores (como "Olvidé mi contraseña"): el
   * que ya tiene en el buzón sigue sirviendo. `linkSent` es si salió un correo ahora.
   */
  async remindRequiredReset(userId: string): Promise<{ linkSent: boolean }> {
    const issued = await this.db.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select(['email', 'status', 'password_reset_required_at'])
        .where('id', '=', userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!user || user.status !== 'active' || user.password_reset_required_at === null) {
        return null;
      }

      const recent = await trx
        .selectFrom('password_reset_tokens')
        .select('id')
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .where(sql<boolean>`expires_at > now()`)
        .where(
          sql<boolean>`created_at > now() - make_interval(mins => ${REQUIRED_RESET_RESEND_MINUTES})`,
        )
        .limit(1)
        .executeTakeFirst();
      if (recent) return null;

      const { token } = await this.issueToken(trx, userId, { invalidatePrevious: false });
      return { email: user.email, token };
    });
    if (issued === null) return { linkSent: false };

    const node = await mailNodeOf(this.db, userId);
    const sent = await this.sendResetEmail(
      node?.tenantId ?? null,
      issued.email,
      this.resetLink(issued.token),
      'required',
      node?.name ?? null,
    );
    if (!sent) {
      await this.audit.emit({
        eventType: 'auth.password_reset.email_failed',
        actorUserId: userId,
        aggregateType: 'user',
        aggregateId: userId,
        payload: { targetUserId: userId, via: 'required' },
      });
    }
    return { linkSent: sent };
  }

  /**
   * Canjea el token y fija la contraseña nueva. Revoca TODAS las sesiones del usuario y, por
   * `password_changed_at`, también sus equipos de confianza. Si un admin le había pedido elegir una
   * contraseña nueva, la marca se levanta en el mismo UPDATE: sirve tanto el enlace que le envió el
   * admin como el de "Olvidé mi contraseña".
   *
   * El canje es un UPDATE condicional (`used_at IS NULL`) dentro de la misma transacción que el
   * cambio: leer y después marcar dejaba que el mismo enlace sirviera dos veces en paralelo. Los
   * demás enlaces pendientes del usuario también se dan por usados.
   *
   * La fila del usuario se toma ANTES que la del enlace, en el mismo orden que forzar el cambio y
   * enviar el enlace desde Equipo (usuario → enlaces). Al revés, un canje en paralelo con "Forzar
   * cambio de contraseña" se trababa con él (deadlock) y uno de los dos terminaba en 500.
   *
   * Con el cambio forzado pendiente, la contraseña nueva no puede ser la misma de antes
   * (PasswordReuseError): el admin lo forzó porque pudo quedar expuesta. El rollback deja el enlace
   * vigente para elegir otra.
   *
   * Hecho el cambio, le avisa a su correo que la contraseña cambió (`password_changed`): si no fue
   * ella, se entera por su buzón y no por el próximo ingreso fallido.
   */
  async reset(token: string, newPassword: string): Promise<{ ok: true }> {
    const hash = await this.password.hash(newPassword);
    const now = new Date();
    const tokenHash = sha256(token);

    const userId = await this.db.db.transaction().execute(async (trx) => {
      const owner = await trx
        .selectFrom('password_reset_tokens')
        .select('user_id')
        .where('token_hash', '=', tokenHash)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .executeTakeFirst();
      if (!owner) {
        throw new BadRequestException('el enlace de restablecimiento es inválido o venció');
      }
      const user = await trx
        .selectFrom('users')
        .select(['password_hash', 'password_reset_required_at'])
        .where('id', '=', owner.user_id)
        .forNoKeyUpdate()
        .executeTakeFirst();

      const row = await trx
        .updateTable('password_reset_tokens')
        .set({ used_at: now })
        .where('token_hash', '=', tokenHash)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .returning('user_id')
        .executeTakeFirst();
      if (!row) {
        throw new BadRequestException('el enlace de restablecimiento es inválido o venció');
      }

      if (
        user?.password_reset_required_at &&
        user.password_hash &&
        (await this.password.verify(newPassword, user.password_hash))
      ) {
        throw new PasswordReuseError();
      }

      await trx
        .updateTable('users')
        .set({
          password_hash: hash,
          password_changed_at: now,
          // Un reset exitoso también levanta el lockout: el dueño legítimo recuperó la cuenta.
          failed_login_attempts: 0,
          locked_until: null,
          password_reset_required_at: null,
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
    this.notices.notify('password_changed', { userId, tenantId: null });

    return { ok: true };
  }

  /**
   * Cambio de contraseña autenticado. Revoca TODAS las sesiones (y, por `password_changed_at`, los
   * equipos de confianza) y levanta la marca de "elegir una contraseña nueva" si la tenía. El
   * dispositivo actual sigue porque el controlador le emite una sesión nueva
   * (AuthService.reissueAfterPasswordChange): antes esto prometía conservar la actual y la mataba
   * igual. Hecho el cambio, le avisa a su correo, como el canje del enlace.
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
        password_reset_required_at: null,
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
    this.notices.notify('password_changed', { userId, tenantId: null });

    return { ok: true };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
