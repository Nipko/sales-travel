import type { QueryResult, QueryResultRow } from 'pg';
import { blindIndex, derivePiiKeys, open, seal } from './crypto.js';
import { FICTITIOUS_CUSTOMERS, SEED_CUSTOMER_TAG } from './customers.js';
import type { SeedSettings, VendedorStatus } from './env.js';
import { SeedRefusedError } from './errors.js';

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** El hash de contraseñas del api (bcrypt, 12 rondas: apps/api/src/auth/password.service.ts). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export const TBO_PROVIDER_CODE = 'tbo-hotels';
const ACCOUNT_LABEL = 'default';

/**
 * Motivo del ajuste que enciende TBO para el tenant (`provider_enablement`, 0048). Es lo que ve el
 * superadmin en el panel de la plataforma junto al tenant.
 */
export const ENABLEMENT_REASON = 'Stack de certificación de TBO (seed-tbo-cert-tenant)';

/** El `domain_event` de un cambio de habilitación: el mismo tipo que escribe la API. */
const ENABLEMENT_EVENT = 'platform.provider_enablement.updated';

/** Marca, en `markup_rules.conditions`, de la regla que es del seed. La cascada no lee esa columna. */
const MARKUP_MARKER = Object.freeze({ seed: 'seed-tbo-cert-tenant' });

/**
 * Autor de los depósitos del seed en `portfolio_transactions.created_by` (sin FK a `users`). No se
 * atribuyen al `vendedor`: sus movimientos son la evidencia ante una discusión de TBO (07 §7.4), y
 * un depósito suyo que nunca hizo la ensuciaría.
 */
export const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const WALLET_REFERENCE = 'seed-tbo-cert-tenant';

/**
 * La raíz `platform` que el seed crea si la base no tiene ninguna, como la del stack, que nace vacía.
 * Desde 0050 sólo la plataforma es raíz y hay una sola por base (D4 A): si ya existe, se usa esa.
 */
export const CERT_PLATFORM_SLUG = 'tbo-cert-platform';
const CERT_PLATFORM_NAME = 'Sales-Travel Certification Platform';

export type Change = 'created' | 'updated' | 'unchanged';

/**
 * Dónde quedó el tenant: `platform` si cuelga de la raíz; `legacy-root` si es el consolidador raíz de
 * una versión anterior del seed y la base todavía no deja moverlo (reservas abiertas pagadas con
 * cartera, STH02 de 0051). El despliegue siguiente lo vuelve a intentar.
 */
export type TenantPlacement = 'platform' | 'legacy-root';

/** Lo que imprime el contenedor. Ni contraseñas ni credenciales: ids, estados y contadores. */
export interface SeedReport {
  /** La raíz `platform` de la base, de la que cuelga el tenant (D4 A). */
  readonly platformTenantId: string;
  readonly platform: Change;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenant: Change;
  readonly placement: TenantPlacement;
  readonly userId: string;
  readonly vendedorEmail: string;
  readonly vendedor: Change;
  readonly vendedorStatus: VendedorStatus;
  readonly passwordRotated: boolean;
  readonly providerAccountId: string;
  readonly providerAccount: Change;
  /** El ajuste que enciende TBO para el tenant en `provider_enablement` (0048). */
  readonly providerEnablement: Change;
  readonly walletCurrency: string;
  readonly walletBalanceMinor: number;
  readonly walletToppedUpMinor: number;
  readonly markupRuleId: string;
  readonly markupRule: Change;
  readonly customersCreated: number;
  readonly customersExisting: number;
}

async function one<R extends QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[],
): Promise<R | undefined> {
  return (await db.query<R>(text, values)).rows[0];
}

async function count(db: Queryable, text: string, values: unknown[]): Promise<number> {
  const row = await one<{ n: number | string }>(db, text, values);
  return Number(row?.n ?? 0);
}

/**
 * Antes de escribir: que la base sea la del stack y que el rol vea todas las redes.
 *
 * El nombre de la base es la guarda contra el error caro: correr esto con las `PG*` de producción
 * dejaría una cuenta de TBO de test y un consolidador ficticio en la base que vende. Y sin
 * superusuario (o `BYPASSRLS`) las comprobaciones de abajo verían sólo el tenant fijado y
 * aprobarían lo que no deben.
 */
