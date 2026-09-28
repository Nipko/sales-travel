import { Injectable, Module } from '@nestjs/common';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { PlatformProviderFlags } from '../provider-enablement/platform-provider-flags.js';
import { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { DespegarHotelsProviderFactory } from '../providers-despegar/despegar-hotels.factory.js';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import { TboHotelsProviderModule } from '../providers-tbo/tbo-hotels.module.js';
import { HotelProviderRegistry } from './hotel-provider.registry.js';
import {
  HOTEL_PROVIDER_FACTORIES,
  HOTEL_PROVIDER_FLAGS,
  type HotelProviderFactory,
} from './hotel-provider.types.js';
import { describeLegacyOptIn, parseLegacyOptIn, type LegacyOptIn } from './legacy-opt-in.js';
import type { ProviderEnablementDecision, ProviderFlagsPort } from './provider.types.js';

/**
 * LEGADO: el encendido de proveedores de hoteles por variable de entorno de antes de que el
 * superadmin lo gobernara desde el panel (`provider_enablement`, 0048). Espejo de
 * `EnvProviderFlags` de vuelos, con su propia variable.
 *
 * `HOTEL_PROVIDERS_OPT_IN=code` activa el proveedor para todos los tenants;
 * `HOTEL_PROVIDERS_OPT_IN=code@<tenantId>` sólo para ese tenant.
 *
 * Sigue contando, y sólo para encender, cuando en la base no hay ningún ajuste de ese proveedor
 * para el tenant (ver {@link PlatformProviderFlags}). Un ajuste del panel siempre le gana.
 *
 * No lee `FLIGHT_PROVIDERS_OPT_IN`: encender un proveedor de vuelos para una agencia no puede
 * encender uno de hoteles, que cobra y factura distinto.
 */
@Injectable()
export class EnvHotelProviderFlags implements ProviderFlagsPort {
  private readonly entries: ReadonlySet<string>;

  constructor() {
    this.entries = parseLegacyOptIn(process.env['HOTEL_PROVIDERS_OPT_IN']);
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
 * Provee el registry de proveedores de hoteles. Sumar un proveedor es: importar su módulo,
 * añadir su factory al array de `HOTEL_PROVIDER_FACTORIES` y nada más.
 *
 * La habilitación por tenant la dan los ajustes del superadmin, con la variable legado detrás.
 */
@Module({
  imports: [DespegarHotelsProviderModule, TboHotelsProviderModule, ProviderEnablementModule],
  providers: [
    {
      provide: HOTEL_PROVIDER_FACTORIES,
      useFactory: (
        despegar: DespegarHotelsProviderFactory,
        tbo: TboHotelsProviderFactory,
      ): HotelProviderFactory[] => [despegar, tbo],
      inject: [DespegarHotelsProviderFactory, TboHotelsProviderFactory],
    },
    EnvHotelProviderFlags,
    {
      provide: HOTEL_PROVIDER_FLAGS,
      useFactory: (
        store: ProviderEnablementStore,
        legacy: EnvHotelProviderFlags,
      ): ProviderFlagsPort => new PlatformProviderFlags(store, legacy),
      inject: [ProviderEnablementStore, EnvHotelProviderFlags],
    },
    HotelProviderRegistry,
  ],
  exports: [HotelProviderRegistry, EnvHotelProviderFlags],
})
export class HotelProvidersModule {}
