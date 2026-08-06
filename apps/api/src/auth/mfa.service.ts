import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  decryptCredentials,
  encryptCredentials,
} from '../provider-credentials/credentials-cipher.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';

const RECOVERY_CODE_COUNT = 10;

export interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
}

/**
 * MFA TOTP. CLAUDE.md lo declara requisito no negociable para tenant_admin y superiores.
 *
 * El secreto se guarda cifrado con AES-256-GCM reutilizando la misma clave maestra fuera
 * de la base que protege las credenciales BYOC: si se filtra un dump de Postgres, los
 * secretos TOTP no son utilizables.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly totp: TotpService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async status(userId: string): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
    const user = await this.db.db
      .selectFrom('users')
      .select('mfa_enabled_at')
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
    };
  }

  /**
   * Paso 1 del enrolamiento: genera y guarda el secreto, pero NO activa MFA todavía.
   * Se activa recién en confirmEnrollment, cuando el usuario demuestra que su
   * authenticator produce códigos válidos — así nadie se autobloquea por escanear mal el QR.
   */
  async beginEnrollment(userId: string, email: string): Promise<MfaEnrollment> {
    const secret = this.totp.generateSecret();
    await this.db.db
      .updateTable('users')
      .set({ mfa_secret: encryptCredentials(secret).toString('base64'), mfa_enabled_at: null })
      .where('id', '=', userId)
      .execute();

    return { secret, otpauthUri: this.totp.buildUri(secret, email) };
  }

  /** Paso 2: verifica el primer código, activa MFA y entrega los códigos de recuperación. */
  async confirmEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const secret = await this.loadSecret(userId);
    if (!secret) throw new BadRequestException('no hay un enrolamiento MFA en curso');

    const step = this.totp.verify(secret, code);
    if (step === null) throw new BadRequestException('código MFA inválido');

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      randomBytes(5).toString('hex').toUpperCase(),
    );
    const hashes = await Promise.all(recoveryCodes.map((c) => this.password.hash(c)));

    await this.db.withRequestContext({ userId }, async (trx) => {
      await trx
        .updateTable('users')
        .set({ mfa_enabled_at: new Date(), mfa_last_used_step: String(step) })
        .where('id', '=', userId)
        .execute();
      // Regeneración en bloque: los códigos previos dejan de servir.
      await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
      await trx
        .insertInto('mfa_recovery_codes')
        .values(hashes.map((h) => ({ user_id: userId, code_hash: h })))
        .execute();
    });

    await this.audit.emit({
      eventType: 'auth.mfa.enabled',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });

    return { recoveryCodes };
  }

  /**
   * Verifica un código en el login. Acepta tanto un TOTP como un código de recuperación.
   * Devuelve false sin lanzar: el llamador decide el mensaje (anti-enumeración).
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const user = await this.db.db
      .selectFrom('users')
      .select(['mfa_secret', 'mfa_enabled_at', 'mfa_last_used_step'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_secret || !user.mfa_enabled_at) return false;

    const secret = decryptCredentials(Buffer.from(user.mfa_secret, 'base64'));
    const minStep = user.mfa_last_used_step ? Number(user.mfa_last_used_step) : undefined;
    const step = this.totp.verify(secret, code, { minStep });

    if (step !== null) {
      // Persistir el paso consumido cierra la ventana de replay de 30s.
      await this.db.db
        .updateTable('users')
        .set({ mfa_last_used_step: String(step) })
        .where('id', '=', userId)
        .execute();
      return true;
    }

    return this.consumeRecoveryCode(userId, code);
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const normalized = code.replace(/\s+/g, '').toUpperCase();
    const candidates = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('mfa_recovery_codes')
        .select(['id', 'code_hash'])
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .execute(),
    );

    for (const candidate of candidates) {
      if (await this.password.verify(normalized, candidate.code_hash)) {
        await this.db.withRequestContext({ userId }, (trx) =>
          trx
            .updateTable('mfa_recovery_codes')
            .set({ used_at: new Date() })
            .where('id', '=', candidate.id)
            .execute(),
        );
        await this.audit.emit({
          eventType: 'auth.mfa.recovery_code_used',
          actorUserId: userId,
          aggregateType: 'user',
          aggregateId: userId,
          payload: { remaining: candidates.length - 1 },
        });
        return true;
      }
    }
    return false;
  }

  /**
   * Desactiva MFA. Exige la contraseña actual: si no, una sesión secuestrada podría
   * quitar el segundo factor sin más. Revoca las demás sesiones por si acaso.
   */
  async disable(userId: string, currentPassword: string): Promise<{ ok: true }> {
    const user = await this.db.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (
      !user?.password_hash ||
      !(await this.password.verify(currentPassword, user.password_hash))
    ) {
      throw new BadRequestException('contraseña incorrecta');
    }

    await this.db.withRequestContext({ userId }, async (trx) => {
      await trx
        .updateTable('users')
        .set({ mfa_secret: null, mfa_enabled_at: null, mfa_last_used_step: null })
        .where('id', '=', userId)
        .execute();
      await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    });

    await this.sessions.revokeAllForUser(userId, 'mfa_disabled');
    await this.audit.emit({
      eventType: 'auth.mfa.disabled',
      actorUserId: userId,
      aggregateType: 'user',
      aggregateId: userId,
    });
    return { ok: true };
  }

  private async loadSecret(userId: string): Promise<string | null> {
    const user = await this.db.db
      .selectFrom('users')
      .select('mfa_secret')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.mfa_secret) return null;
    return decryptCredentials(Buffer.from(user.mfa_secret, 'base64'));
  }
}
