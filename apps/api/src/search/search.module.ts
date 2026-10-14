import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProviderDisclosureModule } from '../provider-disclosure/provider-disclosure.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

/**
 * `ProviderEnablementModule` por el almacén de los apagados de emergencia del panel (0077), que el
 * circuit breaker consulta en cada llamada a un proveedor.
 */
@Module({
  imports: [ProvidersModule, PricingModule, ProviderDisclosureModule, ProviderEnablementModule],
  controllers: [SearchController],
  providers: [SearchService, SearchTelemetryService, CircuitBreakerService, MemoryCacheAdapter],
  exports: [SearchTelemetryService, CircuitBreakerService, MemoryCacheAdapter],
})
export class SearchModule {}
