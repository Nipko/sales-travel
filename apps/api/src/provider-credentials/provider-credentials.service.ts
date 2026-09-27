import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, ProviderAccountStatus, TenantType } from '../database/database.types.js';
import { decryptCredentials, encryptCredentials } from './credentials-cipher.js';
import {
  accountIdentityChanged,
  accountReadiness,
  safeConfigView,
  type ProviderAccountReadiness,
} from './provider-specs.js';

/** Resultado interno de resolución BYOC. Incluye el secreto descifrado: NUNCA exponer por API. */
export interface ResolvedProviderAccount {
  id: string;
  /** Dueño real de la cuenta resuelta (el propio tenant, o un ancestro si fue heredada). */
  ownerTenantId: string;
  providerCode: string;
  label: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  /** true si la cuenta provino de un ancestro (consolidador), no del propio tenant. */
  inherited: boolean;
  /** Última actualización de la cuenta resuelta — útil para invalidar caches de credenciales. */
  updatedAt: Date;
}

interface ResolveRow {
  id: string | null;
  tenant_id: string | null;
  provider_code: string | null;
  label: string | null;
  credentials_enc: Buffer | null;
  config: unknown;
  status: ProviderAccountStatus | null;
  updated_at: Date | null;
}

/** Fila del listado. NUNCA lleva el secreto: sólo metadata y NOMBRES de campo. */
export interface SafeProviderAccount {
  id: string;
  providerCode: string;
  label: string;
  /** Sólo las claves de `config` declaradas seguras para este proveedor. */
  config: Record<string, unknown>;
  /** Nombres —nunca valores— de las claves de `config` que no se devuelven. */
  redactedConfigKeys: readonly string[];
  /** `false` ⇒ el proveedor no declara lista blanca: no se sabe qué es seguro mostrar. */
  configVerified: boolean;
  /** Qué se sabe sobre si la cuenta puede autenticar. `unknown` = no se sabe, no "está bien". */
  readiness: ProviderAccountReadiness;
  /** Campos obligatorios que faltan, por NOMBRE. Vacío salvo en `incomplete`. */
  missingRequiredFields: readonly string[];
  isInheritable: boolean;
  status: ProviderAccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Reservas activas hechas con una cuenta: las de su dueño y las de la red que la hereda. */
export interface ProviderAccountActiveOrders {
  readonly own: number;
  readonly inherited: number;
}

/**
 * El blob cifrado como objeto, o `null` si no se puede leer (clave rotada, cifrado corrupto). No
 * lanza ni loguea: ni el error ni el blob pueden terminar en un log.
 */
function readCredentialsBlob(blob: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(decryptCredentials(blob));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Qué cambio sacaría de servicio una cuenta con reservas activas. */
export type ProviderAccountRelease = 'deactivate' | 'change-identity' | 'stop-inheritance';

const IN_USE_UNVERIFIED: Readonly<Record<ProviderAccountRelease, string>> = {
  deactivate:
    'No pudimos comprobar si esta cuenta tiene reservas activas, así que no se desactiva. Volvé a intentarlo en unos minutos.',
  'change-identity':
    'No pudimos comprobar si esta cuenta tiene reservas activas, así que no se cambia el usuario, el entorno ni la URL. Volvé a intentarlo en unos minutos.',
  'stop-inheritance':
    'No pudimos comprobar si hay reservas activas de tu red hechas con esta cuenta, así que sigue heredándose. Volvé a intentarlo en unos minutos.',
};

function inUseMessage(change: ProviderAccountRelease, activeOrders: number): string {
  switch (change) {
    case 'deactivate':
      return `Esta cuenta tiene ${activeOrders} reserva(s) activa(s) hechas con ella. No se puede desactivar hasta que terminen: es la única con la que el proveedor deja consultarlas y cancelarlas. Podés actualizar la contraseña sin desactivarla.`;
    case 'change-identity':
      return `Esta cuenta tiene ${activeOrders} reserva(s) activa(s) hechas con ella. No se puede cambiar el usuario, el entorno ni la URL del proveedor hasta que terminen: el proveedor sólo deja consultarlas y cancelarlas con la cuenta con la que se hicieron. Podés actualizar la contraseña del mismo usuario.`;
    case 'stop-inheritance':
      return `Hay ${activeOrders} reserva(s) activa(s) de agencias de tu red hechas con esta cuenta. No se puede dejar de heredar hasta que terminen: es la única con la que el proveedor deja consultarlas y cancelarlas.`;
  }
}

/**
 * La cuenta no se puede desactivar, apuntar a otra cuenta del proveedor (otro usuario, otro entorno)
 * ni dejar de heredar: todavía hay reservas activas hechas con ella, y es la única con la que el
 * proveedor deja leerlas y cancelarlas (RF-29 CA 2; D-TBO-28 A). Rotar la contraseña del mismo
 * usuario sí se puede.
 */
export class ProviderAccountInUseError extends ConflictException {
  readonly reason = 'PROVIDER_ACCOUNT_IN_USE';
  /** Sólo conteos: el dueño de la cuenta ve cuántas, no de quién ni cuáles. */
  readonly publicDetails: { readonly activeOrders: number | null };

  /** @param activeOrders `null` = no se pudo comprobar, y ante la duda no se suelta la cuenta. */
  constructor(change: ProviderAccountRelease, activeOrders: number | null) {
    super(activeOrders === null ? IN_USE_UNVERIFIED[change] : inUseMessage(change, activeOrders));
    this.name = 'ProviderAccountInUseError';
    this.publicDetails = { activeOrders };
  }
}

@Injectable()
export class ProviderCredentialsService {
  private readonly logger = new Logger(ProviderCredentialsService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * La cuenta con la que se hizo la orden `orderId` del tenant (`orders.provider_account_id`), para
   * operar su post-venta con ELLA y no con la vigente del tenant (RF-29; D-TBO-28 A). Descifra el
   * secreto. SOLO uso interno.
   *
   * La orden se lee con el tenant fijado, así que una orden de otra agencia no resuelve nada aunque
   * compartan la cuenta. Y la cuenta tiene que seguir en la red del tenant (propia, o de un ancestro
   * que la deja heredar) y activa: la FK de 0042 sólo prueba que existía al reservar
   * (`resolve_order_provider_account`, 0045).
   *
   * @throws NotFoundException si la orden no es del tenant, no guarda cuenta, o la cuenta ya no
   *   está disponible para él.
   */
  async resolveForOrder(tenantId: string, orderId: string): Promise<ResolvedProviderAccount> {
    const row = await this.db.withTenant(tenantId, async (trx) => {
      const result = await sql<ResolveRow>`
        SELECT id, tenant_id, provider_code, label, credentials_enc, config, status, updated_at
        FROM resolve_order_provider_account(${orderId}::uuid)
      `.execute(trx);
      return result.rows[0];
    });
    if (!row?.id || !row.credentials_enc || !row.tenant_id || !row.provider_code) {
      // Sin el id de la orden ni el del tenant en el mensaje: la excepción puede llegar a un log.
      throw new NotFoundException(
        'la cuenta de proveedor de la orden no está disponible para el tenant',
      );
    }
    return {
      id: row.id,
      ownerTenantId: row.tenant_id,
      providerCode: row.provider_code,
      label: row.label ?? 'default',
      config: (row.config ?? {}) as Record<string, unknown>,
      credentials: JSON.parse(decryptCredentials(row.credentials_enc)) as Record<string, unknown>,
      inherited: row.tenant_id !== tenantId,
      updatedAt: row.updated_at ?? new Date(0),
    };
  }

  /**
   * Resuelve la cuenta de proveedor a usar para (tenant, provider): la propia del
   * tenant o, si no tiene, la del ancestro heredable más cercano (consolidador).
   * Descifra el secreto. SOLO uso interno (llamadas a proveedores).
   */
  async resolve(tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> {
    const result = await sql<ResolveRow>`
      SELECT id, tenant_id, provider_code, label, credentials_enc, config, status, updated_at
      FROM resolve_provider_account(${tenantId}::uuid, ${providerCode})
    `.execute(this.db.db);

    const row = result.rows[0];
    if (!row?.id || !row.credentials_enc || !row.tenant_id) {
      throw new NotFoundException(
        `no active provider account for '${providerCode}' resolvable from tenant ${tenantId}`,
      );
    }

    return {
      id: row.id,
      ownerTenantId: row.tenant_id,
      providerCode: row.provider_code ?? providerCode,
      label: row.label ?? 'default',
      config: (row.config ?? {}) as Record<string, unknown>,
      credentials: JSON.parse(decryptCredentials(row.credentials_enc)) as Record<string, unknown>,
      inherited: row.tenant_id !== tenantId,
      updatedAt: row.updated_at ?? new Date(0),
    };
  }

  /**
   * Tipo de nodo (`tenants.tenant_type`) del DUEÑO de una cuenta ya resuelta, o `undefined` si el
   * tenant no existe.
   *
   * Aparte de `resolve` a propósito: sólo lo necesita el proveedor que restringe qué nodos pueden
   * ser dueños de su cuenta (TBO, D-TBO-03 A), y cambiar la consulta de `resolve` tocaría la
   * resolución de todos los proveedores. `tenants` no tiene RLS: leer el tipo de un ancestro es
   * lo mismo que ya hace la jerarquía.
   */
  async ownerTenantType(ownerTenantId: string): Promise<TenantType | undefined> {
    const row = await this.db.db
      .selectFrom('tenants')
      .select('tenant_type')
      .where('id', '=', ownerTenantId)
      .executeTakeFirst();
    return row?.tenant_type;
  }

  /**
   * Una cuenta PROPIA y activa del tenant, por id, con el secreto descifrado. SOLO uso interno: es
   * la cuenta con la que la conciliación lee las reservas de la cuenta entera (docs/tbo/04 §9.2).
   *
   * Se lee con el tenant fijado y la RLS de `provider_accounts` hace el resto: la cuenta de otro
   * tenant, incluida la de un ancestro, no existe para esta consulta.
   *
   * @throws NotFoundException si no es una cuenta activa del tenant para ese proveedor.
   */
  async resolveOwnAccount(
    ownerTenantId: string,
    accountId: string,
    providerCode: string,
  ): Promise<ResolvedProviderAccount> {
    const row = await this.db.withTenant(ownerTenantId, (trx) =>
      trx
        .selectFrom('provider_accounts')
        .select([
          'id',
          'tenant_id',
          'provider_code',
          'label',
          'credentials_enc',
          'config',
          'updated_at',
        ])
        .where('id', '=', accountId)
        .where('tenant_id', '=', ownerTenantId)
        .where('provider_code', '=', providerCode)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (row === undefined) {
      // Sin ids en el mensaje: la excepción puede llegar a un log.
      throw new NotFoundException('la cuenta de proveedor no es una cuenta activa del tenant');
    }
    return {
      id: row.id,
      ownerTenantId: row.tenant_id,
      providerCode: row.provider_code,
      label: row.label,
      config: (row.config ?? {}) as Record<string, unknown>,
      credentials: JSON.parse(decryptCredentials(row.credentials_enc)) as Record<string, unknown>,
      inherited: false,
      updatedAt: row.updated_at as unknown as Date,
    };
  }

  /**
   * Las cuentas propias y activas del tenant para esos proveedores, sin secreto: qué cuentas tiene
   * que conciliar (una corrida por cuenta, docs/tbo/04 §9.2). Con el tenant fijado, como todo lo que
   * lee `provider_accounts`.
   */
  async listActiveOwnAccounts(
    tenantId: string,
    providerCodes: readonly string[],
  ): Promise<{ id: string; providerCode: string }[]> {
    if (providerCodes.length === 0) return [];
    const rows = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('provider_accounts')
        .select(['id', 'provider_code'])
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .where('provider_code', 'in', [...providerCodes])
        .orderBy('id')
        .execute(),
    );
    return rows.map((r) => ({ id: r.id, providerCode: r.provider_code }));
  }

  /**
   * Crea o actualiza (upsert) una cuenta de proveedor del tenant. Cifra el secreto.
   *
   * @throws ProviderAccountInUseError si el cambio saca de servicio una cuenta con reservas activas
   *   (RF-29 CA 2): dejarla de `active`, apuntarla a otra cuenta del proveedor (otro usuario, otro
   *   entorno) o dejar de heredarla con reservas de la red hechas con ella.
   */
  async upsert(input: {
    tenantId: string;
    providerCode: string;
    label?: string;
    credentials: Record<string, unknown>;
    config?: Record<string, unknown>;
    isInheritable?: boolean;
    status?: ProviderAccountStatus;
  }): Promise<{ id: string }> {
    const label = input.label ?? 'default';
    const enc = encryptCredentials(JSON.stringify(input.credentials));
    const status = input.status ?? 'sandbox';
    const isInheritable = input.isInheritable ?? true;

    return this.db.withTenant(input.tenantId, async (trx) => {
      // FOR UPDATE choca con el FOR KEY SHARE que toma la FK de `orders.provider_account_id`: una
      // orden que se está creando con esta cuenta termina antes de contar, y una nueva espera a que
      // este cambio se comprometa (y lo ve, ver `OrderCreateIntentStore`). Sin el bloqueo, una orden
      // comprometida entre el conteo y el UPDATE quedaría colgada de una cuenta que ya no la atiende.
      const existing = await trx
        .selectFrom('provider_accounts')
        .select(['id', 'status', 'is_inheritable', 'config', 'credentials_enc'])
        .where('tenant_id', '=', input.tenantId)
        .where('provider_code', '=', input.providerCode)
        .where('label', '=', label)
        .forUpdate()
        .executeTakeFirst();

      if (existing) {
        await this.assertReleasable(trx, input.providerCode, existing, {
          status,
          isInheritable,
          credentials: input.credentials,
          config: input.config ?? {},
        });
        await trx
          .updateTable('provider_accounts')
          .set({
            credentials_enc: enc,
            config: JSON.stringify(input.config ?? {}),
            is_inheritable: isInheritable,
            status,
          })
          .where('id', '=', existing.id)
          .execute();
        return { id: existing.id };
      }

      const created = await trx
        .insertInto('provider_accounts')
        .values({
          tenant_id: input.tenantId,
          provider_code: input.providerCode,
          label,
          credentials_enc: enc,
          config: JSON.stringify(input.config ?? {}),
          is_inheritable: isInheritable,
          status,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: created.id };
    });
  }

  /**
   * Reservas activas hechas con la cuenta, en toda la red que la hereda
   * (`provider_account_active_orders`, 0045). Corre en la transacción del dueño: `undefined` = la
   * base no contestó por ella (la cuenta no es del tenant activo), que NO es "no hay reservas".
   */
  private async activeOrdersOf(
    trx: Transaction<DB>,
    accountId: string,
  ): Promise<ProviderAccountActiveOrders | undefined> {
    const result = await sql<{ own_orders: number | string; inherited_orders: number | string }>`
      SELECT own_orders, inherited_orders FROM provider_account_active_orders(${accountId}::uuid)
    `.execute(trx);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { own: Number(row.own_orders), inherited: Number(row.inherited_orders) };
  }

  /**
   * RF-29 CA 2. Sólo mira lo que saca la cuenta de servicio: dejarla de `active`, apuntarla a otra
   * cuenta del proveedor (`accountIdentity` de su spec) o dejar de heredarla. Rotar la contraseña del
   * mismo usuario, o cambiar lo que no identifica la cuenta, no consulta nada.
   *
   * Corre en la transacción del UPDATE y con la fila de la cuenta bloqueada (`upsert`): el conteo ve
   * toda orden comprometida con ella, y ninguna nueva se compromete hasta que el cambio termine.
   */
  private async assertReleasable(
    trx: Transaction<DB>,
    providerCode: string,
    current: {
      id: string;
      status: ProviderAccountStatus;
      is_inheritable: boolean;
      config: unknown;
      credentials_enc: Buffer;
    },
    next: {
      status: ProviderAccountStatus;
      isInheritable: boolean;
      credentials: Record<string, unknown>;
      config: Record<string, unknown>;
    },
  ): Promise<void> {
    const wasActive = current.status === 'active';
    const deactivates = wasActive && next.status !== 'active';
    // Una cuenta que no está activa no atiende la post-venta de nadie (0045): cambiarla no suelta nada.
    const changesIdentity =
      wasActive &&
      !deactivates &&
      accountIdentityChanged(
        providerCode,
        {
          credentials: () =>
            this.storedCredentials(current.credentials_enc, current.id, providerCode),
          config: (current.config ?? {}) as Record<string, unknown>,
        },
        { credentials: next.credentials, config: next.config },
      );
    const stopsInheritance = current.is_inheritable && !next.isInheritable;
    if (!deactivates && !changesIdentity && !stopsInheritance) return;

    // Desactivarla o cambiarle la identidad se la quita a todos, y cuentan todas sus reservas; dejar
    // de heredarla sólo a la red, y cuentan las de la red. El primer caso incluye al segundo.
    const release: ProviderAccountRelease = deactivates
      ? 'deactivate'
      : changesIdentity
        ? 'change-identity'
        : 'stop-inheritance';
    const active = await this.activeOrdersOf(trx, current.id);
    if (active === undefined) throw new ProviderAccountInUseError(release, null);
    const blocking =
      release === 'stop-inheritance' ? active.inherited : active.own + active.inherited;
    if (blocking > 0) throw new ProviderAccountInUseError(release, blocking);
  }

  /** El blob guardado, para comparar la identidad de la cuenta. `null` si no se puede leer. */
  private storedCredentials(
    blob: Buffer,
    accountId: string,
    providerCode: string,
  ): Record<string, unknown> | null {
    const stored = readCredentialsBlob(blob);
    if (stored === null) {
      this.logger.warn(
        `credenciales ilegibles en la cuenta ${accountId} (${providerCode}): se compara sólo la configuración`,
      );
    }
    return stored;
  }

  /**
   * Lista las cuentas del tenant SIN exponer el secreto.
   *
   * `config` NO sale verbatim. Es un JSONB en claro y por API se le puede meter cualquier cosa
   * —un `epr`, una contraseña—, así que se filtra por la lista blanca declarada del proveedor y
   * lo que no está declarado sale sólo como NOMBRE de clave (ver `safeConfigView`).
   *
   * El blob cifrado se descifra acá para saber QUÉ CLAVES trae y poder decir si la cuenta está
   * completa. Sólo se leen los nombres: el texto plano no sale de este método ni entra en ningún
   * log. Es la única forma de contestar la pregunta, porque una cuenta incompleta nunca llega a
   * `resolve` (que además filtra por `status = 'active'`).
   */
  async listSafe(tenantId: string): Promise<SafeProviderAccount[]> {
    const rows = await this.db.withTenant(tenantId, async (trx) =>
      trx
        .selectFrom('provider_accounts')
        .select([
          'id',
          'provider_code',
          'label',
          'config',
          'credentials_enc',
          'is_inheritable',
          'status',
          'created_at',
          'updated_at',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('provider_code')
        .execute(),
    );

    return rows.map((r) => {
      const config = (r.config ?? {}) as Record<string, unknown>;
      const view = safeConfigView(r.provider_code, config);
      const completeness = accountReadiness(
        r.provider_code,
        this.credentialKeyNames(r.credentials_enc, r.id, r.provider_code),
        config,
      );

      return {
        id: r.id,
        providerCode: r.provider_code,
        label: r.label,
        config: view.config,
        redactedConfigKeys: view.redactedConfigKeys,
        configVerified: view.configVerified,
        readiness: completeness.readiness,
        missingRequiredFields: completeness.missingRequiredFields,
        isInheritable: r.is_inheritable,
        status: r.status,
        createdAt: r.created_at as unknown as Date,
        updatedAt: r.updated_at as unknown as Date,
      };
    });
  }

  /**
   * NOMBRES de las credenciales que traen valor útil, o `null` si el blob no se pudo leer
   * (clave rotada, cifrado corrupto). `null` es "no sé", y quien lo consume no puede convertirlo
   * en "está completa".
   *
   * El `catch` no propaga a propósito: una cuenta ilegible no puede tumbar el listado entero de
   * la agencia, que es justo la pantalla desde la que se arregla.
   */
  private credentialKeyNames(
    blob: Buffer,
    accountId: string,
    providerCode: string,
  ): readonly string[] | null {
    const stored = readCredentialsBlob(blob);
    if (stored === null) {
      this.logger.warn(
        `credenciales ilegibles en la cuenta ${accountId} (${providerCode}): completitud desconocida`,
      );
      return null;
    }
    return Object.entries(stored)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key]) => key);
  }
}
