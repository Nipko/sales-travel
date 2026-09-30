import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { MFA_CHALLENGE_TTL_MS } from './jwt.service.js';
import { LoginAttemptsService } from './login-attempts.service.js';

/** Intentos por desafío. Después hay que volver a la contraseña. */
export const MFA_MAX_ATTEMPTS = 5;

/** Un intento gastado, del desafío y de la cuenta, antes de verificar el código. */
export interface MfaAttempt {
  kind: 'reserved';
  /** Intentos que lleva el desafío, contando éste. */
  attempt: number;
  /** Los que quedan si éste falla: los del desafío o los de la cuenta, lo que se acabe antes. */
  attemptsLeft: number;
  /** Este intento llegó al umbral de la cuenta: si falla, queda bloqueada. */
  locksAccount: boolean;
}

/**
 * `locked`: la cuenta está bloqueada. `unavailable`: el desafío ya no sirve (consumido, vencido, sin
 * intentos o de otro usuario). En ninguno de los dos casos se gasta nada.
 */
export type MfaAttemptReservation = MfaAttempt | { kind: 'locked' } | { kind: 'unavailable' };

/** Revierte la reserva de la cuenta cuando el desafío no sirve. Nunca sale de este archivo. */
class ChallengeUnavailable extends Error {}

/**
 * Desafío del segundo factor con estado (`mfa_challenges`).
 *
 * Antes el desafío era sólo un JWT de 5 minutos: aceptaba intentos ilimitados mientras viviera y
 * seguía sirviendo después de canjearlo. Ahora cada desafío tiene 5 intentos y se consume una vez.
 *
 * El intento se RESERVA antes de verificar el código, con un UPDATE condicional: así el tope es
 * estricto aunque lleguen muchos intentos en paralelo con el mismo token (si se contara después de
 * verificar, veinte requests simultáneos pasarían todos el chequeo de "menos de 5").
 */
@Injectable()
export class MfaChallengeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly attempts: LoginAttemptsService,
  ) {}

  async create(userId: string): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS);
    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .insertInto('mfa_challenges')
        .values({ user_id: userId, expires_at: expiresAt })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return { id: row.id, expiresAt };
  }

  /**
   * Gasta un intento del desafío y, en la MISMA transacción, uno de la cuenta (el bloqueo que
   * comparte con la contraseña), ambos antes de verificar el código.
   *
   * Reservar sólo el del desafío dejaba abierto el tope por cuenta: con N desafíos (el login no los
   * limita) cada uno traía sus 5 intentos, y todos pasaban el chequeo del bloqueo antes de que el
   * quinto fallo lo grabara. Primero la cuenta: su UPDATE toma el lock de la fila de `users` y
   * ordena todos los intentos del usuario, sea cual sea el desafío. Si el desafío no sirve, la
   * transacción se revierte y la cuenta no pierde el intento.
   */
  async reserveAttempt(userId: string, challengeId: string): Promise<MfaAttemptReservation> {
    try {
      return await this.db.withRequestContext<MfaAttemptReservation>({ userId }, async (trx) => {
        const account = await this.attempts.reserve(userId, trx);
        if (!account) return { kind: 'locked' };

        const row = await trx
          .updateTable('mfa_challenges')
          .set({ attempts: sql<number>`attempts + 1` })
          .where('id', '=', challengeId)
          .where('user_id', '=', userId)
          .where('consumed_at', 'is', null)
          .where('attempts', '<', MFA_MAX_ATTEMPTS)
          .where('expires_at', '>', sql<Date>`now()`)
          .returning('attempts')
          .executeTakeFirst();
        if (!row) throw new ChallengeUnavailable();

        return {
          kind: 'reserved',
          attempt: row.attempts,
          attemptsLeft: Math.min(
            Math.max(0, MFA_MAX_ATTEMPTS - row.attempts),
            account.attemptsLeft,
          ),
          locksAccount: account.locked,
        };
      });
    } catch (err) {
      if (err instanceof ChallengeUnavailable) return { kind: 'unavailable' };
      throw err;
    }
  }

  /** Canje de un solo uso tras un código correcto. false = otro request lo canjeó antes. */
  async consume(userId: string, challengeId: string, rememberDevice: boolean): Promise<boolean> {
    const row = await this.db.withRequestContext({ userId }, (trx) =>
      trx
        .updateTable('mfa_challenges')
        .set({ consumed_at: sql<Date>`now()`, remember_device: rememberDevice })
        .where('id', '=', challengeId)
        .where('user_id', '=', userId)
        .where('consumed_at', 'is', null)
        .returning('id')
        .executeTakeFirst(),
    );
    return row !== undefined;
  }
}
