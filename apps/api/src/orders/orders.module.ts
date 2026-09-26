import { Module } from '@nestjs/common';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ExternalOrderIntentService } from './external-order-intent.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [ProvidersModule, AgentCarsProviderModule, PricingModule],
  controllers: [OrdersController],
  // El worker de post-venta vive en `PostSaleModule`: enruta también jobs de hoteles, y
  // `HotelsModule` ya importa este módulo.
  providers: [OrdersService, ExternalOrderIntentService],
  exports: [OrdersService, ExternalOrderIntentService],
})
export class OrdersModule {}
