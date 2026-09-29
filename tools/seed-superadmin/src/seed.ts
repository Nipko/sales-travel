import type { QueryResult, QueryResultRow } from 'pg';
import type { SeedSettings } from './env.js';
import { SeedConfigError, SeedRefusedError } from './errors.js';

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** El hash de contraseñas del api (bcrypt, 12 rondas: apps/api/src/auth/password.service.ts). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
}

/**
 * `payload.source` de cada `domain_event` del seed. El actor va NULL: lo hizo un proceso que corrió
 * el operador, no un usuario de la plataforma.
 */
export const SEED_SOURCE = 'seed-superadmin';

/** Los mismos tipos de evento que escriben la API y 0049 para el mismo cambio. */
export const SEED_EVENTS = Object.freeze({
  tenantCreated: 'TenantCreated',
  tenantPromoted: 'tenant.type.changed',
  userCreated: 'UserCreated',
  roleGranted: 'MembershipRoleChanged',
});

export type TenantChange = 'created' | 'promoted' | 'unchanged';
export type UserChange = 'created' | 'existing';
export type MembershipChange = 'created' | 'updated' | 'unchanged';

/** Lo que imprime el contenedor: ids, estados y lo que cambió. Ni el correo ni la contraseña. */
export interface SeedReport {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenant: TenantChange;
  /** El tipo que tenía el tenant antes de promoverlo; `null` si ya era la plataforma o se creó. */
  readonly previousTenantType: string | null;
  /** La plataforma no se reactiva sola: si no está `active`, el superadmin no entra hasta corregirlo. */
  readonly tenantStatus: string;
  readonly userId: string;
  readonly user: UserChange;
  /** Al usuario que ya existía no se le cambia el estado: si no está `active`, no entra. */
  readonly userStatus: string;
  readonly membership: MembershipChange;
  /** El rol que tenía en la plataforma antes de esta corrida; `null` si no tenía membership. */
  readonly previousRole: string | null;
  /** Llegó `SUPERADMIN_PASSWORD` y el usuario ya existía: no se usó. */
  readonly passwordIgnored: boolean;
}

async function one<R extends QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[],
): Promise<R | undefined> {
  return (await db.query<R>(text, values)).rows[0];
}

async function emit(
  db: Queryable,
  event: {
    tenantId: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, NULL, $2, $3, $4, $5::jsonb)`,
    [
      event.tenantId,
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify({ ...event.payload, source: SEED_SOURCE }),
    ],
  );
}

/**
 * Sin superusuario (o `BYPASSRLS`) las memberships, con RLS forzada, se verían vacías: el seed no
 * sabría si el usuario ya tiene rol en la plataforma y el alta chocaría con la política.
 */
async function assertPrivileged(db: Queryable): Promise<void> {
  const row = await one<{ privileged: boolean | null }>(
    db,
    `SELECT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
    [],
  );
  if (row?.privileged !== true) {
    throw new SeedRefusedError(
      'not_privileged',
      'el seed corre con el superusuario de la base (PGUSER=postgres): con RLS no ve todas las memberships y no puede decidir sin pisar nada',
    );
  }
}

interface TenantRow {
  id: string;
  tenant_type: string;
  parent_tenant_id: string | null;
  status: string;
}

interface UserRow {
  id: string;
  status: string;
}

interface MembershipRow {
  id: string;
  role: string;
  status: string;
}

/** Lo que el seed encontró antes de escribir nada. */
interface Found {
  tenant: TenantRow | undefined;
  user: UserRow | undefined;
}

/**
 * Todas las lecturas y negativas ANTES de escribir, para que un error de configuración diga todo lo
 * que falta de una vez y una negativa no deje nada a medias.
 *
 * El tenant y el usuario quedan `FOR UPDATE`: otra corrida del seed espera a que esta termine.
 */
