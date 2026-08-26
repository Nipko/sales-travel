import { Module } from '@nestjs/common';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { PostSaleWorker } from './post-sale.worker.js';

@Module({
  imports: [ProvidersModule, AgentCarsProviderModule],
  controllers: [OrdersController],
  providers: [OrdersService, PostSaleWorker],
  exports: [OrdersService],
})
export class OrdersModule {}
