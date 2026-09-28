import { Injectable, Module } from '@nestjs/common';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { PlatformProviderFlags } from '../provider-enablement/platform-provider-flags.js';
import { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { SabreProviderFactory } from '../providers-sabre/sabre.factory.js';
import { SabreProviderModule } from '../providers-sabre/sabre.module.js';
import { FlightProviderRegistry } from './flight-provider.registry.js';
import { describeLegacyOptIn, parseLegacyOptIn, type LegacyOptIn } from './legacy-opt-in.js';
import {
  FLIGHT_PROVIDER_FACTORIES,
  FLIGHT_PROVIDER_FLAGS,
  type FlightProviderAdapter,
  type ProviderEnablementDecision,
  type ProviderFlagsPort,
  type TenantProviderFactory,
} from './provider.types.js';

/**
 * LEGADO: el encendido de proveedores de vuelos por variable de entorno de antes de que el
 * superadmin lo gobernara desde el panel (`provider_enablement`, 0048).
 *
 * `FLIGHT_PROVIDERS_OPT_IN=code` activa el proveedor para todos los tenants;
 * `FLIGHT_PROVIDERS_OPT_IN=code@<tenantId>` sólo para ese tenant.
 *
 * Sigue contando, y sólo para encender, cuando en la base no hay ningún ajuste de ese proveedor
 * para el tenant (ver {@link PlatformProviderFlags}): así no se apaga nada de lo que ya estaba
 * encendido por entorno el día del despliegue. Un ajuste del panel siempre le gana.
 */
@Injectable()
export class EnvProviderFlags implements ProviderFlagsPort {
  private readonly entries: ReadonlySet<string>;

  constructor() {
    this.entries = parseLegacyOptIn(process.env['FLIGHT_PROVIDERS_OPT_IN']);
  }

  isEnabledForTenant(tenantId: string, providerCode: string): Promise<boolean> {
    return Promise.resolve(
      this.entries.has(providerCode) || this.entries.has(`${providerCode}@${tenantId}`),
    );
  }

  async decisionFor(
    tenantId: string,
    providerCode: string,
  ): Promise<ProviderEnablementDecision | undefined> {
    return (await this.isEnabledForTenant(tenantId, providerCode))
      ? { enabled: true, origin: 'legacy-env' }
      : undefined;
  }

  /** Para el panel: a quién enciende todavía la variable. */
  describe(providerCode: string): LegacyOptIn {
    return describeLegacyOptIn(this.entries, providerCode);
  }
}

/**
 * Provee el registry de proveedores de vuelos. Sumar un proveedor es: importar su módulo,
 * añadir su factory al array de `FLIGHT_PROVIDER_FACTORIES` y nada más — ni la búsqueda ni
 * las órdenes ni la post-venta se enteran.
 *
 * La habilitación por tenant la dan los ajustes del superadmin, con la variable legado detrás.
 */
@Module({
  imports: [LatamNdcProviderModule, SabreProviderModule, ProviderEnablementModule],
  providers: [
    {
      provide: FLIGHT_PROVIDER_FACTORIES,
      useFactory: (
        latam: LatamNdcProviderFactory,
        sabre: SabreProviderFactory,
      ): TenantProviderFactory<FlightProviderAdapter>[] => [latam, sabre],
      inject: [LatamNdcProviderFactory, SabreProviderFactory],
    },
    EnvProviderFlags,
    {
      provide: FLIGHT_PROVIDER_FLAGS,
      useFactory: (store: ProviderEnablementStore, legacy: EnvProviderFlags): ProviderFlagsPort =>
        new PlatformProviderFlags(store, legacy),
      inject: [ProviderEnablementStore, EnvProviderFlags],
    },
    FlightProviderRegistry,
  ],
  exports: [FlightProviderRegistry, EnvProviderFlags],
})
export class ProvidersModule {}
