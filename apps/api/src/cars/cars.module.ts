import { Module } from '@nestjs/common';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { CarsController } from './cars.controller.js';
import { CarsService } from './cars.service.js';

@Module({
  imports: [AgentCarsProviderModule, PricingModule],
  controllers: [CarsController],
  providers: [CarsService],
})
export class CarsModule {}