async function assertTarget(db: Queryable, settings: SeedSettings): Promise<void> {
  const row = await one<{ database: string; privileged: boolean | null }>(
    db,
    `SELECT current_database() AS database,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
    [],
  );
  const expected = settings.database.expectedName;
  if (row?.database !== expected) {
    throw new SeedRefusedError(
      'wrong_database',
      `la base es '${row?.database ?? '?'}' y el seed sólo siembra '${expected}', la del stack de certificación`,
    );
  }
  if (row.privileged !== true) {
    throw new SeedRefusedError(
      'not_privileged',
      'el seed corre con el superusuario del stack (PGUSER=postgres): necesita ver todas las redes para no pisar nada ajeno',
    );
  }
  if (!settings.database.dedicated) return;

  // 07 §7.3.3 y RC-07: en este stack la única cuenta que resuelve es la de TBO de test. Una cuenta
  // de otro proveedor cargada desde el panel sería justo lo que este entorno existe para impedir.
  const foreign = await db.query<{ provider_code: string }>(
    `SELECT DISTINCT provider_code FROM provider_accounts WHERE provider_code <> $1 ORDER BY provider_code`,
    [TBO_PROVIDER_CODE],
  );
  if (foreign.rows.length > 0) {
    throw new SeedRefusedError(
      'foreign_provider_accounts',
      `la base de certificación tiene cuentas de otros proveedores (${foreign.rows.map((r) => r.provider_code).join(', ')}): aquí sólo puede resolver la de TBO de test. Bórralas antes de sembrar`,
    );
  }
}

interface TenantRow {
  id: string;
  name: string;
  country_code: string;
  default_currency: string;
  support_email: string | null;
  support_phone: string | null;
  tenant_type: string;
  parent_tenant_id: string | null;
  status: string;
}

/**
 * La raíz `platform` de la base: la que haya o, en una base sin ninguna, una propia del stack.
 *
 * Buscar o crear sin carrera: si otra alta se cruza, el índice único de 0050 decide y
 * `ON CONFLICT DO NOTHING` no aborta la transacción del seed. La fila queda `FOR SHARE`: nadie le
 * cambia el tipo mientras se siembra.
 */
async function upsertPlatformRoot(
  db: Queryable,
  tenant: SeedSettings['tenant'],
): Promise<{ id: string; change: Change }> {
  const platformSql = `SELECT id FROM tenants WHERE tenant_type = 'platform' FOR SHARE`;
  const existing = await one<{ id: string }>(db, platformSql, []);
  if (existing !== undefined) return { id: existing.id, change: 'unchanged' };

  const created = await one<{ id: string }>(
    db,
    `INSERT INTO tenants (slug, name, country_code, default_currency, default_language, tenant_type)
     VALUES ($1, $2, $3, $4, 'es', 'platform')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [CERT_PLATFORM_SLUG, CERT_PLATFORM_NAME, tenant.countryCode, tenant.currency],
  );
  if (created !== undefined) return { id: created.id, change: 'created' };

  const raced = await one<{ id: string }>(db, platformSql, []);
  if (raced !== undefined) return { id: raced.id, change: 'unchanged' };
  throw new SeedRefusedError(
    'platform_slug_taken',
    `la base no tiene raíz platform y el slug '${CERT_PLATFORM_SLUG}' es de otro tenant: libéralo o crea la raíz antes de sembrar`,
  );
}

const MOVE_SAVEPOINT = 'seed_move_under_platform';

/**
 * Un consolidador raíz de una versión anterior del seed (antes de 0050 nacía sin padre) se cuelga
 * de la plataforma con `move_tenant_subtree` (0051), que recalcula su `path` y deja el evento.
 *
 * Si tiene reservas abiertas pagadas con cartera (STH02), la base no lo deja mover y el seed no lo
 * fuerza: lo deja como raíz y sigue. En el stack no cambia nada de lo que usa TBO, porque la
 * plataforma no tiene cuentas, reglas ni marca que heredarle y el tenant sigue siendo un consolidador
 * con su cuenta propia; y un despliegue en rojo mientras TBO tiene reservas de prueba abiertas
 * frenaría la certificación. El informe lo dice (`placement: 'legacy-root'`) y el despliegue
 * siguiente lo reintenta. Cualquier otra negativa de la jerarquía (STH01) sí detiene el seed.
 *
 * El `SAVEPOINT` deja la transacción del seed usable después de la negativa.
 */
