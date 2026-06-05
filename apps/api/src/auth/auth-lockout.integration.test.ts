import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Valida el account lockout (migración 0019) replicando la lógica read-modify-write de
 * AuthService.registerFailedAttempt/onLoginSuccess contra Postgres: tras LOCKOUT_THRESHOLD
 * fallos la cuenta se bloquea (locked_until futuro, contador reseteado) y un login OK limpia
 * todo y sella last_login_at. Se SALTA sin PGHOST.
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

  /** Réplica de AuthService.registerFailedAttempt (read-modify-write). */
  async function failOnce(): Promise<void> {
    const { attempts } = await readUser();
    const willLock = attempts + 1 >= LOCKOUT_THRESHOLD;
    await pool.query(
      `UPDATE users
         SET failed_login_attempts = $2,
             locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE NULL END
       WHERE id = $1`,
      [userId, willLock ? 0 : attempts + 1, willLock, LOCKOUT_MINUTES],
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
});
