import { Injectable, Module } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { SabreProviderFactory } from '../providers-sabre/sabre.factory.js';
import { SabreProviderModule } from '../providers-sabre/sabre.module.js';
import { FlightProviderRegistry } from './flight-provider.registry.js';
import {
  FLIGHT_PROVIDER_FACTORIES,
  FLIGHT_PROVIDER_FLAGS,
  type FlightProviderAdapter,
  type ProviderFlagsPort,
  type TenantProviderFactory,
} from './provider.types.js';

const EntriesSchema = z.array(z.string().regex(/^[a-z0-9-]+(@[0-9a-fA-F-]{36})?$/));

/**
 * Gobierno de `callPolicy: 'opt-in'` por variable de entorno, mientras Unleash (el gestor de
 * feature flags del stack) no esté aprovisionado.
 *
 * `FLIGHT_PROVIDERS_OPT_IN=code` activa el proveedor para todos los tenants;
 * `FLIGHT_PROVIDERS_OPT_IN=code@<tenantId>` sólo para ese tenant.
 *
 * El día que llegue Unleash se cambia el `useClass` de abajo y nada más: ni el registry ni el
 * fan-out conocen esta implementación, sólo el port.
 */
@Injectable()
export class EnvProviderFlags implements ProviderFlagsPort {
  private readonly entries: ReadonlySet<string>;

  constructor() {
    this.entries = new Set(
      EntriesSchema.parse(
        (process.env['FLIGHT_PROVIDERS_OPT_IN'] ?? '')
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
 * Provee el registry de proveedores de vuelos. Sumar un proveedor es: importar su módulo,
 * añadir su factory al array de `FLIGHT_PROVIDER_FACTORIES` y nada más — ni la búsqueda ni
 * las órdenes ni la post-venta se enteran.
 */
@Module({
  imports: [LatamNdcProviderModule, SabreProviderModule],
  providers: [
    {
      provide: FLIGHT_PROVIDER_FACTORIES,
      useFactory: (
        latam: LatamNdcProviderFactory,
        sabre: SabreProviderFactory,
      ): TenantProviderFactory<FlightProviderAdapter>[] => [latam, sabre],
      inject: [LatamNdcProviderFactory, SabreProviderFactory],
    },
    { provide: FLIGHT_PROVIDER_FLAGS, useClass: EnvProviderFlags },
    FlightProviderRegistry,
  ],
  exports: [FlightProviderRegistry],
})
export class ProvidersModule {}