async function inspectTarget(db: Queryable, settings: SeedSettings): Promise<Found> {
  const { slug } = settings.tenant;
  const tenant = await one<TenantRow>(
    db,
    `SELECT id, tenant_type, parent_tenant_id, status FROM tenants WHERE slug = $1 FOR UPDATE`,
    [slug],
  );

  // Un tenant con padre no es raíz: promoverlo exigiría moverlo, y eso lo decide el superadmin. (Una
  // plataforma con padre ya la impide el CHECK de 0050.)
  if (tenant !== undefined && tenant.parent_tenant_id !== null) {
    throw new SeedRefusedError(
      'tenant_has_parent',
      `el tenant '${slug}' cuelga de otro nodo: la plataforma es la raíz de la red (D4 A) y el seed no mueve nodos. Revisa SUPERADMIN_TENANT_SLUG`,
    );
  }

  if (tenant?.tenant_type !== 'platform') {
    const other = await one<{ slug: string }>(
      db,
      `SELECT slug::text AS slug FROM tenants
        WHERE tenant_type = 'platform' AND id IS DISTINCT FROM $1::uuid`,
      [tenant?.id ?? null],
    );
    if (other !== undefined) {
      throw new SeedRefusedError(
        'another_platform',
        tenant === undefined
          ? `no existe el tenant '${slug}' y la base ya tiene la plataforma '${other.slug}': hay una sola (D4 A) y el superadmin va en ella. Corre el seed con SUPERADMIN_TENANT_SLUG=${other.slug}`
          : `el tenant '${slug}' es una raíz de tipo ${tenant.tenant_type} y la base ya tiene la plataforma '${other.slug}': hay una sola (D4 A). Corre el seed con SUPERADMIN_TENANT_SLUG=${other.slug} y cuelga '${slug}' de ella desde el panel`,
      );
    }
  }

  const user = await one<UserRow>(db, `SELECT id, status FROM users WHERE email = $1 FOR UPDATE`, [
    settings.superadmin.email,
  ]);

  const issues: string[] = [];
  if (tenant === undefined && settings.tenant.name === undefined) {
    issues.push('SUPERADMIN_TENANT_NAME:required_to_create_tenant');
  }
  if (user === undefined && settings.superadmin.password === undefined) {
    issues.push('SUPERADMIN_PASSWORD:required_to_create_user');
  }
  if (user === undefined && settings.superadmin.name === undefined) {
    issues.push('SUPERADMIN_NAME:required_to_create_user');
  }
  if (issues.length > 0) throw new SeedConfigError(issues);

  return { tenant, user };
}

/**
 * La negativa de la base al promover, traducida. STH01 es una regla de la jerarquía (0050): por
 * ejemplo, el tenant tiene sub-agencias, que no pueden colgar de la plataforma. 23505 sobre el
 * índice de la plataforma única es otra plataforma confirmada mientras corría el seed.
 */
function promotionRefusal(err: unknown, slug: string): SeedRefusedError | undefined {
  const { code, constraint, message } = err as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (code === 'STH01') {
    return new SeedRefusedError(
      'tenant_promotion_blocked',
      `el tenant '${slug}' no se puede promover a platform: ${String(message)}. Corrígelo antes de correr el seed`,
    );
  }
  if (code === '23505' && constraint === 'uq_tenants_single_platform') {
    return new SeedRefusedError(
      'another_platform',
      `otro proceso creó la plataforma mientras corría el seed y hay una sola (D4 A): vuelve a correrlo para ver cuál es`,
    );
  }
  return undefined;
}

/**
 * La plataforma: la que ya es, la raíz que se promueve (sin renombrarla) o una nueva.
 *
 * Promover sólo cambia `tenant_type`, como 0049: el nombre, el estado, la marca y las cuentas del
 * tenant quedan como están. El trigger de 0050 valida que sus hijos quepan bajo la plataforma.
 */
