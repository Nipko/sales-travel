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

@Module({
  imports: [
    AgentCarsProviderModule,
    PricingModule,
    OrdersModule,
    AuditModule,
    ProviderEnablementModule,
  ],
  controllers: [CarsController],
  providers: [CarsService, CarsPendingSweepService, CarsPendingSweepScheduler],
})
export class CarsModule {}