async function moveUnderPlatform(
  db: Queryable,
  tenantId: string,
  platformId: string,
): Promise<TenantPlacement> {
  await db.query(`SAVEPOINT ${MOVE_SAVEPOINT}`);
  try {
    await db.query('SELECT move_tenant_subtree($1::uuid, $2::uuid)', [tenantId, platformId]);
  } catch (err) {
    await db.query(`ROLLBACK TO SAVEPOINT ${MOVE_SAVEPOINT}`);
    const code = (err as { code?: unknown }).code;
    if (code === 'STH02') return 'legacy-root';
    if (code === 'STH01') {
      throw new SeedRefusedError(
        'tenant_move_blocked',
        `el tenant de certificación es un consolidador raíz de una versión anterior del seed y no se pudo colgar de la plataforma: ${(err as Error).message}`,
      );
    }
    throw err;
  }
  await db.query(`RELEASE SAVEPOINT ${MOVE_SAVEPOINT}`);
  return 'platform';
}

/**
 * Consolidador hijo de la plataforma y sin hijos: el factory de TBO sólo opera cuentas de plataforma
 * o de consolidador (D-TBO-03 A; apps/api/src/providers-tbo/tbo-hotels.factory.ts), la matriz D4
 * (0050) cuelga los consolidadores de la plataforma, y sin hijos nadie más hereda la cuenta de test.
 * El vendedor es del consolidador: la plataforma no vende.
 *
 * Con su contacto de soporte (07 §7.3.8): el Book lo toma de `resolve_tenant_branding` y, sin
 * email o sin teléfono internacional, rechaza la reserva antes de abrir la orden (D-TBO-23 A;
 * apps/api/src/hotels/hotel-booking-contact.ts). La plataforma del stack no tiene contacto que
 * heredarle, y el `vendedor` no puede cargarlo porque _Mi Agencia_ es de administradores.
 */
async function upsertTenant(
  db: Queryable,
  tenant: SeedSettings['tenant'],
  platformId: string,
): Promise<{ id: string; change: Change; placement: TenantPlacement }> {
  const row = await one<TenantRow>(
    db,
    `SELECT id, name, country_code, default_currency, support_email, support_phone, tenant_type,
            parent_tenant_id, status
       FROM tenants WHERE slug = $1 FOR UPDATE`,
    [tenant.slug],
  );
  if (row === undefined) {
    const created = await one<{ id: string }>(
      db,
      `INSERT INTO tenants
         (slug, name, country_code, default_currency, default_language, tenant_type, parent_tenant_id,
          support_email, support_phone)
       VALUES ($1, $2, $3, $4, 'es', 'consolidator', $5, $6, $7)
       RETURNING id`,
      [
        tenant.slug,
        tenant.name,
        tenant.countryCode,
        tenant.currency,
        platformId,
        tenant.supportEmail,
        tenant.supportPhone,
      ],
    );
    return { id: created!.id, change: 'created', placement: 'platform' };
  }

  const legacyRoot = row.parent_tenant_id === null;
  const underPlatform = legacyRoot || row.parent_tenant_id === platformId;
  if (row.tenant_type !== 'consolidator' || !underPlatform) {
    throw new SeedRefusedError(
      'tenant_shape',
      `el tenant '${tenant.slug}' ya existe como '${row.tenant_type}'${underPlatform ? '' : ' colgado de otro nodo'}: la cuenta de TBO sólo opera desde un consolidador de la plataforma`,
    );
  }
  const children = await count(
    db,
    'SELECT count(*)::int AS n FROM tenants WHERE parent_tenant_id = $1',
    [row.id],
  );
  if (children > 0) {
    throw new SeedRefusedError(
      'tenant_has_children',
      `el tenant '${tenant.slug}' tiene ${children} nodo(s) hijo(s): el de certificación va sin red (docs/tbo/07 §7.3.1)`,
    );
  }
  const placement = legacyRoot ? await moveUnderPlatform(db, row.id, platformId) : 'platform';
  const moved = legacyRoot && placement === 'platform';

  const same =
    row.name === tenant.name &&
    row.country_code === tenant.countryCode &&
    row.default_currency === tenant.currency &&
    row.support_email === tenant.supportEmail &&
    row.support_phone === tenant.supportPhone &&
    row.status === 'active';
  if (same) return { id: row.id, change: moved ? 'updated' : 'unchanged', placement };
  await db.query(
    `UPDATE tenants
        SET name = $2, country_code = $3, default_currency = $4, support_email = $5,
            support_phone = $6, status = 'active'
      WHERE id = $1`,
    [
      row.id,
      tenant.name,
      tenant.countryCode,
      tenant.currency,
      tenant.supportEmail,
      tenant.supportPhone,
    ],
  );
  return { id: row.id, change: 'updated', placement };
}

