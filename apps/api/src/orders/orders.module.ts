import { Module } from '@nestjs/common';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [LatamNdcProviderModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
