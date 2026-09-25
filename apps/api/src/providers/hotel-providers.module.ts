import { Injectable, Module } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { DespegarHotelsProviderFactory } from '../providers-despegar/despegar-hotels.factory.js';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { HotelProviderRegistry } from './hotel-provider.registry.js';
import {
  HOTEL_PROVIDER_FACTORIES,
  HOTEL_PROVIDER_FLAGS,
  type HotelProviderFactory,
} from './hotel-provider.types.js';
import type { ProviderFlagsPort } from './provider.types.js';

const EntriesSchema = z.array(z.string().regex(/^[a-z0-9-]+(@[0-9a-fA-F-]{36})?$/));

/**
 * Gobierno de `callPolicy: 'opt-in'` de hoteles por variable de entorno, mientras Unleash no
 * esté aprovisionado. Espejo de `EnvProviderFlags` de vuelos, con su propia variable.
 *
 * `HOTEL_PROVIDERS_OPT_IN=code` activa el proveedor para todos los tenants;
 * `HOTEL_PROVIDERS_OPT_IN=code@<tenantId>` sólo para ese tenant.
 *
 * No lee `FLIGHT_PROVIDERS_OPT_IN`: encender un proveedor de vuelos para una agencia no puede
 * encender uno de hoteles, que cobra y factura distinto.
 */
@Injectable()
export class EnvHotelProviderFlags implements ProviderFlagsPort {
  private readonly entries: ReadonlySet<string>;

  constructor() {
    this.entries = new Set(
      EntriesSchema.parse(
        (process.env['HOTEL_PROVIDERS_OPT_IN'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
  }

  isEnabledForTenant(tenantId: string, providerCode: string): Promise<boolean> {
    return Promise.resolve(
      this.entries.has(providerCode) || this.entries.has(`${providerCode}@${tenantId}`),
    );
  }
}

/**
 * Provee el registry de proveedores de hoteles. Sumar un proveedor es: importar su módulo,
 * añadir su factory al array de `HOTEL_PROVIDER_FACTORIES` y nada más.
 */
@Module({
  imports: [DespegarHotelsProviderModule],
  providers: [
    {
      provide: HOTEL_PROVIDER_FACTORIES,
      useFactory: (despegar: DespegarHotelsProviderFactory): HotelProviderFactory[] => [despegar],
      inject: [DespegarHotelsProviderFactory],
    },
    { provide: HOTEL_PROVIDER_FLAGS, useClass: EnvHotelProviderFlags },
    HotelProviderRegistry,
  ],
  exports: [HotelProviderRegistry],
})
export class HotelProvidersModule {}
