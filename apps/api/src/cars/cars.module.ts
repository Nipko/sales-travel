import { Module } from '@nestjs/common';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { CarsController } from './cars.controller.js';
import { CarsPendingSweepScheduler } from './cars-pending-sweep.scheduler.js';
import { CarsPendingSweepService } from './cars-pending-sweep.service.js';
import { CarsService } from './cars.service.js';
import { CARS_SELECTION_CACHE, CarSelectionStore } from './car-selection.store.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';

@Module({
  imports: [
    AgentCarsProviderModule,
    PricingModule,
    OrdersModule,
    AuditModule,
    ProviderEnablementModule,
  ],
  controllers: [CarsController],
  providers: [
    CarsService,
    CarsPendingSweepService,
    CarsPendingSweepScheduler,
    // El neto de cada selección (AUT-05): su propia instancia, que la caché de búsquedas no desaloje.
    CarSelectionStore,
    { provide: CARS_SELECTION_CACHE, useClass: MemoryCacheAdapter },
  ],
})
export class CarsModule {}
