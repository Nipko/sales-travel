import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { DatabaseService } from '../database/database.service.js';

/** "Recordar este equipo por 30 días" (decisión del founder, igual para todos los roles). */
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Un token en claro de más de esto no es nuestro: ni se hashea. */
const MAX_TOKEN_LENGTH = 512;

export interface TrustedDeviceView {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  /** Es el equipo desde el que se pide el listado (cookie `st_trusted` del panel). */
  current: boolean;
}

interface DeviceState {
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface OwnerState {
  passwordChangedAt: Date | null;
  mfaEnabledAt: Date | null;
}

/** sha256 hex en minúscula: lo único que se guarda (y lo único que acepta la base). */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * ¿Sigue valiendo el equipo? No revocado, no vencido y posterior al último cambio de contraseña y
 * al último enrolamiento de MFA. Así un cambio de contraseña o un "cambiar de teléfono" invalidan
 * todos los equipos sin barrer la tabla.
 */
export function trustedDeviceUsable(device: DeviceState, owner: OwnerState, now: Date): boolean {
  if (device.revokedAt !== null) return false;
  if (device.expiresAt.getTime() <= now.getTime()) return false;
  if (owner.passwordChangedAt && device.createdAt.getTime() <= owner.passwordChangedAt.getTime()) {
    return false;
  }
  if (owner.mfaEnabledAt && device.createdAt.getTime() <= owner.mfaEnabledAt.getTime()) {
    return false;
  }
  return true;
}

/**
 * Equipos de confianza: con uno válido, el login de un usuario con MFA no pide el código.
 *
 * El token en claro vive sólo en la cookie httpOnly `st_trusted` del panel; acá se guarda su
 * sha256. Todas las consultas van con el usuario fijado (RLS `trusted_devices_self`): en el login
 * la contraseña ya se verificó, así que un token robado de OTRA persona no encuentra fila.
 */
@Injectable()
export class TrustedDeviceService {
  constructor(private readonly db: DatabaseService) {}

  async create(
    userId: string,
    origin: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
    await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .insertInto('trusted_devices')
        .values({
          user_id: userId,
          token_hash: hashDeviceToken(token),
          expires_at: expiresAt,
          ip: origin.ip && isIP(origin.ip) !== 0 ? origin.ip : null,
          user_agent: origin.userAgent?.slice(0, 512) ?? null,
        })
        .execute(),
    );
    return { token, expiresAt };
  }

  /** Valida el token del usuario y marca el uso. false si no es suyo o ya no vale. */
  async use(userId: string, token: string): Promise<boolean> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('trusted_devices as td')
        .innerJoin('users as u', 'u.id', 'td.user_id')
        .select([
          'td.id',
          'td.created_at',
          'td.expires_at',
          'td.revoked_at',
          'u.password_changed_at',
          'u.mfa_enabled_at',
        ])
        .where('td.token_hash', '=', hashDeviceToken(token))
        .where('td.user_id', '=', userId)
        .executeTakeFirst();
      if (
        !row ||
        !trustedDeviceUsable(
          { createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at },
          { passwordChangedAt: row.password_changed_at, mfaEnabledAt: row.mfa_enabled_at },
          new Date(),
        )
      ) {
        return false;
      }
      await trx
        .updateTable('trusted_devices')
        .set({ last_used_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return true;
    });
  }

  /** Los equipos que todavía valen, del más usado al menos. */
  async list(userId: string, currentToken?: string): Promise<TrustedDeviceView[]> {
    const currentHash =
      currentToken && currentToken.length <= MAX_TOKEN_LENGTH
        ? hashDeviceToken(currentToken)
        : undefined;
    const rows = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .selectFrom('trusted_devices as td')
        .innerJoin('users as u', 'u.id', 'td.user_id')
        .select([
          'td.id',
          'td.token_hash',
          'td.created_at',
          'td.last_used_at',
          'td.expires_at',
          'td.revoked_at',
          'td.ip',
          'td.user_agent',
          'u.password_changed_at',
          'u.mfa_enabled_at',
        ])
        .where('td.user_id', '=', userId)
        .where('td.revoked_at', 'is', null)
        .orderBy('td.last_used_at', 'desc')
        .execute(),
    );
    const now = new Date();
    return rows
      .filter((r) =>
        trustedDeviceUsable(
          { createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at },
          { passwordChangedAt: r.password_changed_at, mfaEnabledAt: r.mfa_enabled_at },
          now,
        ),
      )
      .map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
        ip: r.ip,
        userAgent: r.user_agent,
        current: currentHash !== undefined && r.token_hash === currentHash,
      }));
  }

  /** "Quitar" un equipo es revocarlo: queda el rastro, no se borra. */
  async revoke(userId: string, deviceId: string): Promise<boolean> {
    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .updateTable('trusted_devices')
        .set({ revoked_at: new Date() })
        .where('id', '=', deviceId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  async revokeAll(userId: string): Promise<number> {
    const rows = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .updateTable('trusted_devices')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute(),
    );
    return rows.length;
  }
}
