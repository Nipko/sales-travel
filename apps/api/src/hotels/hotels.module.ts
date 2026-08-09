import { Module } from '@nestjs/common';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchModule } from '../search/search.module.js';
import { HotelsController } from './hotels.controller.js';
import { HotelsService } from './hotels.service.js';

@Module({
  imports: [DespegarHotelsProviderModule, PricingModule, SearchModule],
  controllers: [HotelsController],
  providers: [HotelsService],
})
export class HotelsModule {}
