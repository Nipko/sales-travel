import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Las funciones de 0055 (puestos simultáneos, inactividad y reset de MFA) contra Postgres.
 *
 * Se llaman como `app_user` (NOBYPASSRLS) y con el `app.current_user_id` de OTRA persona: así se
 * prueba a la vez que el GRANT existe y que el SECURITY DEFINER sortea la RLS por usuario de
 * `sessions`, `mfa_recovery_codes` y `trusted_devices`, que es para lo que están. La autorización
 * es de la app y acá no se prueba.
 *
 * Red: plataforma → consolidador (3 puestos, 15 min) → agencia (hereda) → sub-agencia (hereda el
 * cupo, 45 min propios); y bajo el mismo consolidador una segunda agencia con cupo propio. Se SALTA
 * sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('0055: puestos, inactividad y reset de MFA, contra Postgres', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');

  let platform: string;
  let cons: string;
  let agency: string;
  let sub: string;
  let agency2: string;
  let free: string;
  /** Lo que la raíz compartida aporta a un nodo sin nada propio en su cadena. */
  let rootPool: string | null;
  let rootIdle: number;

  async function tenant(
    label: string,
    type: 'consolidator' | 'agency' | 'subagency',
    parent: string,
    config: { seats?: number; idle?: number } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type,
                            parent_tenant_id, concurrent_seats, idle_timeout_minutes)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4, $5, $6) RETURNING id`,
      [
        `seat-${label}-${sfx}`,
        `Nodo ${label}`,
        type,
        parent,
        config.seats ?? null,
        config.idle ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async function user(label: string, name: string | null = null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'hash-de-prueba') RETURNING id`,
      [`seat-${label}-${sfx}@test.local`, name],
    );
    return rows[0]!.id;
  }

  async function member(tenantId: string, userId: string, role: string): Promise<void> {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, userId, role],
    );
  }

  /** Una sesión tal como la dejaría `issueToken`, con la antigüedad que haga falta. */
  async function session(opts: {
    userId: string;
    tenantId: string;
    seat: string | null;
    idleSeconds?: number;
    lastSeenSecondsAgo?: number;
    revoked?: boolean;
    expired?: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, seat_tenant_id, idle_timeout_seconds, issued_at,
                             last_seen_at, expires_at, revoked_at, revoked_reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, now() - interval '3 hours',
               now() - make_interval(secs => $5),
               CASE WHEN $6 THEN now() - interval '1 minute' ELSE now() + interval '1 hour' END,
               CASE WHEN $7 THEN now() END,
               CASE WHEN $7 THEN 'logout' END,
               $8::inet, $9)
       RETURNING id`,
      [
        opts.userId,
        opts.tenantId,
        opts.seat,
        opts.idleSeconds ?? 1800,
        opts.lastSeenSecondsAgo ?? 5,
        opts.expired ?? false,
        opts.revoked ?? false,
        opts.ip ?? null,
        opts.userAgent ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /** Corre `fn` como el rol de la API, con el usuario de la request fijado. */
  async function asAppUser<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Alguien sin relación con los datos: la RLS no le deja ver ninguna sesión de las de acá. */
  let outsider: string;

  async function seatPoolOf(tenantId: string | null): Promise<string | null> {
    return asAppUser(outsider, async (c) => {
      const { rows } = await c.query<{ pool: string | null }>(
        'SELECT seat_pool_of($1::uuid) AS pool',
        [tenantId],
      );
      return rows[0]!.pool;
    });
  }

  async function idleMinutes(tenantId: string | null): Promise<number> {
    return asAppUser(outsider, async (c) => {
      const { rows } = await c.query<{ minutes: number }>(
        'SELECT effective_idle_timeout_minutes($1::uuid) AS minutes',
        [tenantId],
      );
      return rows[0]!.minutes;
    });
  }

  async function inUse(poolId: string, exclude: string | null = null): Promise<number> {
    return asAppUser(outsider, async (c) => {
      const { rows } = await c.query<{ n: number }>(
        'SELECT seats_in_use($1::uuid, $2::uuid) AS n',
        [poolId, exclude],
      );
      return rows[0]!.n;
    });
  }

  beforeAll(async () => {
    platform = await platformRootId(pool);
    // La raíz es compartida y no debería tener cupo ni inactividad (platform-root.ts), pero si otro
    // test se los pusiera, lo que hereda `free` cambia: se lee en vez de suponerlo.
    const root = await pool.query<{ concurrent_seats: number | null; idle: number | null }>(
      'SELECT concurrent_seats, idle_timeout_minutes AS idle FROM tenants WHERE id = $1',
      [platform],
    );
    rootPool = root.rows[0]!.concurrent_seats === null ? null : platform;
    rootIdle = root.rows[0]!.idle ?? 30;

    cons = await tenant('cons', 'consolidator', platform, { seats: 3, idle: 15 });
    agency = await tenant('agency', 'agency', cons);
    sub = await tenant('sub', 'subagency', agency, { idle: 45 });
    agency2 = await tenant('agency2', 'agency', cons, { seats: 2 });
    free = await tenant('free', 'consolidator', platform);

    outsider = await user('outsider');
  });

  afterAll(async () => {
    // Primero los usuarios: se llevan sus sesiones, memberships, desafíos y equipos.
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`seat-%-${sfx}@test.local`]);
    for (const id of [sub, agency, agency2, cons, free]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await pool.end();
  });

  describe('seat_pool_of: el ancestro-o-propio más profundo con cupo', () => {
    it('el nodo con cupo propio es su propio pool', async () => {
      expect(await seatPoolOf(cons)).toBe(cons);
      expect(await seatPoolOf(agency2)).toBe(agency2);
    });

    it('sin cupo propio consume del ancestro más cercano que lo tenga', async () => {
      expect(await seatPoolOf(agency)).toBe(cons);
      expect(await seatPoolOf(sub)).toBe(cons);
    });

    it('si ningún ancestro lo tiene, no hay límite', async () => {
      expect(await seatPoolOf(free)).toBe(rootPool);
    });

    it('un tenant que no existe (o NULL) no tiene pool', async () => {
      expect(await seatPoolOf(randomUUID())).toBeNull();
      expect(await seatPoolOf(null)).toBeNull();
    });
  });

  describe('effective_idle_timeout_minutes: heredable, 30 por defecto', () => {
    it('gana el valor más profundo de la cadena', async () => {
      expect(await idleMinutes(cons)).toBe(15);
      expect(await idleMinutes(agency)).toBe(15);
      expect(await idleMinutes(agency2)).toBe(15);
      expect(await idleMinutes(sub)).toBe(45);
    });

    it('sin valor en la cadena, 30 (o lo que tenga la raíz)', async () => {
      expect(await idleMinutes(free)).toBe(rootIdle);
    });

    it('sin tenant, 30', async () => {
      expect(await idleMinutes(null)).toBe(30);
    });
  });

  describe('los rangos los defiende la base', () => {
    it.each([
      ['concurrent_seats', 0],
      ['concurrent_seats', 10001],
      ['idle_timeout_minutes', 4],
      ['idle_timeout_minutes', 481],
    ])('%s = %i se rechaza', async (column, value) => {
      await expect(
        pool.query(`UPDATE tenants SET ${column} = $1 WHERE id = $2`, [value, agency]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('idle_timeout_seconds de una sesión va de 300 a 28800: atrapa minutos guardados como segundos', async () => {
      const u = await user('rango');
      await expect(
        session({ userId: u, tenantId: agency, seat: cons, idleSeconds: 30 }),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('seats_in_use y pool_active_sessions', () => {
    let alice: string;
    let bruno: string;
    let carla: string;
    let dario: string;
    let elena: string;
    let fabio: string;
    let root: string;
    let aliceSession: string;
    let brunoSession: string;

    beforeAll(async () => {
      alice = await user('alice', 'Alice Activa');
      bruno = await user('bruno', 'Bruno Subagencia');
      carla = await user('carla', 'Carla Inactiva');
      dario = await user('dario', 'Dario Revocado');
      elena = await user('elena', 'Elena Vencida');
      fabio = await user('fabio', 'Fabio Otra Agencia');
      root = await user('root', 'Superadmin');

      // Ocupa: activa hace 5 s.
      aliceSession = await session({
        userId: alice,
        tenantId: agency,
        seat: cons,
        idleSeconds: 900,
        lastSeenSecondsAgo: 5,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128',
      });
      // Ocupa: 20 min sin actividad, pero su sesión se emitió con los 45 min de la sub-agencia.
      brunoSession = await session({
        userId: bruno,
        tenantId: sub,
        seat: cons,
        idleSeconds: 2700,
        lastSeenSecondsAgo: 20 * 60,
      });
      // NO ocupa: 20 min sin actividad con un tope de 15 (todavía sin revocar: nadie la usó).
      await session({
        userId: carla,
        tenantId: cons,
        seat: cons,
        idleSeconds: 900,
        lastSeenSecondsAgo: 20 * 60,
      });
      // NO ocupa: revocada.
      await session({ userId: dario, tenantId: agency, seat: cons, revoked: true });
      // NO ocupa: venció el absoluto.
      await session({ userId: elena, tenantId: agency, seat: cons, expired: true });
      // Ocupa OTRO cupo.
      await session({ userId: fabio, tenantId: agency2, seat: agency2 });
      // No consume puesto (usuario de plataforma): seat NULL.
      await session({ userId: root, tenantId: agency, seat: null });
    });

    it('cuenta sólo las vivas: ni revocadas, ni vencidas, ni pasadas de su inactividad', async () => {
      expect(await inUse(cons)).toBe(2);
      expect(await inUse(agency2)).toBe(1);
    });

    it('excluye a quien está entrando (su sesión anterior se reemplaza)', async () => {
      expect(await inUse(cons, alice)).toBe(1);
      expect(await inUse(cons, bruno)).toBe(1);
      // Excluir a alguien cuya sesión ya no ocupa no cambia nada.
      expect(await inUse(cons, carla)).toBe(2);
    });

    it('pool_active_sessions lista las mismas, de la más reciente a la más vieja', async () => {
      const rows = await asAppUser(outsider, async (c) => {
        const res = await c.query<{
          session_id: string;
          user_id: string;
          email: string;
          name: string | null;
          tenant_id: string;
          tenant_name: string;
          issued_at: Date;
          last_seen_at: Date;
          ip: string | null;
          user_agent: string | null;
        }>('SELECT * FROM pool_active_sessions($1::uuid)', [cons]);
        return res.rows;
      });

      expect(rows.map((r) => r.session_id)).toEqual([aliceSession, brunoSession]);
      expect(rows[0]).toMatchObject({
        user_id: alice,
        email: `seat-alice-${sfx}@test.local`,
        name: 'Alice Activa',
        tenant_id: agency,
        tenant_name: 'Nodo agency',
        // Sin la máscara que agregaría `ip::text`.
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128',
      });
      expect(rows[0]!.issued_at).toBeInstanceOf(Date);
      expect(rows[0]!.last_seen_at).toBeInstanceOf(Date);
      expect(rows[1]).toMatchObject({ user_id: bruno, tenant_id: sub, ip: null });
    });

    it('una sesión cuyo nodo ya no está debajo del cupo no ocupa puesto ni se lista', async () => {
      // Lo que deja un login que calculó el cupo antes de que su nodo se moviera a otra red.
      const gina = await user('gina', 'Gina Otra Red');
      const stray = await session({ userId: gina, tenantId: free, seat: cons });

      expect(await inUse(cons)).toBe(2);
      const listed = await asAppUser(outsider, async (c) => {
        const res = await c.query<{ session_id: string }>(
          'SELECT session_id FROM pool_active_sessions($1::uuid)',
          [cons],
        );
        return res.rows.map((r) => r.session_id);
      });
      expect(listed).toEqual([aliceSession, brunoSession]);
      expect(listed).not.toContain(stray);
    });

    it('user_admin_overview cuenta las sesiones vivas del equipo del subárbol', async () => {
      await member(agency, alice, 'vendedor');
      await member(sub, bruno, 'vendedor');
      await member(cons, carla, 'vendedor');
      await pool.query(
        `UPDATE users SET last_login_at = now(), locked_until = now() + interval '10 minutes'
          WHERE id = $1`,
        [bruno],
      );
      await pool.query(
        `UPDATE users SET locked_until = now() - interval '1 minute' WHERE id = $1`,
        [carla],
      );

      const overview = async (tenantId: string) =>
        asAppUser(outsider, async (c) => {
          const res = await c.query<{
            user_id: string;
            last_login_at: Date | null;
            mfa_enabled: boolean;
            locked_until: Date | null;
            active_sessions: number;
          }>('SELECT * FROM user_admin_overview($1::uuid)', [tenantId]);
          return new Map(res.rows.map((r) => [r.user_id, r]));
        });

      const all = await overview(cons);
      expect(all.get(alice)).toMatchObject({
        active_sessions: 1,
        mfa_enabled: false,
        locked_until: null,
      });
      expect(all.get(bruno)?.active_sessions).toBe(1);
      expect(all.get(bruno)?.last_login_at).toBeInstanceOf(Date);
      expect(all.get(bruno)?.locked_until).toBeInstanceOf(Date);
      // Pasado de su inactividad no cuenta, y un bloqueo vencido no es bloqueo.
      expect(all.get(carla)).toMatchObject({ active_sessions: 0, locked_until: null });

      // Desde la agencia: ni el miembro del consolidador ni nadie de fuera del subárbol.
      const fromAgency = await overview(agency);
      expect([...fromAgency.keys()].sort()).toEqual([alice, bruno].sort());
    });

    it('revoke_session revoca la sesión de OTRO usuario, una sola vez, y libera el puesto', async () => {
      const revoke = () =>
        asAppUser(outsider, async (c) => {
          const { rows } = await c.query<{ ok: boolean }>(
            'SELECT revoke_session($1::uuid, $2) AS ok',
            [aliceSession, 'admin_released'],
          );
          return rows[0]!.ok;
        });

      expect(await revoke()).toBe(true);
      expect(await revoke()).toBe(false);

      const { rows } = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
        'SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1',
        [aliceSession],
      );
      expect(rows[0]!.revoked_at).toBeInstanceOf(Date);
      expect(rows[0]!.revoked_reason).toBe('admin_released');
      expect(await inUse(cons)).toBe(1);
    });

    it('una sesión que no existe no se revoca', async () => {
      const ok = await asAppUser(outsider, async (c) => {
        const { rows } = await c.query<{ ok: boolean }>(
          'SELECT revoke_session($1::uuid, $2) AS ok',
          [randomUUID(), 'admin_released'],
        );
        return rows[0]!.ok;
      });
      expect(ok).toBe(false);
    });
  });

  describe('refresh_session_idle_timeouts: un cambio de inactividad alcanza a las sesiones vivas', () => {
    it('recalcula cada sesión del subárbol con el valor de su nodo, respetando el override', async () => {
      const u1 = await user('refresh-agency');
      const u2 = await user('refresh-sub');
      const inAgency = await session({
        userId: u1,
        tenantId: agency,
        seat: cons,
        idleSeconds: 900,
      });
      const inSub = await session({ userId: u2, tenantId: sub, seat: cons, idleSeconds: 2700 });

      await pool.query('UPDATE tenants SET idle_timeout_minutes = 10 WHERE id = $1', [cons]);
      try {
        const changed = await asAppUser(outsider, async (c) => {
          const { rows } = await c.query<{ n: number }>(
            'SELECT refresh_session_idle_timeouts($1::uuid) AS n',
            [cons],
          );
          return rows[0]!.n;
        });
        expect(changed).toBeGreaterThanOrEqual(1);

        const { rows } = await pool.query<{ id: string; idle_timeout_seconds: number }>(
          'SELECT id, idle_timeout_seconds FROM sessions WHERE id = ANY($1::uuid[])',
          [[inAgency, inSub]],
        );
        const byId = new Map(rows.map((r) => [r.id, r.idle_timeout_seconds]));
        expect(byId.get(inAgency)).toBe(600);
        // La sub-agencia tiene 45 min propios: el cambio del consolidador no la toca.
        expect(byId.get(inSub)).toBe(2700);
      } finally {
        await pool.query('UPDATE tenants SET idle_timeout_minutes = 15 WHERE id = $1', [cons]);
      }
    });

    it('nunca sube un tope: la subida rige para las sesiones nuevas y no revive a una que ya lo superó', async () => {
      const u1 = await user('refresh-live');
      const u2 = await user('refresh-stale');
      const live = await session({ userId: u1, tenantId: agency, seat: cons, idleSeconds: 900 });
      const stale = await session({
        userId: u2,
        tenantId: agency,
        seat: cons,
        idleSeconds: 600,
        lastSeenSecondsAgo: 700,
      });

      await pool.query('UPDATE tenants SET idle_timeout_minutes = 60 WHERE id = $1', [cons]);
      try {
        const changed = await asAppUser(outsider, async (c) => {
          const { rows } = await c.query<{ n: number }>(
            'SELECT refresh_session_idle_timeouts($1::uuid) AS n',
            [cons],
          );
          return rows[0]!.n;
        });
        // Nada del subárbol tiene un snapshot por encima de su valor efectivo: no hay qué bajar.
        expect(changed).toBe(0);

        const { rows } = await pool.query<{ id: string; idle_timeout_seconds: number }>(
          'SELECT id, idle_timeout_seconds FROM sessions WHERE id = ANY($1::uuid[])',
          [[live, stale]],
        );
        const byId = new Map(rows.map((r) => [r.id, r.idle_timeout_seconds]));
        expect(byId.get(live)).toBe(900);
        // Con 3600 volvería a contar como viva y a ocupar un puesto.
        expect(byId.get(stale)).toBe(600);
      } finally {
        await pool.query('UPDATE tenants SET idle_timeout_minutes = 15 WHERE id = $1', [cons]);
      }
    });

    it('bajar un ancestro no le estira el tope a nadie: los snapshots por debajo del valor efectivo quedan', async () => {
      // updatePolicy no toca las sesiones abiertas cuando el tope SUBE, así que conviven snapshots
      // menores que el valor efectivo de su nodo. Una bajada posterior del consolidador sólo baja.
      const u1 = await user('refresh-override');
      const u2 = await user('refresh-older');
      const u3 = await user('refresh-inherits');
      // Entró con los 15 min del consolidador; después la agencia subió a 8 h propias.
      const underOverride = await session({
        userId: u1,
        tenantId: agency,
        seat: cons,
        idleSeconds: 900,
      });
      // agency2 hereda del consolidador: una sesión de cuando tenía 10 min y otra con los 15 de ahora.
      const older = await session({
        userId: u2,
        tenantId: agency2,
        seat: agency2,
        idleSeconds: 600,
      });
      const current = await session({
        userId: u3,
        tenantId: agency2,
        seat: agency2,
        idleSeconds: 900,
      });

      await pool.query('UPDATE tenants SET idle_timeout_minutes = 480 WHERE id = $1', [agency]);
      await pool.query('UPDATE tenants SET idle_timeout_minutes = 12 WHERE id = $1', [cons]);
      try {
        await asAppUser(outsider, (c) =>
          c.query('SELECT refresh_session_idle_timeouts($1::uuid)', [cons]),
        );
        const { rows } = await pool.query<{ id: string; idle_timeout_seconds: number }>(
          'SELECT id, idle_timeout_seconds FROM sessions WHERE id = ANY($1::uuid[])',
          [[underOverride, older, current]],
        );
        const byId = new Map(rows.map((r) => [r.id, r.idle_timeout_seconds]));
        // Igualar al efectivo de la agencia la llevaría de 15 min a 8 h.
        expect(byId.get(underOverride)).toBe(900);
        // Igualar la llevaría de 10 a 12 min.
        expect(byId.get(older)).toBe(600);
        expect(byId.get(current)).toBe(720);
      } finally {
        await pool.query('UPDATE tenants SET idle_timeout_minutes = 15 WHERE id = $1', [cons]);
        await pool.query('UPDATE tenants SET idle_timeout_minutes = NULL WHERE id = $1', [agency]);
      }
    });
  });

  describe('admin_reset_user_mfa', () => {
    it('deja al usuario sin segundo factor, sin respaldo, sin sesiones y sin bloqueo', async () => {
      const lost = await user('lost-phone');
      // Probó códigos sin el teléfono hasta bloquear la cuenta.
      await pool.query(
        `UPDATE users
            SET mfa_secret = 'cifrado-activo', mfa_pending_secret = 'cifrado-pendiente',
                mfa_enabled_at = now() - interval '1 day', mfa_last_used_step = 123,
                failed_login_attempts = 3, locked_until = now() + interval '15 minutes'
          WHERE id = $1`,
        [lost],
      );
      await pool.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, 'h1'), ($1, 'h2')`,
        [lost],
      );
      const deviceHash = createHash('sha256').update(randomBytes(32)).digest('hex');
      await pool.query(
        `INSERT INTO trusted_devices (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [lost, deviceHash],
      );
      await pool.query(
        `INSERT INTO mfa_challenges (user_id, expires_at) VALUES ($1, now() + interval '5 minutes')`,
        [lost],
      );
      const open = await session({ userId: lost, tenantId: agency, seat: cons });

      await asAppUser(outsider, (c) => c.query('SELECT admin_reset_user_mfa($1::uuid)', [lost]));

      const u = await pool.query<{
        mfa_secret: string | null;
        mfa_pending_secret: string | null;
        mfa_enabled_at: Date | null;
        mfa_last_used_step: string | null;
        failed_login_attempts: number;
        locked_until: Date | null;
      }>(
        `SELECT mfa_secret, mfa_pending_secret, mfa_enabled_at, mfa_last_used_step,
                failed_login_attempts, locked_until
           FROM users WHERE id = $1`,
        [lost],
      );
      expect(u.rows[0]).toEqual({
        mfa_secret: null,
        mfa_pending_secret: null,
        mfa_enabled_at: null,
        mfa_last_used_step: null,
        failed_login_attempts: 0,
        locked_until: null,
      });

      const codes = await pool.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1', [lost]);
      expect(codes.rowCount).toBe(0);

      const devices = await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM trusted_devices WHERE user_id = $1',
        [lost],
      );
      expect(devices.rows.every((r) => r.revoked_at !== null)).toBe(true);

      const challenges = await pool.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM mfa_challenges WHERE user_id = $1',
        [lost],
      );
      expect(challenges.rows.every((r) => r.consumed_at !== null)).toBe(true);

      const s = await pool.query<{ revoked_reason: string | null }>(
        'SELECT revoked_reason FROM sessions WHERE id = $1',
        [open],
      );
      expect(s.rows[0]!.revoked_reason).toBe('mfa_reset');
    });
  });

  describe('tablas nuevas: RLS por usuario y permisos de app_user', () => {
    it('trusted_devices y mfa_challenges sólo los ve su dueño', async () => {
      const owner = await user('rls-owner');
      await pool.query(
        `INSERT INTO trusted_devices (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [owner, createHash('sha256').update(randomBytes(32)).digest('hex')],
      );
      await pool.query(
        `INSERT INTO mfa_challenges (user_id, expires_at) VALUES ($1, now() + interval '5 minutes')`,
        [owner],
      );

      const count = (as: string) =>
        asAppUser(as, async (c) => {
          const devices = await c.query('SELECT 1 FROM trusted_devices WHERE user_id = $1', [
            owner,
          ]);
          const challenges = await c.query('SELECT 1 FROM mfa_challenges WHERE user_id = $1', [
            owner,
          ]);
          return { devices: devices.rowCount, challenges: challenges.rowCount };
        });

      expect(await count(owner)).toEqual({ devices: 1, challenges: 1 });
      expect(await count(outsider)).toEqual({ devices: 0, challenges: 0 });
    });

    it('trusted_devices rechaza un token en claro: sólo sha256 hex', async () => {
      const owner = await user('plain-token');
      await expect(
        pool.query(
          `INSERT INTO trusted_devices (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '30 days')`,
          [owner, randomBytes(32).toString('base64url')],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('consumed_tokens: un jti se consume una sola vez y app_user no puede borrarlo', async () => {
      const jti = randomUUID();
      const consume = () =>
        asAppUser(outsider, async (c) => {
          const { rowCount } = await c.query(
            `INSERT INTO consumed_tokens (jti, purpose, expires_at)
             VALUES ($1, 'seat_release', now() + interval '5 minutes')
             ON CONFLICT (jti) DO NOTHING
             RETURNING jti`,
            [jti],
          );
          return rowCount;
        });

      expect(await consume()).toBe(1);
      expect(await consume()).toBe(0);
      await expect(
        asAppUser(outsider, (c) => c.query('DELETE FROM consumed_tokens WHERE jti = $1', [jti])),
      ).rejects.toMatchObject({ code: '42501' });

      await pool.query('DELETE FROM consumed_tokens WHERE jti = $1', [jti]);
    });
  });
});