interface UserRow {
  id: string;
  password_hash: string | null;
  name: string | null;
  status: string;
  email_verified_at: Date | string | null;
}

/**
 * El `vendedor` puede buscar, reservar y cancelar sin MFA (`MFA_REQUIRED_ROLES` no lo incluye,
 * apps/api/src/auth/roles.ts), que es lo que necesita un tester sin TOTP (07 §7.4).
 *
 * La contraseña sólo se rota si cambió: cada rotación invalida las sesiones abiertas, y el job
 * corre el seed en cada despliegue. Suspenderlo (tras el sign-off) también las invalida.
 */
async function upsertVendedor(
  db: Queryable,
  tenantId: string,
  vendedor: SeedSettings['vendedor'],
  hasher: PasswordHasher,
): Promise<{ id: string; change: Change; passwordRotated: boolean }> {
  const password = vendedor.password.reveal();
  const row = await one<UserRow>(
    db,
    `SELECT id, password_hash, name, status, email_verified_at FROM users WHERE email = $1 FOR UPDATE`,
    [vendedor.email],
  );

  let id: string;
  let change: Change;
  let passwordRotated = false;
  if (row === undefined) {
    const created = await one<{ id: string }>(
      db,
      `INSERT INTO users (email, password_hash, name, status, email_verified_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id`,
      [vendedor.email, await hasher.hash(password), vendedor.name, vendedor.status],
    );
    id = created!.id;
    change = 'created';
  } else {
    id = row.id;
    // Un correo que ya usa alguien de otra red no es el del tester: resetearle la contraseña sería
    // tomarle la cuenta.
    const elsewhere = await count(
      db,
      'SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND tenant_id <> $2',
      [row.id, tenantId],
    );
    if (elsewhere > 0) {
      throw new SeedRefusedError(
        'user_in_other_network',
        'el correo del vendedor ya es de un usuario con acceso a otra red: el seed no le cambia la contraseña. Usa otro CERT_VENDEDOR_EMAIL',
      );
    }
    passwordRotated =
      row.password_hash === null || !(await hasher.verify(password, row.password_hash));
    const suspending = vendedor.status === 'suspended' && row.status !== 'suspended';
    const same =
      !passwordRotated &&
      row.name === vendedor.name &&
      row.status === vendedor.status &&
      row.email_verified_at !== null;
    if (same) {
      change = 'unchanged';
    } else {
      await db.query(
        `UPDATE users
            SET name = $2,
                status = $3,
                email_verified_at = COALESCE(email_verified_at, now()),
                password_hash = COALESCE($4, password_hash),
                failed_login_attempts = CASE WHEN $4::text IS NULL THEN failed_login_attempts ELSE 0 END,
                locked_until = CASE WHEN $4::text IS NULL THEN locked_until ELSE NULL END,
                password_changed_at = CASE WHEN $4::text IS NULL AND NOT $5 THEN password_changed_at ELSE now() END
          WHERE id = $1`,
        [
          row.id,
          vendedor.name,
          vendedor.status,
          passwordRotated ? await hasher.hash(password) : null,
          suspending,
        ],
      );
      change = 'updated';
    }
  }

  const membership = await one<{ role: string; status: string }>(
    db,
    'SELECT role, status FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
    [tenantId, id],
  );
  if (membership === undefined) {
    await db.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, 'vendedor', $3)`,
      [tenantId, id, vendedor.status],
    );
    if (change === 'unchanged') change = 'updated';
  } else if (membership.role !== 'vendedor' || membership.status !== vendedor.status) {
    await db.query(
      `UPDATE memberships SET role = 'vendedor', status = $3 WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, id, vendedor.status],
    );
    if (change === 'unchanged') change = 'updated';
  }
  return { id, change, passwordRotated: change !== 'created' && passwordRotated };
}

