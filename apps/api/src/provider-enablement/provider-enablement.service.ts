import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { EnvHotelProviderFlags } from '../providers/hotel-providers.module.js';
import type { LegacyOptIn } from '../providers/legacy-opt-in.js';
import {
  isProviderEnabled,
  type CallPolicy,
  type ProviderEnablementDecision,
  type ProviderEnablementEntry,
  type ProviderVertical,
  type RegisteredProvider,
} from '../providers/provider.types.js';
import { EnvProviderFlags } from '../providers/providers.module.js';
import { killLevel, type KillLevel } from '../search/circuit-breaker.service.js';
import { effectiveEnablement, type EffectiveEnablement } from './provider-enablement.policy.js';
import {
  ProviderEnablementStore,
  type EnablementValue,
  type ProviderEnablementRow,
} from './provider-enablement.store.js';

/** Tipo del `domain_event` de cada cambio. Uno solo, con el antes y el después en el payload. */
export const PROVIDER_ENABLEMENT_EVENT = 'platform.provider_enablement.updated';

/** Un ajuste, tal como lo muestra el panel. */
export interface EnablementSettingView {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedBy: string | null;
  readonly updatedByEmail: string | null;
  /** ISO 8601. */
  readonly updatedAt: string;
}

export interface TenantOverrideView extends EnablementSettingView {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly tenantSlug: string | null;
}

/** El estado efectivo con el nombre del tenant cuyo ajuste decidió, si fue uno. */
export interface EffectiveEnablementView extends EffectiveEnablement {
  readonly originTenantName?: string | null;
}

interface ProviderBaseView {
  readonly code: string;
  readonly vertical: ProviderVertical;
  readonly callPolicy: CallPolicy;
  /** Sin ningún ajuste ni variable legado: `opt-in` apagado, el resto encendido. */
  readonly defaultEnabled: boolean;
  /** Nivel en `PROVIDERS_DISABLED`, que le gana a todo; `null` si no está. */
  readonly killSwitch: KillLevel | null;
  /** Lo que la variable legado de la vertical enciende todavía. */
  readonly legacyEnv: LegacyOptIn;
}

/** Un proveedor en la lista de la plataforma: su ajuste global y las excepciones por tenant. */
export interface PlatformProviderView extends ProviderBaseView {
  readonly global: EnablementSettingView | null;
  readonly overrides: readonly TenantOverrideView[];
  /**
   * Lo que ve un tenant sin ajustes propios ni de su red y sin entrada propia en la variable
   * legado: kill-switch, luego el global, luego la variable para todos, luego la política.
   */
  readonly baseline: EffectiveEnablement;
}

/** Un proveedor visto desde UN tenant. */
export interface TenantProviderView extends ProviderBaseView {
  /** El ajuste del propio tenant; `null` = hereda. */
  readonly own: EnablementSettingView | null;
  readonly effective: EffectiveEnablementView;
}

export interface TenantProvidersView {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly providers: readonly TenantProviderView[];
}

/** El proveedor no está en ningún registry de la plataforma. */
export class UnknownPlatformProviderError extends NotFoundException {
  constructor(readonly providerCode: string) {
    super(`El proveedor '${providerCode}' no existe en la plataforma.`);
    this.name = 'UnknownPlatformProviderError';
  }
}

export class PlatformTenantNotFoundError extends NotFoundException {
  constructor() {
    super('El tenant no existe.');
    this.name = 'PlatformTenantNotFoundError';
  }
}

