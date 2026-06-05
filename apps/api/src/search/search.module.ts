import { Module } from '@nestjs/common';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [LatamNdcProviderModule, PricingModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
