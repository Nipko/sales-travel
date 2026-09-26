import { Module } from '@nestjs/common';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { OrdersController } from './orders.controller.js';
import { ExternalOrderIntentService } from './external-order-intent.service.js';
import { OrdersService } from './orders.service.js';
import { PostSaleWorker } from './post-sale.worker.js';

@Module({
  imports: [ProvidersModule, AgentCarsProviderModule, PricingModule],
  controllers: [OrdersController],
  providers: [OrdersService, PostSaleWorker, ExternalOrderIntentService],
  exports: [OrdersService, ExternalOrderIntentService],
})
export class OrdersModule {}
