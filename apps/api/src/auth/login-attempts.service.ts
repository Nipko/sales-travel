import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';

/** Tras este número de fallos consecutivos la cuenta se bloquea temporalmente. */
export const LOCKOUT_THRESHOLD = 5;
/** Minutos de bloqueo al alcanzar el umbral. */
export const LOCKOUT_MINUTES = 15;

/** Un intento ya contado como fallo contra el bloqueo, antes de verificar la credencial. */
export interface ReservedAttempt {
  /** Este intento llegó al umbral: si falla, la cuenta queda bloqueada (ya lo está en la base). */
  locked: boolean;
  /** Fallos que le quedan a la cuenta antes del bloqueo, contando éste como fallido. */
  attemptsLeft: number;
}

/**
 * Contador de fallos y bloqueo de la cuenta (0019). Lo comparten la contraseña y el segundo factor:
 * un código MFA fallido suma igual que una contraseña mala, así que quien tiene la contraseña no
 * puede probar códigos sin límite pidiendo desafíos nuevos.
 *
 * `users` no tiene RLS (cross-tenant): seguro por id.
 */
@Injectable()
export class LoginAttemptsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Suma un fallo. Al alcanzar el umbral bloquea la cuenta por LOCKOUT_MINUTES y resetea el
   * contador (tras expirar el bloqueo vuelve a tener LOCKOUT_THRESHOLD intentos). Devuelve si la
   * cuenta quedó bloqueada.
   *
   * Un solo UPDATE que incrementa en la BASE, no en la app: con read-modify-write, N intentos en
   * paralelo leían el mismo valor, sumaban 1 en total y el bloqueo no llegaba nunca. Dentro del
   * UPDATE `failed_login_attempts` a la derecha es el valor VIEJO, así que ambos CASE ven el mismo
   * estado.
   */
  async registerFailure(userId: string): Promise<{ locked: boolean }> {
    const res = await sql<{ locked: boolean }>`
      UPDATE users
         SET failed_login_attempts = CASE
               WHEN failed_login_attempts + 1 >= ${LOCKOUT_THRESHOLD} THEN 0
               ELSE failed_login_attempts + 1
             END,
             locked_until = CASE
               WHEN failed_login_attempts + 1 >= ${LOCKOUT_THRESHOLD}
                 THEN now() + make_interval(mins => ${LOCKOUT_MINUTES})
               ELSE locked_until
             END
       WHERE id = ${userId}::uuid
      RETURNING COALESCE(locked_until > now(), false) AS locked
    `.execute(this.db.db);
    return { locked: res.rows[0]?.locked === true };
  }

  /**
   * Cuenta el intento como fallo ANTES de verificar el código, en el mismo UPDATE que comprueba que
   * la cuenta no esté bloqueada. null = bloqueada: no se prueba nada.
   *
   * Mirar el bloqueo con un SELECT y sumar el fallo después de verificar dejaba una carrera: una
   * ráfaga de intentos en paralelo (varios desafíos, varias IP) pasaba entera el SELECT antes de
   * que el quinto fallo grabara `locked_until`, y se probaban decenas de códigos por ventana en vez
   * de cinco. Con la reserva, el UPDATE toma el lock de la fila: los intentos del mismo usuario se
   * ordenan, cada uno re-evalúa el WHERE contra la fila que dejó el anterior y el sexto ya la ve
   * bloqueada. Si el código resulta bueno, clearFailures deshace la reserva.
   *
   * `executor`: la transacción del llamador, para reservar junto con el intento del desafío.
   */
  async reserve(
    userId: string,
    executor: Kysely<DB> = this.db.db,
  ): Promise<ReservedAttempt | null> {
    const res = await sql<{ failed: number; locked: boolean }>`
      UPDATE users
         SET failed_login_attempts = CASE
               WHEN failed_login_attempts + 1 >= ${LOCKOUT_THRESHOLD} THEN 0
               ELSE failed_login_attempts + 1
             END,
             locked_until = CASE
               WHEN failed_login_attempts + 1 >= ${LOCKOUT_THRESHOLD}
                 THEN now() + make_interval(mins => ${LOCKOUT_MINUTES})
               ELSE locked_until
             END
       WHERE id = ${userId}::uuid
         AND (locked_until IS NULL OR locked_until <= now())
      RETURNING failed_login_attempts AS failed,
                COALESCE(locked_until > now(), false) AS locked
    `.execute(executor);
    const row = res.rows[0];
    if (!row) return null;
    return {
      locked: row.locked,
      attemptsLeft: row.locked ? 0 : Math.max(0, LOCKOUT_THRESHOLD - row.failed),
    };
  }

  /**
   * La credencial reservada resultó buena: limpia el contador y el bloqueo, aunque todavía no se
   * emita la sesión (el 409 del cupo lleno, por ejemplo). Si no, el código correcto quedaba
   * contando como fallo y cinco intentos contra un cupo lleno bloqueaban la cuenta. Sólo después de
   * probar el segundo factor: con la contraseña sola el contador no se toca.
   */
  async clearFailures(userId: string): Promise<void> {
    await this.db.db
      .updateTable('users')
      .set({ failed_login_attempts: 0, locked_until: null })
      .where('id', '=', userId)
      .execute();
  }

  /** Login completo: limpia el contador y registra el acceso. Recién al emitir la sesión. */
  async registerSuccess(userId: string): Promise<void> {
    await this.db.db
      .updateTable('users')
      .set({ failed_login_attempts: 0, locked_until: null, last_login_at: sql<Date>`now()` })
      .where('id', '=', userId)
      .execute();
  }
}
