import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  GOVERNANCE_CATALOG,
  governanceItems,
  isGovernedItem,
  type GovernanceItemKey,
  type GovernedProvider,
} from '@sales-travel/domain';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { EnvProviderFlags } from '../providers/providers.module.js';
import { EnvHotelProviderFlags } from '../providers/hotel-providers.module.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { effectiveMatrix, type GovernanceCell } from './governance.policy.js';
import { GovernanceStore } from './governance.store.js';

/**
 * Eventos de auditoría del gobierno. Van al tenant plataforma (donde cuelga el superadmin) y caen en
 * la categoría «Proveedores» de Plataforma → Actividad (prefijo `platform.provider`).
 */
export const GOVERNANCE_EVENTS = {
  profileCreated: 'platform.provider_governance.profile.created',
  profileUpdated: 'platform.provider_governance.profile.updated',
  profileArchived: 'platform.provider_governance.profile.archived',
  profileDefaultChanged: 'platform.provider_governance.profile.default_changed',
  profileAssigned: 'platform.provider_governance.profile.assigned',
  ruleUpdated: 'platform.provider_governance.rule.updated',
} as const;

/** Nombre del perfil que siembra la configuración vigente el día que entra el gobierno. */
export const BOOTSTRAP_PROFILE_NAME = 'Configuración vigente';

/**
 * Formas de pago que la plataforma usaba el día del gobierno y se siembran encendidas para no cortar
 * ventas. El enlace de pago, el efectivo y GOV de LATAM no se ofrecían: nacen apagados.
 */
const BOOTSTRAP_METHODS_ON: readonly GovernanceItemKey[] = [
  { provider: 'latam-ndc', method: 'card' },
  { provider: 'sabre', method: 'cash' },
  { provider: 'sabre', method: 'on_account' },
  { provider: 'sabre', method: 'invoice' },
  { provider: 'despegar-hotels', method: 'card_token' },
  { provider: 'agent-cars', method: 'prepaid' },
  { provider: 'agent-cars', method: 'pay_at_destination' },
];

export interface ProfileItem extends GovernanceItemKey {
  readonly enabled: boolean;
}

export interface ProfileView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isDefaultForNewNodes: boolean;
  readonly archived: boolean;
  readonly items: readonly ProfileItem[];
  /** Nodos que lo tienen asignado. */
  readonly tenantCount: number;
  readonly updatedAt: Date;
}

export interface RuleView extends GovernanceItemKey {
  readonly tenantId: string | null;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedAt: Date;
}

export interface TenantGovernanceView {
  readonly tenant: { readonly id: string; readonly name: string; readonly type: string };
  readonly profile: { readonly id: string; readonly name: string } | null;
  readonly rules: readonly RuleView[];
  /** La matriz efectiva, con el nombre del nodo de donde sale cada celda heredada. */
  readonly effective: readonly (GovernanceCell & { readonly originTenantName: string | null })[];
}

export interface ProfileInput {
  readonly name: string;
  readonly description?: string | null;
  readonly items: readonly ProfileItem[];
}

/**
 * Administración del gobierno de proveedores y formas de pago (docs/platform/17-opciones-de-pago.md):
 * perfiles enlazados, su asignación a nodos, reglas a mano y la vista efectiva.
 *
 * La AUTORIZACIÓN (sólo superadmin) la valida el controlador; la base la vuelve a exigir (RLS de
 * 0089 con `is_platform_superadmin()`). Cada escritura va con su `domain_event` en la misma
 * transacción, e invalida la caché que leen búsquedas y pagos.
 */