async function ensurePlatform(
  db: Queryable,
  settings: SeedSettings,
  found: TenantRow | undefined,
): Promise<{ id: string; status: string; change: TenantChange; previousType: string | null }> {
  const { slug } = settings.tenant;

  if (found === undefined) {
    const created = await one<{ id: string; status: string }>(
      db,
      `INSERT INTO tenants (slug, name, country_code, default_currency, default_language, tenant_type)
       VALUES ($1, $2, $3, $4, 'es', 'platform')
       ON CONFLICT DO NOTHING
       RETURNING id, status`,
      [slug, settings.tenant.name, settings.tenant.countryCode, settings.tenant.currency],
    );
    if (created === undefined) {
      throw new SeedRefusedError(
        'concurrent_change',
        `otro proceso creó el tenant '${slug}' o la plataforma mientras corría el seed: vuelve a correrlo`,
      );
    }
    await emit(db, {
      tenantId: created.id,
      eventType: SEED_EVENTS.tenantCreated,
      aggregateType: 'tenant',
      aggregateId: created.id,
      payload: { slug, tenantType: 'platform', isBranch: false, parentTenantId: null },
    });
    return { id: created.id, status: created.status, change: 'created', previousType: null };
  }

  if (found.tenant_type === 'platform') {
    return { id: found.id, status: found.status, change: 'unchanged', previousType: null };
  }

  try {
    await db.query(`UPDATE tenants SET tenant_type = 'platform' WHERE id = $1`, [found.id]);
  } catch (err) {
    throw promotionRefusal(err, slug) ?? err;
  }
  await emit(db, {
    tenantId: found.id,
    eventType: SEED_EVENTS.tenantPromoted,
    aggregateType: 'tenant',
    aggregateId: found.id,
    payload: { from: found.tenant_type, to: 'platform' },
  });
  return {
    id: found.id,
    status: found.status,
    change: 'promoted',
    previousType: found.tenant_type,
  };
}

/**
 * El usuario del superadmin: el que ya existe tal cual, o uno nuevo con la contraseña del entorno.
 *
 * A uno que existe no se le rota la contraseña ni se le cambia el nombre o el estado: rotarla
 * cerraría sus sesiones y, con un correo equivocado, sería tomarle la cuenta a otro. Para cambiarla
 * está "Olvidé mi contraseña".
 */
async function ensureUser(
  db: Queryable,
  settings: SeedSettings,
  found: UserRow | undefined,
  tenantId: string,
  hasher: PasswordHasher,
): Promise<{ id: string; status: string; change: UserChange }> {
  if (found !== undefined) return { id: found.id, status: found.status, change: 'existing' };

  const { password, name, email } = settings.superadmin;
  // `inspectTarget` ya exigió los dos: esto sólo lo repite para el compilador.
  if (password === undefined || name === undefined) {
    throw new SeedConfigError([
      ...(password === undefined ? ['SUPERADMIN_PASSWORD:required_to_create_user'] : []),
      ...(name === undefined ? ['SUPERADMIN_NAME:required_to_create_user'] : []),
    ]);
  }
  const created = await one<{ id: string; status: string }>(
    db,
    `INSERT INTO users (email, password_hash, name, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', now())
     ON CONFLICT (email) DO NOTHING
     RETURNING id, status`,
    [email, await hasher.hash(password.reveal()), name],
  );
  if (created === undefined) {
    throw new SeedRefusedError(
      'concurrent_change',
      'otro proceso creó el usuario del superadmin mientras corría el seed: vuelve a correrlo',
    );
  }
  // Sin el correo: el agregado es el usuario y el payload de auditoría no lleva PII.
  await emit(db, {
    tenantId,
    eventType: SEED_EVENTS.userCreated,
    aggregateType: 'user',
    aggregateId: created.id,
    payload: { role: 'superadmin', existingUserLinked: false },
  });
  return { id: created.id, status: created.status, change: 'created' };
}