interface AccountRow {
  id: string;
  label: string;
  credentials_enc: Buffer;
  config: Record<string, unknown> | null;
  status: string;
  is_inheritable: boolean;
}

/**
 * La cuenta `tbo-hotels` en `active`: el default de la bóveda es `sandbox`, y una `sandbox` no la
 * devuelve `resolve_provider_account` (07 §7.3.2). No heredable: el tenant no tiene hijos, y así
 * sigue sin prestarla si algún día los tuviera.
 *
 * Las credenciales llegan del entorno del contenedor y se guardan cifradas con la clave del stack;
 * no quedan en ningún archivo del repositorio ni del VPS (el job borra `seed.env` al terminar).
 */
async function upsertTboAccount(
  db: Queryable,
  tenantId: string,
  settings: SeedSettings,
): Promise<{ id: string; change: Change }> {
  const { tboAccount, credentialsKey } = settings;
  const username = tboAccount.username.reveal();
  const password = tboAccount.password.reveal();
  const config = { environment: tboAccount.environment, baseUrl: tboAccount.baseUrl };

  const rows = (
    await db.query<AccountRow>(
      `SELECT id, label, credentials_enc, config, status, is_inheritable
         FROM provider_accounts WHERE tenant_id = $1 AND provider_code = $2 FOR UPDATE`,
      [tenantId, TBO_PROVIDER_CODE],
    )
  ).rows;

  // `resolve_provider_account` devuelve UNA fila sin desempate entre dos del mismo nivel (RC-10).
  const otherActive = rows.filter((r) => r.label !== ACCOUNT_LABEL && r.status === 'active');
  if (otherActive.length > 0) {
    throw new SeedRefusedError(
      'second_active_tbo_account',
      `el tenant tiene otra cuenta de TBO activa (${otherActive.map((r) => r.label).join(', ')}): con dos, la búsqueda usaría cualquiera de ellas`,
    );
  }

  const sealed = (): Buffer => seal(JSON.stringify({ username, password }), credentialsKey);
  const current = rows.find((r) => r.label === ACCOUNT_LABEL);
  if (current === undefined) {
    const created = await one<{ id: string }>(
      db,
      `INSERT INTO provider_accounts
         (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, false, 'active')
       RETURNING id`,
      [tenantId, TBO_PROVIDER_CODE, ACCOUNT_LABEL, sealed(), JSON.stringify(config)],
    );
    return { id: created!.id, change: 'created' };
  }

  let stored: { username?: unknown; password?: unknown };
  try {
    stored = JSON.parse(
      open(Buffer.from(current.credentials_enc), credentialsKey),
    ) as typeof stored;
  } catch {
    // Con otra clave tampoco se leen los documentos de los clientes ni los secretos MFA: no es un
    // problema de esta cuenta, y sobrescribirla lo escondería.
    throw new SeedRefusedError(
      'undecryptable_account',
      'la cuenta de TBO guardada no se descifra con PROVIDER_CREDENTIALS_KEY: la clave del stack cambió. Restaura la anterior o recrea la base',
    );
  }

  const storedConfig = current.config ?? {};
  const sameIdentity =
    stored.username === username &&
    storedConfig['environment'] === config.environment &&
    storedConfig['baseUrl'] === config.baseUrl;
  if (!sameIdentity) {
    // Otro usuario u otra URL es otra cuenta de TBO: sus reservas no existen para la nueva y se
    // quedarían sin post-venta (RF-29; D-TBO-28 A), como impide el panel.
    const orders = await count(
      db,
      'SELECT count(*)::int AS n FROM orders WHERE provider_account_id = $1',
      [current.id],
    );
    if (orders > 0) {
      throw new SeedRefusedError(
        'account_in_use',
        `la cuenta de TBO tiene ${orders} orden(es): cambiarle el usuario o la URL las dejaría sin post-venta. Sigue con la cuenta actual o recrea la base`,
      );
    }
  }
  const samePassword = stored.password === password;
  if (sameIdentity && samePassword && current.status === 'active' && !current.is_inheritable) {
    return { id: current.id, change: 'unchanged' };
  }
  await db.query(
    `UPDATE provider_accounts
        SET credentials_enc = COALESCE($2, credentials_enc),
            config = $3::jsonb,
            status = 'active',
            is_inheritable = false
      WHERE id = $1`,
    [current.id, sameIdentity && samePassword ? null : sealed(), JSON.stringify(config)],
  );
  return { id: current.id, change: 'updated' };
}

