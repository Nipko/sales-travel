import { Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { EnablementSetting } from './provider-enablement.policy.js';

/**
 * Cuánto vale lo leído de la cadena de un tenant. Lo consulta cada búsqueda, una vez por
 * proveedor: sin caché serían N lecturas por búsqueda para un ajuste que cambia unas pocas veces
 * al mes. Con esto, un cambio hecho en OTRA réplica tarda como mucho esto en verse; en ésta se ve
 * al instante, porque escribir invalida.
 */
export const ENABLEMENT_CACHE_TTL_MS = 10_000;

/** Tope de tenants en caché. Al pasarlo se barren los vencidos, y si no alcanza, todo. */
const MAX_CACHED_TENANTS = 5_000;

/** Lo que el flag por tenant necesita del almacén. Existe para poder probarlo sin base. */
export interface EnablementSettingsSource {
  settingsFor(tenantId: string): Promise<readonly EnablementSetting[]>;
}

/** Un ajuste tal como lo ve el panel de la plataforma. */
export interface ProviderEnablementRow {
  readonly id: string;
  readonly providerCode: string;
  /** `null` = ajuste global. */
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly tenantSlug: string | null;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedBy: string | null;
  readonly updatedByEmail: string | null;
  readonly updatedAt: Date;
}

/** Lo que guarda un ajuste, para la auditoría del antes y el después. */
export interface EnablementValue {
  readonly enabled: boolean;
  readonly reason: string | null;
}

interface ChainRow {
  provider_code: string;
  tenant_id: string | null;
  lvl: number | string;
  enabled: boolean;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly settings: readonly EnablementSetting[];
}

/**
 * Ajustes de habilitación de proveedores (0048): la lectura de la cadena de un tenant, con una
 * caché corta en memoria, y el SQL de las escrituras, que corren en la transacción del servicio.
 */
@Injectable()
export class ProviderEnablementStore implements EnablementSettingsSource {
  private readonly logger = new Logger(ProviderEnablementStore.name);
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * Sube con cada invalidación. Una lectura que empezó antes de un cambio y termina después no
   * vuelve a llenar la caché con lo de antes.
   */
  private generation = 0;

  constructor(private readonly db: DatabaseService) {}

  /**
   * Los ajustes que pueden decidir para el tenant: los de su cadena y los globales.
   *
   * Si la lectura falla y hay una copia vencida, se usa la copia: una base que tose no puede
   * encender lo que el superadmin apagó. Sin copia, el error se propaga como el de la bóveda: la
   * búsqueda falla en vez de adivinar.
   */
  async settingsFor(tenantId: string): Promise<readonly EnablementSetting[]> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && cached.expiresAt > now) return cached.settings;

    const generation = this.generation;
    let settings: readonly EnablementSetting[];
    try {
      settings = await this.readChain(tenantId);
    } catch (err) {
      if (cached === undefined) throw err;
      this.logger.warn(
        `no se pudo releer la habilitación de proveedores; se usa la última lectura: ${(err as Error).name}`,
      );
      return cached.settings;
    }

    if (generation === this.generation) {
      if (this.cache.size >= MAX_CACHED_TENANTS) this.prune(now);
      this.cache.set(tenantId, { expiresAt: now + ENABLEMENT_CACHE_TTL_MS, settings });
    }
    return settings;
  }

  /** Olvida todo lo leído. Lo llama el servicio después de cada escritura que se confirmó. */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
  }

  /** Todos los ajustes, con el nombre del tenant y el correo de quien los puso. */
  async listRows(filter: { readonly tenantId?: string } = {}): Promise<ProviderEnablementRow[]> {
    let query = this.db.db
      .selectFrom('provider_enablement as s')
      .leftJoin('tenants as t', 't.id', 's.tenant_id')
      .leftJoin('users as u', 'u.id', 's.updated_by')
      .select([
        's.id',
        's.provider_code',
        's.tenant_id',
        't.name as tenant_name',
        't.slug as tenant_slug',
        's.enabled',
        's.reason',
        's.updated_by',
        'u.email as updated_by_email',
        's.updated_at',
      ])
      .orderBy('s.provider_code')
      .orderBy('t.name')
      .orderBy('s.id');
    if (filter.tenantId !== undefined) query = query.where('s.tenant_id', '=', filter.tenantId);

    const rows = await query.execute();
    return rows.map((r) => ({
      id: r.id,
      providerCode: r.provider_code,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      tenantSlug: r.tenant_slug,
      enabled: r.enabled,
      reason: r.reason,
      updatedBy: r.updated_by,
      updatedByEmail: r.updated_by_email,
      updatedAt: new Date(r.updated_at),
    }));
  }

  /** El ajuste actual de (proveedor, tenant o global), bloqueado hasta el fin de la transacción. */
  async lock(
    trx: Transaction<DB>,
    providerCode: string,
    tenantId: string | null,
  ): Promise<(EnablementValue & { readonly id: string }) | undefined> {
    let query = trx
      .selectFrom('provider_enablement')
      .select(['id', 'enabled', 'reason'])
      .where('provider_code', '=', providerCode);
    query =
      tenantId === null
        ? query.where('tenant_id', 'is', null)
        : query.where('tenant_id', '=', tenantId);
    return query.forUpdate().executeTakeFirst();
  }

  /** Crea o reemplaza el ajuste. Devuelve su id. */
  async upsert(
    trx: Transaction<DB>,
    input: {
      readonly providerCode: string;
      readonly tenantId: string | null;
      readonly enabled: boolean;
      readonly reason: string | null;
      readonly actorUserId: string;
    },
  ): Promise<string> {
    const values = {
      provider_code: input.providerCode,
      tenant_id: input.tenantId,
      enabled: input.enabled,
      reason: input.reason,
      updated_by: input.actorUserId,
    };
    const update = {
      enabled: input.enabled,
      reason: input.reason,
      updated_by: input.actorUserId,
      updated_at: sql<Date>`now()`,
    };
    const row = await trx
      .insertInto('provider_enablement')
      .values(values)
      .onConflict((oc) =>
        input.tenantId === null
          ? oc.column('provider_code').where('tenant_id', 'is', null).doUpdateSet(update)
          : oc
              .columns(['provider_code', 'tenant_id'])
              .where('tenant_id', 'is not', null)
              .doUpdateSet(update),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Quita el ajuste. `false` si no había ninguno. */
  async remove(
    trx: Transaction<DB>,
    providerCode: string,
    tenantId: string | null,
  ): Promise<boolean> {
    let query = trx.deleteFrom('provider_enablement').where('provider_code', '=', providerCode);
    query =
      tenantId === null
        ? query.where('tenant_id', 'is', null)
        : query.where('tenant_id', '=', tenantId);
    const res = await query.executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  /** La lectura de verdad, sin caché. Protegida para poder contar lecturas en los tests. */
  protected async readChain(tenantId: string): Promise<EnablementSetting[]> {
    const res = await sql<ChainRow>`
      SELECT * FROM provider_enablement_chain(${tenantId}::uuid)
    `.execute(this.db.db);
    return res.rows.map((r) => ({
      providerCode: r.provider_code,
      tenantId: r.tenant_id,
      depth: Number(r.lvl),
      enabled: r.enabled,
    }));
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    if (this.cache.size >= MAX_CACHED_TENANTS) this.cache.clear();
  }
}