/**
 * La membership `superadmin` activa en la plataforma: la crea, o le cambia el rol y el estado a la
 * que tenga (en producción, `consolidator_admin`). Sus memberships en otros nodos no se tocan.
 * El trigger de 0025 exige que el tenant sea la plataforma: por eso va después de promoverlo.
 */
async function grantSuperadmin(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<{ change: MembershipChange; previousRole: string | null }> {
  const current = await one<MembershipRow>(
    db,
    `SELECT id, role, status FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
    [tenantId, userId],
  );
  if (current?.role === 'superadmin' && current.status === 'active') {
    return { change: 'unchanged', previousRole: 'superadmin' };
  }

  const row =
    current === undefined
      ? await one<{ id: string }>(
          db,
          `INSERT INTO memberships (tenant_id, user_id, role, status)
           VALUES ($1, $2, 'superadmin', 'active')
           RETURNING id`,
          [tenantId, userId],
        )
      : await one<{ id: string }>(
          db,
          `UPDATE memberships SET role = 'superadmin', status = 'active' WHERE id = $1 RETURNING id`,
          [current.id],
        );
  await emit(db, {
    tenantId,
    eventType: SEED_EVENTS.roleGranted,
    aggregateType: 'membership',
    aggregateId: row!.id,
    payload: {
      targetUserId: userId,
      newRole: 'superadmin',
      before: current === undefined ? null : { role: current.role, status: current.status },
      after: { role: 'superadmin', status: 'active' },
    },
  });
  return {
    change: current === undefined ? 'created' : 'updated',
    previousRole: current?.role ?? null,
  };
}

/**
 * Deja al superadmin en la plataforma, DENTRO de la transacción que abrió quien llama (`runSeed`, o
 * un test que la deshace al final).
 *
 * - El tenant `SUPERADMIN_TENANT_SLUG` que ya es la plataforma se usa tal cual; una raíz de otro
 *   tipo se promueve a `platform` sin renombrarla; si no existe, se crea como `platform` con
 *   `SUPERADMIN_TENANT_NAME`. Si cuelga de otro nodo, o la base ya tiene otra plataforma, se niega.
 * - El usuario de `SUPERADMIN_EMAIL` que ya existe se usa tal cual; si no, se crea con
 *   `SUPERADMIN_PASSWORD` y `SUPERADMIN_NAME`.
 * - Su membership en la plataforma pasa a `superadmin` activa, o se crea.
 *
 * Idempotente: otra corrida con el mismo entorno no escribe nada. Cada cambio deja su `domain_event`.
 *
 * @throws SeedConfigError si falta lo que hace falta para crear el tenant o el usuario.
 * @throws SeedRefusedError si sembrar rompería la red (D4 A) o la sesión no es privilegiada.
 */
export async function seedSuperadmin(
  db: Queryable,
  settings: SeedSettings,
  hasher: PasswordHasher,
): Promise<SeedReport> {
  await assertPrivileged(db);
  const found = await inspectTarget(db, settings);
  const platform = await ensurePlatform(db, settings, found.tenant);
  const user = await ensureUser(db, settings, found.user, platform.id, hasher);
  const membership = await grantSuperadmin(db, platform.id, user.id);
  return {
    tenantId: platform.id,
    tenantSlug: settings.tenant.slug,
    tenant: platform.change,
    previousTenantType: platform.previousType,
    tenantStatus: platform.status,
    userId: user.id,
    user: user.change,
    userStatus: user.status,
    membership: membership.change,
    previousRole: membership.previousRole,
    passwordIgnored: user.change === 'existing' && settings.superadmin.password !== undefined,
  };
}

/** `seedSuperadmin` en UNA transacción: o queda todo, o nada. */
export async function runSeed(
  db: Queryable,
  settings: SeedSettings,
  hasher: PasswordHasher,
): Promise<SeedReport> {
  await db.query('BEGIN');
  try {
    const report = await seedSuperadmin(db, settings, hasher);
    await db.query('COMMIT');
    return report;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