/**
 * TBO encendido para el tenant por el ajuste de la plataforma (`provider_enablement`, 0048), que es
 * como el superadmin lo gobierna desde el panel. TBO es `opt-in`: sin este ajuste, el tenant sólo
 * lo ve por la variable LEGADO `HOTEL_PROVIDERS_OPT_IN` del stack, que se mantiene
 * (docker-compose.cert.yml) para no depender del orden entre este seed y un despliegue viejo.
 *
 * Idempotente y declarativo, como el resto del seed: si alguien lo apagó desde el panel del stack,
 * el despliegue siguiente lo vuelve a encender, porque este tenant existe para certificar TBO.
 * Cada cambio deja el mismo `domain_event` que escribe la API, sin actor (lo hizo el seed).
 */
async function enableTbo(db: Queryable, tenantId: string): Promise<Change> {
  const row = await one<{ id: string; enabled: boolean; reason: string | null }>(
    db,
    `SELECT id, enabled, reason FROM provider_enablement
      WHERE provider_code = $1 AND tenant_id = $2
      FOR UPDATE`,
    [TBO_PROVIDER_CODE, tenantId],
  );
  if (row?.enabled === true && row.reason === ENABLEMENT_REASON) return 'unchanged';

  if (row === undefined) {
    await db.query(
      `INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason, updated_by)
       VALUES ($1, $2, true, $3, NULL)`,
      [TBO_PROVIDER_CODE, tenantId, ENABLEMENT_REASON],
    );
  } else {
    await db.query(
      `UPDATE provider_enablement
          SET enabled = true, reason = $2, updated_by = NULL, updated_at = now()
        WHERE id = $1`,
      [row.id, ENABLEMENT_REASON],
    );
  }
  const after = { enabled: true, reason: ENABLEMENT_REASON };
  await db.query(
    `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES (NULL, NULL, $1, 'provider_enablement', $2, $3::jsonb)`,
    [
      ENABLEMENT_EVENT,
      `${TBO_PROVIDER_CODE}@${tenantId}`,
      JSON.stringify({
        providerCode: TBO_PROVIDER_CODE,
        scope: 'tenant',
        targetTenantId: tenantId,
        before: row === undefined ? null : { enabled: row.enabled, reason: row.reason },
        after,
        source: 'seed-tbo-cert-tenant',
      }),
    ],
  );
  return row === undefined ? 'created' : 'updated';
}

interface WalletRow {
  id: string;
  balance_minor: number | string;
  currency: string;
  status: string;
}

/**
 * Cartera con saldo ficticio (07 §7.3.4), para que el checkout `Limit` retenga sin pedir tarjeta.
 * Nunca PAN (D1).
 *
 * "Recargar hasta" y no "sumar": cada despliegue deja el saldo en el objetivo sin duplicarlo, y
 * las retenciones de las reservas de TBO no lo agotan entre corridas. La recarga es un
 * `DEPOSIT_PAYMENT` en el libro, así el saldo sigue siendo la suma de sus movimientos.
 */
