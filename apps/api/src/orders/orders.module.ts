import { Module } from '@nestjs/common';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { PostSaleWorker } from './post-sale.worker.js';

@Module({
  imports: [LatamNdcProviderModule, AgentCarsProviderModule],
  controllers: [OrdersController],
  providers: [OrdersService, PostSaleWorker],
  exports: [OrdersService],
})
export class OrdersModule {}