@Injectable()
export class GovernanceAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GovernanceAdminService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly store: GovernanceStore,
    private readonly audit: AuditService,
    private readonly flights: FlightProviderRegistry,
    private readonly hotels: HotelProviderRegistry,
    private readonly legacyFlights: EnvProviderFlags,
    private readonly legacyHotels: EnvHotelProviderFlags,
  ) {}

  // ---- Siembra ---------------------------------------------------------------------------------

  /**
   * Una sola vez en la vida de la base: crea «Configuración vigente» con lo que estaba encendido de
   * hecho y lo asigna a la plataforma. Corre en el API y no en la migración porque depende de la
   * política efectiva de cada proveedor y de las variables legado, que sólo el API conoce.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env['GOVERNANCE_BOOTSTRAP'] === 'off') return;
    try {
      const created = await this.bootstrap();
      if (created)
        this.logger.log(`gobierno sembrado: perfil «${BOOTSTRAP_PROFILE_NAME}» en la plataforma`);
    } catch (err) {
      // No tumba el arranque: sin siembra el gobierno no decide y manda el decisor de siempre.
      this.logger.error(`no se pudo sembrar el gobierno: ${(err as Error).message}`);
    }
  }

  async bootstrap(): Promise<boolean> {
    const items = this.bootstrapItems();
    const tenantRules = this.bootstrapTenantRules();
    const result = await sql<{ id: string | null }>`
      SELECT governance_bootstrap(
        ${BOOTSTRAP_PROFILE_NAME},
        ${JSON.stringify(items)}::jsonb,
        ${JSON.stringify(tenantRules)}::jsonb
      ) AS id
    `.execute(this.db.db);
    this.store.invalidate();
    return Boolean(result.rows[0]?.id);
  }

  /** Proveedores que la variable legado encendía para un tenant concreto (`codigo@<tenantId>`). */
  bootstrapTenantRules(): { provider: string; tenantId: string }[] {
    return [
      ...this.flights.registeredProviders().map((p) => ({ p, legacy: this.legacyFlights })),
      ...this.hotels.registeredProviders().map((p) => ({ p, legacy: this.legacyHotels })),
    ].flatMap(({ p, legacy }) =>
      legacy.describe(p.code).tenantIds.map((tenantId) => ({ provider: p.code, tenantId })),
    );
  }

  /** Lo encendido de hecho hoy: la política efectiva (o la variable legado global) y los métodos en uso. */
  bootstrapItems(): { provider: string; method: string; enabled: boolean }[] {
    const registered = [
      ...this.flights.registeredProviders().map((p) => ({ ...p, legacy: this.legacyFlights })),
      ...this.hotels.registeredProviders().map((p) => ({ ...p, legacy: this.legacyHotels })),
    ];
    return governanceItems().map((key) => {
      if (key.method !== '') {
        const on = BOOTSTRAP_METHODS_ON.some(
          (m) => m.provider === key.provider && m.method === key.method,
        );
        return { provider: key.provider, method: key.method, enabled: on };
      }
      const reg = registered.find((p) => p.code === key.provider);
      // AgentCars no pasa por los registries: hoy está disponible si tiene credenciales.
      if (reg === undefined) return { provider: key.provider, method: '', enabled: true };
      const enabled =
        reg.callPolicy !== 'opt-in' || reg.legacy.describe(key.provider).allTenants === true;
      return { provider: key.provider, method: '', enabled };
    });
  }

  // ---- Lecturas --------------------------------------------------------------------------------

  catalog(): readonly GovernedProvider[] {
    return GOVERNANCE_CATALOG;
  }

  async listProfiles(): Promise<ProfileView[]> {
    const profiles = await sql<{
      id: string;
      name: string;
      description: string | null;
      is_default_for_new_nodes: boolean;
      archived_at: Date | null;
      updated_at: Date;
      tenant_count: number | string;
    }>`
      SELECT p.id, p.name, p.description, p.is_default_for_new_nodes, p.archived_at, p.updated_at,
             (SELECT count(*) FROM tenant_governance_profiles a WHERE a.profile_id = p.id) AS tenant_count
      FROM governance_profiles p
      ORDER BY p.archived_at NULLS FIRST, lower(p.name)
    `.execute(this.db.db);
    const items = await sql<{
      profile_id: string;
      provider_code: string;
      payment_method: string;
      enabled: boolean;
    }>`SELECT profile_id, provider_code, payment_method, enabled FROM governance_profile_items`.execute(
      this.db.db,
    );
    return profiles.rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isDefaultForNewNodes: p.is_default_for_new_nodes,
      archived: p.archived_at !== null,
      updatedAt: p.updated_at,
      tenantCount: Number(p.tenant_count),
      items: items.rows
        .filter((i) => i.profile_id === p.id)
        .map((i) => ({ provider: i.provider_code, method: i.payment_method, enabled: i.enabled })),
    }));
  }

  async profile(id: string): Promise<ProfileView> {
    const found = (await this.listProfiles()).find((p) => p.id === id);
    if (!found) throw new NotFoundException('El perfil no existe.');
    return found;
  }

  async rules(tenantId: string | null): Promise<RuleView[]> {
    const rows = await sql<{
      provider_code: string;
      payment_method: string;
      tenant_id: string | null;
      enabled: boolean;
      reason: string | null;
      updated_at: Date;
    }>`
      SELECT provider_code, '' AS payment_method, tenant_id, enabled, reason, updated_at
        FROM provider_enablement WHERE tenant_id IS NOT DISTINCT FROM ${tenantId}::uuid
      UNION ALL
      SELECT provider_code, payment_method, tenant_id, enabled, reason, updated_at
        FROM payment_method_rules WHERE tenant_id IS NOT DISTINCT FROM ${tenantId}::uuid
      ORDER BY 1, 2
    `.execute(this.db.db);
    return rows.rows.map((r) => ({
      provider: r.provider_code,
      method: r.payment_method,
      tenantId: r.tenant_id,
      enabled: r.enabled,
      reason: r.reason,
      updatedAt: r.updated_at,
    }));
  }

  /** La vista de un nodo: perfil, reglas a mano y matriz efectiva con el origen de cada celda. */
  async tenantView(tenantId: string): Promise<TenantGovernanceView> {
    const tenant = await this.tenant(tenantId);
    const [assigned, rules, snapshot] = await Promise.all([
      sql<{ id: string; name: string }>`
        SELECT p.id, p.name FROM tenant_governance_profiles a
        JOIN governance_profiles p ON p.id = a.profile_id WHERE a.tenant_id = ${tenantId}::uuid
      `.execute(this.db.db),
      this.rules(tenantId),
      this.store.snapshotFor(tenantId),
    ]);
    const matrix = effectiveMatrix(snapshot.rows);
    const originIds = [
      ...new Set(
        matrix
          .map((c) => ('tenantId' in c.origin ? c.origin.tenantId : null))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const names = new Map<string, string>();
    if (originIds.length > 0) {
      const rows = await this.db.db
        .selectFrom('tenants')
        .select(['id', 'name'])
        .where('id', 'in', originIds)
        .execute();
      rows.forEach((r) => names.set(r.id, r.name));
    }
    return {
      tenant,
      profile: assigned.rows[0] ?? null,
      rules,
      effective: matrix.map((c) => ({
        ...c,
        originTenantName:
          'tenantId' in c.origin && c.origin.tenantId
            ? (names.get(c.origin.tenantId) ?? null)
            : null,
      })),
    };
  }

  // ---- Perfiles --------------------------------------------------------------------------------

  async createProfile(actor: string, input: ProfileInput): Promise<ProfileView> {
    const items = this.checkItems(input.items);
    const id = await this.db
      .withRequestContext({ userId: actor }, async (trx) => {
        const created = await sql<{ id: string }>`
        INSERT INTO governance_profiles (name, description, created_by, updated_by)
        VALUES (${input.name.trim()}, ${input.description ?? null}, ${actor}::uuid, ${actor}::uuid)
        RETURNING id
      `.execute(trx);
        const profileId = created.rows[0]!.id;
        await this.replaceItems(trx, profileId, items);
        await this.emit(trx, actor, GOVERNANCE_EVENTS.profileCreated, profileId, {
          name: input.name.trim(),
          items,
        });
        return profileId;
      })
      .catch(uniqueName);
    this.store.invalidate();
    return this.profile(id);
  }

  /** Edita nombre, descripción y/o reglas. ENLAZADO: cambia a todos los nodos que lo usan. */
  async updateProfile(
    actor: string,
    id: string,
    input: Partial<ProfileInput>,
  ): Promise<ProfileView> {
    const before = await this.profile(id);
    if (before.archived) throw new ConflictException('El perfil está archivado.');
    const items = input.items ? this.checkItems(input.items) : undefined;
    await this.db
      .withRequestContext({ userId: actor }, async (trx) => {
        await sql`
        UPDATE governance_profiles
           SET name = ${input.name?.trim() ?? before.name},
               description = ${input.description === undefined ? before.description : input.description},
               updated_by = ${actor}::uuid
         WHERE id = ${id}::uuid
      `.execute(trx);
        if (items) await this.replaceItems(trx, id, items);
        await this.emit(trx, actor, GOVERNANCE_EVENTS.profileUpdated, id, {
          before: { name: before.name, items: before.items },
          after: { name: input.name?.trim() ?? before.name, items: items ?? before.items },
          affectedTenants: before.tenantCount,
        });
      })
      .catch(uniqueName);
    this.store.invalidate();
    return this.profile(id);
  }

  async duplicateProfile(actor: string, id: string, name: string): Promise<ProfileView> {
    const source = await this.profile(id);
    return this.createProfile(actor, {
      name,
      description: source.description,
      items: source.items,
    });
  }

  /** Archivar exige que ningún nodo lo use: un nodo sin su perfil cambiaría lo que vende en silencio. */
  async archiveProfile(actor: string, id: string): Promise<ProfileView> {
    const before = await this.profile(id);
    if (before.tenantCount > 0) {
      throw new ConflictException(
        `El perfil está asignado a ${before.tenantCount} nodo(s). Reasígnalos antes de archivarlo.`,
      );
    }
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      await sql`
        UPDATE governance_profiles
           SET archived_at = now(), is_default_for_new_nodes = false, updated_by = ${actor}::uuid
         WHERE id = ${id}::uuid
      `.execute(trx);
      await this.emit(trx, actor, GOVERNANCE_EVENTS.profileArchived, id, { name: before.name });
    });
    return this.profile(id);
  }

  async setDefault(actor: string, id: string, isDefault: boolean): Promise<ProfileView> {
    const before = await this.profile(id);
    if (before.archived)
      throw new ConflictException('Un perfil archivado no puede ser el predeterminado.');
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      if (isDefault) {
        await sql`UPDATE governance_profiles SET is_default_for_new_nodes = false
                  WHERE is_default_for_new_nodes AND id <> ${id}::uuid`.execute(trx);
      }
      await sql`UPDATE governance_profiles SET is_default_for_new_nodes = ${isDefault},
                updated_by = ${actor}::uuid WHERE id = ${id}::uuid`.execute(trx);
      await this.emit(trx, actor, GOVERNANCE_EVENTS.profileDefaultChanged, id, {
        name: before.name,
        isDefault,
      });
    });
    return this.profile(id);
  }

  /** Asigna (o quita, con `null`) el perfil de un nodo. Sin perfil ni reglas, el nodo hereda. */
  async assignProfile(
    actor: string,
    tenantId: string,
    profileId: string | null,
  ): Promise<TenantGovernanceView> {
    await this.tenant(tenantId);
    if (profileId !== null) {
      const p = await this.profile(profileId);
      if (p.archived) throw new ConflictException('El perfil está archivado.');
    }
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const current = await sql<{ profile_id: string }>`
        SELECT profile_id FROM tenant_governance_profiles WHERE tenant_id = ${tenantId}::uuid FOR UPDATE
      `.execute(trx);
      const before = current.rows[0]?.profile_id ?? null;
      if (before === profileId) return;
      if (profileId === null) {
        await sql`DELETE FROM tenant_governance_profiles WHERE tenant_id = ${tenantId}::uuid`.execute(
          trx,
        );
      } else {
        await sql`
          INSERT INTO tenant_governance_profiles (tenant_id, profile_id, updated_by)
          VALUES (${tenantId}::uuid, ${profileId}::uuid, ${actor}::uuid)
          ON CONFLICT (tenant_id) DO UPDATE SET profile_id = EXCLUDED.profile_id, updated_by = EXCLUDED.updated_by
        `.execute(trx);
      }
      await this.emit(trx, actor, GOVERNANCE_EVENTS.profileAssigned, tenantId, {
        targetTenantId: tenantId,
        before,
        after: profileId,
      });
    });
    this.store.invalidate();
    return this.tenantView(tenantId);
  }

  /**
   * Pone o quita (con `enabled === null`) una regla a mano, global (`tenantId === null`) o de un
   * nodo. Las de proveedor van a `provider_enablement` (0048), las de forma de pago a
   * `payment_method_rules` (0089).
   */
  async setRule(
    actor: string,
    key: GovernanceItemKey,
    tenantId: string | null,
    next: { enabled: boolean; reason: string | null } | null,
  ): Promise<RuleView[]> {
    if (!isGovernedItem(key))
      throw new BadRequestException('Ese proveedor o forma de pago no existe.');
    if (tenantId !== null) await this.tenant(tenantId);
    const table = key.method === '' ? 'provider_enablement' : 'payment_method_rules';
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const methodFilter = key.method === '' ? sql`` : sql`AND payment_method = ${key.method}`;
      const current = await sql<{ enabled: boolean; reason: string | null }>`
        SELECT enabled, reason FROM ${sql.table(table)}
        WHERE provider_code = ${key.provider} ${methodFilter}
          AND tenant_id IS NOT DISTINCT FROM ${tenantId}::uuid
        FOR UPDATE
      `.execute(trx);
      const before = current.rows[0] ?? null;
      if (next === null) {
        if (before === null) return;
        await sql`DELETE FROM ${sql.table(table)}
          WHERE provider_code = ${key.provider} ${methodFilter}
            AND tenant_id IS NOT DISTINCT FROM ${tenantId}::uuid`.execute(trx);
      } else {
        if (before && before.enabled === next.enabled && before.reason === next.reason) return;
        if (before) {
          await sql`UPDATE ${sql.table(table)}
            SET enabled = ${next.enabled}, reason = ${next.reason}, updated_by = ${actor}::uuid
            WHERE provider_code = ${key.provider} ${methodFilter}
              AND tenant_id IS NOT DISTINCT FROM ${tenantId}::uuid`.execute(trx);
        } else if (key.method === '') {
          await sql`INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason, updated_by)
            VALUES (${key.provider}, ${tenantId}::uuid, ${next.enabled}, ${next.reason}, ${actor}::uuid)`.execute(
            trx,
          );
        } else {
          await sql`INSERT INTO payment_method_rules
              (provider_code, payment_method, tenant_id, enabled, reason, updated_by)
            VALUES (${key.provider}, ${key.method}, ${tenantId}::uuid, ${next.enabled}, ${next.reason}, ${actor}::uuid)`.execute(
            trx,
          );
        }
      }
      await this.emit(
        trx,
        actor,
        GOVERNANCE_EVENTS.ruleUpdated,
        `${key.provider}${key.method ? `.${key.method}` : ''}@${tenantId ?? 'global'}`,
        {
          ...key,
          scope: tenantId === null ? 'global' : 'tenant',
          targetTenantId: tenantId,
          before,
          after: next,
        },
      );
    });
    this.store.invalidate();
    return this.rules(tenantId);
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private checkItems(items: readonly ProfileItem[]): ProfileItem[] {
    const seen = new Set<string>();
    for (const item of items) {
      if (!isGovernedItem(item)) {
        throw new BadRequestException(
          `«${item.provider}${item.method ? ` / ${item.method}` : ''}» no está en el catálogo.`,
        );
      }
      const k = `${item.provider}|${item.method}`;
      if (seen.has(k)) throw new BadRequestException(`«${k}» está repetido en el perfil.`);
      seen.add(k);
    }
    return items.map((i) => ({ provider: i.provider, method: i.method, enabled: i.enabled }));
  }

  private async replaceItems(
    trx: Transaction<DB>,
    profileId: string,
    items: readonly ProfileItem[],
  ): Promise<void> {
    await sql`DELETE FROM governance_profile_items WHERE profile_id = ${profileId}::uuid`.execute(
      trx,
    );
    for (const i of items) {
      await sql`INSERT INTO governance_profile_items (profile_id, provider_code, payment_method, enabled)
        VALUES (${profileId}::uuid, ${i.provider}, ${i.method}, ${i.enabled})`.execute(trx);
    }
  }

  private async tenant(id: string): Promise<{ id: string; name: string; type: string }> {
    const row = await this.db.db
      .selectFrom('tenants')
      .select(['id', 'name', 'tenant_type'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('El nodo no existe.');
    return { id: row.id, name: row.name, type: String(row.tenant_type) };
  }

  private emit(
    trx: Transaction<DB>,
    actor: string,
    eventType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.emitWithin(trx, {
      eventType,
      actorUserId: actor,
      aggregateType: 'governance',
      aggregateId,
      payload,
    });
  }
}

function uniqueName(err: unknown): never {
  if ((err as { code?: string }).code === '23505') {
    throw new ConflictException('Ya existe un perfil activo con ese nombre.');
  }
  throw err;
}