function settingView(row: ProviderEnablementRow): EnablementSettingView {
  return {
    enabled: row.enabled,
    reason: row.reason,
    updatedBy: row.updatedBy,
    updatedByEmail: row.updatedByEmail,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function byVerticalThenCode(a: RegisteredProvider, b: RegisteredProvider): number {
  if (a.vertical !== b.vertical) return a.vertical < b.vertical ? -1 : 1;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * La habilitación de proveedores desde el panel de la plataforma: qué dice cada ajuste, qué ve cada
 * tenant y los cambios, cada uno auditado en la misma transacción que lo escribe.
 *
 * La AUTORIZACIÓN (sólo superadmin) la valida el controlador antes de llamar; la base la vuelve a
 * exigir en la escritura (RLS de 0048).
 */
@Injectable()
export class ProviderEnablementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly store: ProviderEnablementStore,
    private readonly flights: FlightProviderRegistry,
    private readonly hotels: HotelProviderRegistry,
    private readonly audit: AuditService,
    private readonly legacyFlights: EnvProviderFlags,
    private readonly legacyHotels: EnvHotelProviderFlags,
  ) {}

  /** Todos los proveedores de los registries, con su ajuste global y sus excepciones. */
  async list(): Promise<PlatformProviderView[]> {
    const rows = await this.store.listRows();
    return this.registered().map((p) => this.platformView(p, rows));
  }

  /** Lo que ve un tenant de cada proveedor, y por qué. */
  async forTenant(tenantId: string): Promise<TenantProvidersView> {
    const tenant = await this.tenant(tenantId);
    const [flights, hotels, rows] = await Promise.all([
      this.flights.enablementOf(tenantId),
      this.hotels.enablementOf(tenantId),
      this.store.listRows(),
    ]);
    const names = new Map(
      rows.flatMap((r) => (r.tenantId === null ? [] : [[r.tenantId, r.tenantName] as const])),
    );

    const providers = [...flights, ...hotels]
      .sort(byVerticalThenCode)
      .map((entry: ProviderEnablementEntry): TenantProviderView => {
        const own = rows.find((r) => r.providerCode === entry.code && r.tenantId === tenantId);
        const effective = effectiveEnablement({
          killSwitch: killLevel(entry.code),
          decision: entry.decision,
          callPolicy: entry.callPolicy,
        });
        return {
          ...this.baseView(entry),
          own: own === undefined ? null : settingView(own),
          effective:
            effective.originTenantId === undefined
              ? effective
              : { ...effective, originTenantName: names.get(effective.originTenantId) ?? null },
        };
      });

    return { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, providers };
  }

  async setGlobal(
    actorUserId: string,
    providerCode: string,
    value: EnablementValue,
  ): Promise<PlatformProviderView> {
    this.provider(providerCode);
    await this.write(actorUserId, providerCode, null, value);
    return this.viewOf(providerCode);
  }

  async clearGlobal(actorUserId: string, providerCode: string): Promise<PlatformProviderView> {
    this.provider(providerCode);
    await this.write(actorUserId, providerCode, null, null);
    return this.viewOf(providerCode);
  }

  async setTenant(
    actorUserId: string,
    providerCode: string,
    tenantId: string,
    value: EnablementValue,
  ): Promise<PlatformProviderView> {
    this.provider(providerCode);
    await this.tenant(tenantId);
    await this.write(actorUserId, providerCode, tenantId, value);
    return this.viewOf(providerCode);
  }

  async clearTenant(
    actorUserId: string,
    providerCode: string,
    tenantId: string,
  ): Promise<PlatformProviderView> {
    this.provider(providerCode);
    await this.tenant(tenantId);
    await this.write(actorUserId, providerCode, tenantId, null);
    return this.viewOf(providerCode);
  }

  /**
   * Escribe (o quita, con `next === null`) un ajuste y su `domain_event` en UNA transacción: un
   * cambio sin rastro no entra. Con el usuario en el contexto, que es lo que la RLS de 0048 mira
   * para dejar escribir.
   *
   * Un cambio que no cambia nada no escribe ni audita: el panel puede reenviar el mismo estado.
   * Después de confirmar, se olvida la caché de ESTA réplica; las demás lo ven al vencer la suya.
   *
   * El evento va al tenant del request (el de la plataforma, donde cuelga el superadmin) y no al
   * tenant afectado: el motivo es una nota interna de la plataforma y la auditoría de una red la
   * leen sus administradores.
   */
  private async write(
    actorUserId: string,
    providerCode: string,
    tenantId: string | null,
    next: EnablementValue | null,
  ): Promise<void> {
    const changed = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const current = await this.store.lock(trx, providerCode, tenantId);
      const before: EnablementValue | null =
        current === undefined ? null : { enabled: current.enabled, reason: current.reason };

      if (next === null) {
        if (before === null) return false;
        await this.store.remove(trx, providerCode, tenantId);
      } else {
        if (before !== null && before.enabled === next.enabled && before.reason === next.reason) {
          return false;
        }
        await this.store.upsert(trx, {
          providerCode,
          tenantId,
          enabled: next.enabled,
          reason: next.reason,
          actorUserId,
        });
      }

      await this.audit.emitWithin(trx, {
        eventType: PROVIDER_ENABLEMENT_EVENT,
        actorUserId,
        aggregateType: 'provider_enablement',
        aggregateId: tenantId === null ? providerCode : `${providerCode}@${tenantId}`,
        payload: {
          providerCode,
          scope: tenantId === null ? 'global' : 'tenant',
          targetTenantId: tenantId,
          before,
          after: next,
        },
      });
      return true;
    });
    if (changed) this.store.invalidate();
  }

  private async viewOf(providerCode: string): Promise<PlatformProviderView> {
    const rows = await this.store.listRows();
    return this.platformView(this.provider(providerCode), rows);
  }

  private platformView(
    provider: RegisteredProvider,
    rows: readonly ProviderEnablementRow[],
  ): PlatformProviderView {
    const mine = rows.filter((r) => r.providerCode === provider.code);
    const global = mine.find((r) => r.tenantId === null);
    const base = this.baseView(provider);
    const decision: ProviderEnablementDecision | undefined =
      global !== undefined
        ? { enabled: global.enabled, origin: 'global' }
        : base.legacyEnv.allTenants
          ? { enabled: true, origin: 'legacy-env' }
          : undefined;

    return {
      ...base,
      global: global === undefined ? null : settingView(global),
      overrides: mine.flatMap((r) =>
        r.tenantId === null
          ? []
          : [
              {
                ...settingView(r),
                tenantId: r.tenantId,
                tenantName: r.tenantName,
                tenantSlug: r.tenantSlug,
              },
            ],
      ),
      baseline: effectiveEnablement({
        killSwitch: base.killSwitch ?? undefined,
        decision,
        callPolicy: provider.callPolicy,
      }),
    };
  }

  private baseView(provider: RegisteredProvider): ProviderBaseView {
    const legacy = provider.vertical === 'hotels' ? this.legacyHotels : this.legacyFlights;
    return {
      code: provider.code,
      vertical: provider.vertical,
      callPolicy: provider.callPolicy,
      defaultEnabled: isProviderEnabled(undefined, provider.callPolicy),
      killSwitch: killLevel(provider.code) ?? null,
      legacyEnv: legacy.describe(provider.code),
    };
  }

  private registered(): RegisteredProvider[] {
    return [...this.flights.registeredProviders(), ...this.hotels.registeredProviders()].sort(
      byVerticalThenCode,
    );
  }

  private provider(providerCode: string): RegisteredProvider {
    const found = this.registered().find((p) => p.code === providerCode);
    if (found === undefined) throw new UnknownPlatformProviderError(providerCode);
    return found;
  }

  private async tenant(tenantId: string): Promise<{ id: string; name: string; slug: string }> {
    const row = await this.db.db
      .selectFrom('tenants')
      .select(['id', 'name', 'slug'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) throw new PlatformTenantNotFoundError();
    return row;
  }
}
