import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Valida el account lockout (migración 0019) contra Postgres.
 *
 * Ejecuta el MISMO SQL que AuthService.registerFailedAttempt, no una réplica en JS: la
 * versión anterior de este test replicaba la lógica read-modify-write, así que validaba
 * una copia y no el código real — y por eso no detectó que el contador se podía evadir
 * con peticiones concurrentes. Ahora el incremento ocurre dentro del UPDATE y hay un
 * caso explícito de concurrencia.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

d('account lockout (AuthService semantics)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  let userId: string;

  async function readUser(): Promise<{
    attempts: number;
    lockedUntil: Date | null;
    lastLogin: Date | null;
  }> {
    const { rows } = await pool.query<{
      failed_login_attempts: number;
      locked_until: Date | null;
      last_login_at: Date | null;
    }>(`SELECT failed_login_attempts, locked_until, last_login_at FROM users WHERE id = $1`, [
      userId,
    ]);
    const r = rows[0]!;
    return {
      attempts: r.failed_login_attempts,
      lockedUntil: r.locked_until,
      lastLogin: r.last_login_at,
    };
  }

  /**
   * SQL idéntico al de AuthService.registerFailedAttempt: el incremento ocurre en la
   * base, así que dos llamadas concurrentes cuentan dos.
   */
  async function failOnce(): Promise<void> {
    await pool.query(
      `UPDATE users
          SET failed_login_attempts = CASE
                WHEN failed_login_attempts + 1 >= $2 THEN 0
                ELSE failed_login_attempts + 1
              END,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2 THEN now() + make_interval(mins => $3)
                ELSE locked_until
              END
        WHERE id = $1`,
      [userId, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
    );
  }

  /** Réplica de AuthService.onLoginSuccess. */
  async function succeed(): Promise<void> {
    await pool.query(
      `UPDATE users
         SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
       WHERE id = $1`,
      [userId],
    );
  }

  beforeAll(async () => {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`lock-${sfx}@test.local`],
    );
    userId = u.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  it('starts unlocked with zero failed attempts', async () => {
    const u = await readUser();
    expect(u.attempts).toBe(0);
    expect(u.lockedUntil).toBeNull();
  });

  it('does NOT lock before reaching the threshold', async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) await failOnce();
    const u = await readUser();
    expect(u.attempts).toBe(LOCKOUT_THRESHOLD - 1);
    expect(u.lockedUntil).toBeNull();
  });

  it('locks the account on the threshold-th consecutive failure', async () => {
    await failOnce(); // el fallo número LOCKOUT_THRESHOLD
    const u = await readUser();
    expect(u.lockedUntil).not.toBeNull();
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(u.attempts).toBe(0); // reseteado al bloquear
  });

  it('a successful login clears the lock and stamps last_login_at', async () => {
    await succeed();
    const u = await readUser();
    expect(u.attempts).toBe(0);
    expect(u.lockedUntil).toBeNull();
    expect(u.lastLogin).not.toBeNull();
  });

  it('cuenta TODOS los intentos concurrentes (el bug que tenía el read-modify-write)', async () => {
    await succeed(); // parte de cero

    // Con el incremento en la app, estos N fallos leían el mismo valor y escribían el
    // mismo `current + 1`: sumaban 1 en total y el lockout no llegaba nunca, que es
    // exactamente el patrón de un ataque de fuerza bruta paralelo.
    const concurrent = LOCKOUT_THRESHOLD - 1;
    await Promise.all(Array.from({ length: concurrent }, () => failOnce()));

    const u = await readUser();
    expect(u.attempts).toBe(concurrent);
    expect(u.lockedUntil).toBeNull();

    // Y el siguiente fallo, ya en el umbral, bloquea.
    await failOnce();
    const locked = await readUser();
    expect(locked.lockedUntil).not.toBeNull();
    expect(locked.attempts).toBe(0);
  });
});
