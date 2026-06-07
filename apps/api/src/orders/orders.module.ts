import { Module } from '@nestjs/common';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { PostSaleWorker } from './post-sale.worker.js';

@Module({
  imports: [LatamNdcProviderModule],
  controllers: [OrdersController],
  providers: [OrdersService, PostSaleWorker],
})
export class OrdersModule {}
