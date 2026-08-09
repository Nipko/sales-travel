import { Module } from '@nestjs/common';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

@Module({
  imports: [LatamNdcProviderModule, PricingModule],
  controllers: [SearchController],
  providers: [SearchService, SearchTelemetryService, CircuitBreakerService, MemoryCacheAdapter],
  exports: [SearchTelemetryService, CircuitBreakerService, MemoryCacheAdapter],
})
export class SearchModule {}
