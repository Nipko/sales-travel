import { Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { SecurityNoticeService } from '../mail/security-notice.service.js';
import {
  decryptCredentials,
  encryptCredentials,
} from '../provider-credentials/credentials-cipher.js';
import {
  MfaAlreadyEnabledError,
  MfaCodeRejectedError,
  MfaNoPendingEnrollmentError,
  MfaNotEnabledError,
  MfaPasswordInvalidError,
  MfaPasswordRequiredError,
  MfaReauthInvalidError,
  MfaReauthLockedError,
  MfaRequiredByRoleError,
  SessionInvalidError,
} from './auth-errors.js';
import { LOCKOUT_MINUTES, LoginAttemptsService } from './login-attempts.service.js';
import {
  RECOVERY_CODE_COUNT,
  classifyMfaCode,
  formatRecoveryCode,
  generateRecoveryCode,
} from './mfa-codes.js';
import { PasswordService } from './password.service.js';
import { MFA_REQUIRED_ROLES } from './roles.js';
import { TotpService } from './totp.service.js';

export interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
}

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
  /** El usuario tiene un rol que exige MFA: no lo puede desactivar y el panel lo obliga a activarlo. */
  required: boolean;
  /** Hay un secreto esperando confirmación (enrolamiento o "cambiar de teléfono" a medio hacer). */
  pendingEnrollment: boolean;
}

/**
 * MFA TOTP. CLAUDE.md lo declara requisito no negociable para tenant_admin y superiores.
 *
 * El secreto se guarda cifrado con AES-256-GCM reutilizando la misma clave maestra fuera
 * de la base que protege las credenciales BYOC: si se filtra un dump de Postgres, los
 * secretos TOTP no son utilizables.
 *
 * Todo canje es atómico: el paso TOTP se reclama con un UPDATE condicional (0 filas = replay) y un
 * código de recuperación con `used_at IS NULL`. Leer, verificar y después escribir dejaba pasar el
 * mismo código dos veces en paralelo (un proxy de phishing reenviándolo junto con la víctima).
 */