async function topUpWallet(
  db: Queryable,
  tenantId: string,
  settings: SeedSettings,
): Promise<{ currency: string; balanceMinor: number; toppedUpMinor: number }> {
  const currency = settings.tenant.currency;
  const target = settings.wallet.balanceMinor;
  await db.query(
    `INSERT INTO agency_portfolios (tenant_id, credit_limit_minor, balance_minor, currency, status)
     VALUES ($1, 0, 0, $2, 'active')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, currency],
  );
  const wallet = await one<WalletRow>(
    db,
    'SELECT id, balance_minor, currency, status FROM agency_portfolios WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  if (wallet === undefined) throw new Error('la cartera del tenant de certificación no existe');

  if (wallet.currency !== currency) {
    const bookings = await count(
      db,
      `SELECT count(*)::int AS n FROM portfolio_transactions
        WHERE portfolio_id = $1 AND transaction_type LIKE 'BOOKING%'`,
      [wallet.id],
    );
    if (bookings > 0) {
      throw new SeedRefusedError(
        'wallet_currency_in_use',
        `la cartera está en ${wallet.currency} y ya tiene movimientos de reservas: pasarla a ${currency} mezclaría monedas en un saldo. Vuelve a CERT_CURRENCY=${wallet.currency} o recrea la base`,
      );
    }
  }
  if (wallet.currency !== currency || wallet.status !== 'active') {
    await db.query(`UPDATE agency_portfolios SET currency = $2, status = 'active' WHERE id = $1`, [
      wallet.id,
      currency,
    ]);
  }

  const balance = Number(wallet.balance_minor);
  const topUp = target - balance;
  if (topUp <= 0) return { currency, balanceMinor: balance, toppedUpMinor: 0 };
  await db.query(
    `INSERT INTO portfolio_transactions
       (portfolio_id, amount_minor, transaction_type, reference_id, notes, created_by)
     VALUES ($1, $2, 'DEPOSIT_PAYMENT', $3, $4, $5)`,
    [
      wallet.id,
      topUp,
      WALLET_REFERENCE,
      'Saldo ficticio del stack de certificación de TBO',
      SEED_ACTOR_ID,
    ],
  );
  await db.query(`UPDATE agency_portfolios SET balance_minor = balance_minor + $2 WHERE id = $1`, [
    wallet.id,
    topUp,
  ]);
  return { currency, balanceMinor: target, toppedUpMinor: topUp };
}

/**
 * Una regla de markup de hoteles propia (07 §7.3.5): el tester ve un precio de venta distinto del
 * neto, y con un margen bajo la cascada queda muchas veces por debajo del `RecommendedSellingRate`
 * y se ve actuar el piso (CK-09; D-TBO-16 A).
 */
async function upsertHotelMarkup(
  db: Queryable,
  tenantId: string,
  basisPoints: number,
): Promise<{ id: string; change: Change }> {
  const row = await one<{
    id: string;
    rule_type: string;
    value_minor: number | string;
    status: string;
  }>(
    db,
    `SELECT id, rule_type, value_minor, status FROM markup_rules
      WHERE tenant_id = $1 AND vertical = 'hotels' AND conditions @> $2::jsonb
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE`,
    [tenantId, JSON.stringify(MARKUP_MARKER)],
  );
  if (row === undefined) {
    const created = await one<{ id: string }>(
      db,
      `INSERT INTO markup_rules (tenant_id, vertical, rule_type, value_minor, priority, conditions, status)
       VALUES ($1, 'hotels', 'percentage', $2, 1, $3::jsonb, 'active')
       RETURNING id`,
      [tenantId, basisPoints, JSON.stringify(MARKUP_MARKER)],
    );
    return { id: created!.id, change: 'created' };
  }
  if (
    row.rule_type === 'percentage' &&
    Number(row.value_minor) === basisPoints &&
    row.status === 'active'
  ) {
    return { id: row.id, change: 'unchanged' };
  }
  await db.query(
    `UPDATE markup_rules SET rule_type = 'percentage', value_minor = $2, status = 'active'
      WHERE id = $1`,
    [row.id, basisPoints],
  );
  return { id: row.id, change: 'updated' };
}

/**
 * Clientes ficticios del CRM (07 §7.3.7), con el documento cifrado como lo guarda el api
 * (`customers.service.ts`: sin valor en claro, `_enc` y el índice ciego `_hash`). Se reconocen
 * por el índice ciego: un cliente ya sembrado no se duplica.
 */
async function seedCustomers(
  db: Queryable,
  tenantId: string,
  credentialsKey: Buffer,
): Promise<{ created: number; existing: number }> {
  const keys = derivePiiKeys(credentialsKey);
  let created = 0;
  let existing = 0;
  for (const c of FICTITIOUS_CUSTOMERS) {
    const hash = blindIndex(c.documentNumber, keys.index);
    const found = await one<{ id: string }>(
      db,
      `SELECT id FROM customers
        WHERE tenant_id = $1 AND document_type = $2 AND document_number_hash = $3
        LIMIT 1`,
      [tenantId, c.documentType, hash],
    );
    if (found !== undefined) {
      existing += 1;
      continue;
    }
    await db.query(
      `INSERT INTO customers
         (tenant_id, first_name, last_name, email, phone, document_type, document_number,
          document_number_enc, document_number_hash, document_issuing_country, birthdate, gender,
          nationality, tags)
       VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7, $8, $9::date, $10, $11, ARRAY[$12]::text[])`,
      [
        tenantId,
        c.firstName,
        c.lastName,
        c.email,
        c.documentType,
        seal(c.documentNumber, keys.encryption),
        hash,
        c.documentIssuingCountry,
        c.birthdate,
        c.gender,
        c.nationality,
        SEED_CUSTOMER_TAG,
      ],
    );
    created += 1;
  }
  return { created, existing };
}

/**
 * Siembra el tenant de certificación de TBO (docs/tbo/07 §7.3 y §7.4; 09 PR-7.2) en UNA
 * transacción: o queda todo, o nada.
 *
 * Idempotente. Correrlo en cada despliegue deja el mismo estado sin duplicar clientes ni
 * depósitos, sin rotar una contraseña que no cambió y sin tocar lo que ya coincide.
 *
 * @throws SeedRefusedError si la base no es la del stack o sembrar rompería algo existente.
 */
export async function runSeed(
  db: Queryable,
  settings: SeedSettings,
  hasher: PasswordHasher,
): Promise<SeedReport> {
  await db.query('BEGIN');
  try {
    await assertTarget(db, settings);
    const platform = await upsertPlatformRoot(db, settings.tenant);
    const tenant = await upsertTenant(db, settings.tenant, platform.id);
    // Contexto de las políticas RLS para lo que sigue. El superusuario no las necesita; se fija
    // igual para que las filas pasen el `WITH CHECK` si el seed corriera con otro rol.
    await db.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant.id]);
    const vendedor = await upsertVendedor(db, tenant.id, settings.vendedor, hasher);
    await db.query(`SELECT set_config('app.current_user_id', $1, true)`, [vendedor.id]);
    const account = await upsertTboAccount(db, tenant.id, settings);
    const enablement = await enableTbo(db, tenant.id);
    const wallet = await topUpWallet(db, tenant.id, settings);
    const markup = await upsertHotelMarkup(db, tenant.id, settings.hotelMarkupBasisPoints);
    const customers = await seedCustomers(db, tenant.id, settings.credentialsKey);
    await db.query('COMMIT');
    return {
      platformTenantId: platform.id,
      platform: platform.change,
      tenantId: tenant.id,
      tenantSlug: settings.tenant.slug,
      tenant: tenant.change,
      placement: tenant.placement,
      userId: vendedor.id,
      vendedorEmail: settings.vendedor.email,
      vendedor: vendedor.change,
      vendedorStatus: settings.vendedor.status,
      passwordRotated: vendedor.passwordRotated,
      providerAccountId: account.id,
      providerAccount: account.change,
      providerEnablement: enablement,
      walletCurrency: wallet.currency,
      walletBalanceMinor: wallet.balanceMinor,
      walletToppedUpMinor: wallet.toppedUpMinor,
      markupRuleId: markup.id,
      markupRule: markup.change,
      customersCreated: customers.created,
      customersExisting: customers.existing,
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