@Injectable()
export class MfaService {
  /** Hash bcrypt de relleno (memoizado): sin contraseña guardada igual se paga un bcrypt.compare. */
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly totp: TotpService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptsService,
    private readonly notices: SecurityNoticeService,
  ) {}

  /** ¿Algún rol activo del usuario exige MFA? Sigue a la persona, no al tenant activo. */
  async isRequiredFor(userId: string): Promise<boolean> {
    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('role', 'in', [...MFA_REQUIRED_ROLES])
        .limit(1)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  async status(userId: string): Promise<MfaStatus> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['mfa_enabled_at', 'mfa_pending_secret'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('user not found');

    const remaining = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('mfa_recovery_codes')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .executeTakeFirst(),
    );

    return {
      enabled: user.mfa_enabled_at !== null,
      recoveryCodesRemaining: Number(remaining?.count ?? 0),
      required: await this.isRequiredFor(userId),
      pendingEnrollment: user.mfa_pending_secret !== null,
    };
  }

  /**
   * Paso 1 del enrolamiento: genera un secreto y lo deja PENDIENTE. El activo no se toca hasta que
   * confirmEnrollment verifica un código contra el nuevo, así nadie se autobloquea por escanear mal
   * el QR.
   *
   * Con MFA ya activo esto es "cambiar de teléfono" y exige la contraseña y un código vigente:
   * antes cualquier sesión (una robada, por ejemplo) apagaba el MFA activo con sólo llamar acá.
   * La primera vez no pide nada: un secreto pendiente no protege ni abre nada, y la contraseña se
   * pide al confirmarlo (USR-13b).
   */
  async beginEnrollment(
    userId: string,
    email: string,
    reauth: { currentPassword?: string; code?: string } = {},
  ): Promise<MfaEnrollment> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['mfa_enabled_at', 'password_hash'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('user not found');

    const rotation = user.mfa_enabled_at !== null;
    if (rotation) {
      const { currentPassword, code } = reauth;
      if (!currentPassword || !code) throw new MfaAlreadyEnabledError();
      const hash = user.password_hash;
      const ok = await this.withLockout(userId, 'rotation', async () => {
        if (hash === null || !(await this.password.verify(currentPassword, hash))) return false;
        // La contraseña primero: con una mala no se gasta el paso TOTP del usuario.
        return this.verifyTotp(userId, code);
      });
      if (!ok) throw new MfaReauthInvalidError();
    }

    // Sólo si la cuenta sigue como se leyó. Si no, un paso 1 sin contraseña que leyó la cuenta sin
    // 2FA y escribió después de que la persona lo activó dejaba un pendiente "de cambio de teléfono"
    // que confirmEnrollment activa sin contraseña ni código de la app de la persona (USR-13b).
    const secret = this.totp.generateSecret();
    const written = await this.db.db
      .updateTable('users')
      .set({ mfa_pending_secret: encryptCredentials(secret).toString('base64') })
      .where('id', '=', userId)
      .where('mfa_enabled_at', rotation ? 'is not' : 'is', null)
      .executeTakeFirst();
    if (written.numUpdatedRows === 0n) {
      throw rotation ? new MfaNotEnabledError() : new MfaAlreadyEnabledError();
    }

    await this.audit.emit({
      eventType: 'auth.mfa.enrollment_started',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { rotation },
    });

    return { secret, otpauthUri: this.totp.buildUri(secret, email) };
  }

  /**
   * Paso 2: verifica un código contra el secreto PENDIENTE, lo activa y entrega códigos de
   * recuperación nuevos. La sesión actual queda verificada con MFA; las demás del usuario (abiertas
   * sin segundo factor, o con el teléfono anterior) y sus equipos de confianza se cierran.
   *
   * La primera activación (también la que sigue a un restablecimiento hecho por un admin) pide la
   * contraseña (USR-13b). Sin eso, en una cuenta sin 2FA una sesión robada lo activaba con su propio
   * teléfono: la sesión quedaba reconfirmada para las acciones de alto impacto (USR-13), las de la
   * persona se cerraban y no llegaba ningún aviso. Se prueba como en el login: un bcrypt aunque no
   * haya contraseña guardada, y cada intento suma al bloqueo de la cuenta (withLockout, acción
   * `enroll`). Al cambiar de teléfono no: la contraseña y un código vigente ya se pidieron en
   * beginEnrollment, y `currentPassword` se ignora.
   *
   * Después le avisa a la persona por correo (USR-12): `mfa_enabled` la primera vez y
   * `mfa_changed` al cambiar de teléfono.
   */
  async confirmEnrollment(
    userId: string,
    currentSessionId: string | undefined,
    code: string,
    currentPassword?: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['mfa_pending_secret', 'mfa_enabled_at', 'mfa_last_used_step', 'password_hash'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_pending_secret) throw new MfaNoPendingEnrollmentError();

    const parsed = classifyMfaCode(code);
    if (parsed.kind !== 'totp') throw new MfaCodeRejectedError();

    const rotation = user.mfa_enabled_at !== null;
    if (!rotation) {
      // Sin contraseña no se prueba nada ni se cuenta: es un formulario incompleto, no un intento.
      if (!currentPassword) throw new MfaPasswordRequiredError();
      const hash = user.password_hash;
      const ok = await this.withLockout(userId, 'enroll', () =>
        this.passwordMatches(currentPassword, hash),
      );
      if (!ok) throw new MfaPasswordInvalidError();
    }

    const pending = decryptCredentials(Buffer.from(user.mfa_pending_secret, 'base64'));
    const step = this.totp.verify(pending, parsed.value, {
      minStep: stepOf(user.mfa_last_used_step),
    });
    // Verificar ANTES de hashear: con un código malo no se pagan los 10 bcrypt.
    if (step === null) throw new MfaCodeRejectedError();

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => this.password.hash(c)));
    const pendingCipher = user.mfa_pending_secret;

    const done = await this.db.withRequestContext({ userId }, async (trx) => {
      // Mover el pendiente y reclamar el paso en un solo UPDATE condicional: 0 filas = otro
      // request confirmó antes, el secreto cambió, el código ya se usó o la cuenta pasó a tener (o
      // dejó de tener) el 2FA desde la lectura, que es lo que decidió si hacía falta la contraseña.
      const moved = await sql<{ id: string; mfa_enabled_at: Date }>`
        UPDATE users
           SET mfa_secret         = mfa_pending_secret,
               mfa_pending_secret = NULL,
               mfa_enabled_at     = now(),
               mfa_last_used_step = ${String(step)}::bigint
         WHERE id = ${userId}::uuid
           AND mfa_pending_secret = ${pendingCipher}
           AND (mfa_enabled_at IS NOT NULL) = ${rotation}
           AND (mfa_last_used_step IS NULL OR mfa_last_used_step < ${String(step)}::bigint)
        RETURNING id, mfa_enabled_at
      `.execute(trx);
      const row = moved.rows[0];
      if (row === undefined) throw new MfaCodeRejectedError();

      await this.replaceRecoveryCodes(trx, userId, hashes);

      if (currentSessionId) {
        await trx
          .updateTable('sessions')
          .set({ mfa_verified_at: sql<Date>`now()` })
          .where('id', '=', currentSessionId)
          .where('user_id', '=', userId)
          .execute();
      }
      const revoked = await revokeOtherSessions(trx, userId, currentSessionId, 'mfa_enrolled');
      await trx
        .updateTable('trusted_devices')
        .set({ revoked_at: sql<Date>`now()` })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
      return { revokedSessions: revoked, enabledAt: row.mfa_enabled_at };
    });

    await this.audit.emit({
      eventType: 'auth.mfa.enabled',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { rotation, revokedSessions: done.revokedSessions },
    });

    // Después del commit: si no fue la persona, se entera por su propio buzón. Cambiar de teléfono
    // también avisa: pide la contraseña y un código de la app anterior, pero quien tiene las dos
    // cosas deja a la persona afuera de su propia cuenta.
    this.notices.notify(rotation ? 'mfa_changed' : 'mfa_enabled', {
      userId,
      tenantId: null,
      at: done.enabledAt,
    });

    return { recoveryCodes: codes.map(formatRecoveryCode) };
  }

  /** Códigos de recuperación nuevos; los anteriores dejan de servir. Pide un TOTP vigente. */
  async regenerateRecoveryCodes(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.db.db
      .selectFrom('users')
      .select('mfa_enabled_at')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_enabled_at) throw new MfaNotEnabledError();

    // Sólo TOTP: con un código de recuperación se podría encadenar respaldos sin el teléfono. Lo
    // que no tiene forma de TOTP se rechaza sin contar: no prueba nada contra el secreto.
    const parsed = classifyMfaCode(code);
    if (parsed.kind !== 'totp') throw new MfaCodeRejectedError();
    const value = parsed.value;
    if (!(await this.withLockout(userId, 'recovery_codes', () => this.verifyTotp(userId, value)))) {
      throw new MfaCodeRejectedError();
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => this.password.hash(c)));
    await this.db.withRequestContext({ userId }, (trx) =>
      this.replaceRecoveryCodes(trx, userId, hashes),
    );

    await this.audit.emit({
      eventType: 'auth.mfa.recovery_regenerated',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });
    return { recoveryCodes: codes.map(formatRecoveryCode) };
  }

  /**
   * Reconfirma el segundo factor de ESTA sesión (POST /auth/step-up) antes de una acción de alto
   * impacto (USR-13): con un TOTP vigente, `sessions.mfa_verified_at` pasa a ahora y la ventana de
   * RECENT_MFA_WINDOW_MINUTES vuelve a empezar. Sólo esta sesión: las demás del usuario no cambian.
   *
   * Sólo TOTP, como regenerar los códigos: un código de recuperación se gasta y, si se perdió el
   * teléfono, el camino es volver a ingresar con uno. Cada intento suma al bloqueo de la cuenta
   * (withLockout), igual que en el login: si no, sería un oráculo del TOTP con una sesión robada.
   * Lo que no tiene forma de TOTP se rechaza sin contar. Sin 2FA activo: 409 MFA_NOT_ENABLED.
   */
  async stepUp(userId: string, sessionId: string, code: string): Promise<{ verifiedAt: Date }> {
    const user = await this.db.db
      .selectFrom('users')
      .select('mfa_enabled_at')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_enabled_at) throw new MfaNotEnabledError();

    const parsed = classifyMfaCode(code);
    if (parsed.kind !== 'totp') throw new MfaCodeRejectedError();
    const value = parsed.value;
    if (!(await this.withLockout(userId, 'step_up', () => this.verifyTotp(userId, value)))) {
      throw new MfaCodeRejectedError();
    }

    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .updateTable('sessions')
        .set({ mfa_verified_at: sql<Date>`now()` })
        .where('id', '=', sessionId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning('mfa_verified_at')
        .executeTakeFirst(),
    );
    // La sesión se cerró entre la validación del request y acá (otro dispositivo, un admin).
    if (!row?.mfa_verified_at) throw new SessionInvalidError('SESSION_REVOKED');

    await this.audit.emit({
      eventType: 'auth.mfa.step_up',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { sessionId },
    });
    return { verifiedAt: row.mfa_verified_at };
  }

  /**
   * Verifica el segundo factor del login: un TOTP (6 dígitos) o un código de recuperación (10 hex,
   * con o sin guion). Cada forma se prueba sólo como lo que es. Devuelve false sin lanzar: el
   * llamador decide el mensaje.
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const parsed = classifyMfaCode(code);
    if (parsed.kind === 'totp') return this.verifyTotp(userId, parsed.value);
    if (parsed.kind === 'recovery') return this.consumeRecoveryCode(userId, parsed.value);
    return false;
  }

  /** TOTP contra el secreto ACTIVO, reclamando el paso de forma atómica. */
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['mfa_secret', 'mfa_enabled_at', 'mfa_last_used_step'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_secret || !user.mfa_enabled_at) return false;

    const secret = decryptCredentials(Buffer.from(user.mfa_secret, 'base64'));
    const step = this.totp.verify(secret, code, { minStep: stepOf(user.mfa_last_used_step) });
    if (step === null) return false;

    const claimed = await sql<{ id: string }>`
      UPDATE users
         SET mfa_last_used_step = ${String(step)}::bigint
       WHERE id = ${userId}::uuid
         AND (mfa_last_used_step IS NULL OR mfa_last_used_step < ${String(step)}::bigint)
      RETURNING id
    `.execute(this.db.db);
    return claimed.rows.length === 1;
  }

  /** `normalized`: 10 hex en mayúscula, sin guion (ver classifyMfaCode). */
  async consumeRecoveryCode(userId: string, normalized: string): Promise<boolean> {
    const candidates = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('mfa_recovery_codes')
        .select(['id', 'code_hash'])
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .execute(),
    );

    for (const candidate of candidates) {
      if (!(await this.password.verify(normalized, candidate.code_hash))) continue;
      const claimed = await this.db.withRequestContext({ userId }, (trx) =>
        trx
          .updateTable('mfa_recovery_codes')
          .set({ used_at: new Date() })
          .where('id', '=', candidate.id)
          .where('used_at', 'is', null)
          .returning('id')
          .executeTakeFirst(),
      );
      // Otro request lo canjeó entre la lectura y acá: el código ya no sirve.
      if (!claimed) return false;
      await this.audit.emit({
        eventType: 'auth.mfa.recovery_code_used',
        actorUserId: userId,
        aggregateType: 'user',
        aggregateId: userId,
        payload: { remaining: candidates.length - 1 },
      });
      return true;
    }
    return false;
  }

  /**
   * Desactiva MFA. Exige la contraseña actual y un código: si no, una sesión secuestrada podría
   * quitar el segundo factor sin más. No se puede con un rol que lo exige. Cierra las demás
   * sesiones y los equipos de confianza; la actual sigue. Después le avisa a la persona por correo
   * (`mfa_disabled`): si no fue ella, su cuenta quedó con la contraseña sola.
   */
  async disable(
    userId: string,
    currentSessionId: string | undefined,
    currentPassword: string,
    code: string,
  ): Promise<{ ok: true }> {
    if (await this.isRequiredFor(userId)) throw new MfaRequiredByRoleError();

    const user = await this.db.db
      .selectFrom('users')
      .select(['password_hash', 'mfa_enabled_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_enabled_at) throw new MfaNotEnabledError();
    const hash = user.password_hash;
    const ok = await this.withLockout(userId, 'disable', async () => {
      if (hash === null || !(await this.password.verify(currentPassword, hash))) return false;
      return this.verifyCode(userId, code);
    });
    if (!ok) throw new MfaReauthInvalidError();

    const revokedSessions = await this.db.withRequestContext({ userId }, async (trx) => {
      await trx
        .updateTable('users')
        .set({
          mfa_secret: null,
          mfa_pending_secret: null,
          mfa_enabled_at: null,
          mfa_last_used_step: null,
        })
        .where('id', '=', userId)
        .execute();
      await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
      await trx
        .updateTable('trusted_devices')
        .set({ revoked_at: sql<Date>`now()` })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
      return revokeOtherSessions(trx, userId, currentSessionId, 'mfa_disabled');
    });

    await this.audit.emit({
      eventType: 'auth.mfa.disabled',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { revokedSessions },
    });
    this.notices.notify('mfa_disabled', { userId, tenantId: null, at: new Date() });
    return { ok: true };
  }

  /**
   * Prueba la contraseña y/o el código de una operación sensible DENTRO de una sesión con el mismo
   * bloqueo que el login: el intento se cuenta como fallo antes de verificar (reserva atómica, ver
   * LoginAttemptsService.reserve) y un acierto limpia el contador, igual que en el login.
   *
   * Sin esto regenerar códigos, cambiar de teléfono y desactivar eran un oráculo del segundo factor
   * limitado sólo por el throttle por IP: con una sesión robada y muchas IP se probaban códigos sin
   * tope por cuenta, mientras que en el login son 5 cada 15 minutos. Cuenta bloqueada, o bloqueada
   * por este fallo: 429 MFA_ACCOUNT_LOCKED. Otro fallo: false, y el llamador elige el error.
   */
  private async withLockout(
    userId: string,
    action: 'rotation' | 'recovery_codes' | 'disable' | 'step_up' | 'enroll',
    check: () => Promise<boolean>,
  ): Promise<boolean> {
    const reserved = await this.attempts.reserve(userId);
    if (!reserved) throw new MfaReauthLockedError(LOCKOUT_MINUTES);
    if (await check()) {
      await this.attempts.clearFailures(userId);
      return true;
    }
    await this.audit.emit({
      eventType: 'auth.mfa.reauth_failed',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { action, locked: reserved.locked },
    });
    if (reserved.locked) throw new MfaReauthLockedError(LOCKOUT_MINUTES);
    return false;
  }

  /**
   * La contraseña contra su hash con el mismo cuidado que el login: sin contraseña guardada igual se
   * corre un bcrypt.compare (contra un hash de relleno), así el tiempo de respuesta no dice si la
   * cuenta tiene una.
   */
  private async passwordMatches(candidate: string, hash: string | null): Promise<boolean> {
    const against =
      hash ??
      (await (this.dummyHashPromise ??= this.password.hash('timing-guard-not-a-real-credential')));
    const ok = await this.password.verify(candidate, against);
    return hash !== null && ok;
  }

  private async replaceRecoveryCodes(
    trx: Transaction<DB>,
    userId: string,
    hashes: string[],
  ): Promise<void> {
    // Regeneración en bloque: los códigos previos dejan de servir.
    await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    await trx
      .insertInto('mfa_recovery_codes')
      .values(hashes.map((h) => ({ user_id: userId, code_hash: h })))
      .execute();
  }
}

function stepOf(stored: string | null): number | undefined {
  return stored === null ? undefined : Number(stored);
}

/** Cierra las sesiones vivas del usuario salvo `keep`. Corre con el usuario fijado (RLS). */
async function revokeOtherSessions(
  trx: Transaction<DB>,
  userId: string,
  keep: string | undefined,
  reason: string,
): Promise<number> {
  let query = trx
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null);
  if (keep) query = query.where('id', '<>', keep);
  const rows = await query.returning('id').execute();
  return rows.length;
}
