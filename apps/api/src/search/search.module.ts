import { Module } from '@nestjs/common';
import { LatamNdcProviderModule } from '../providers-latam/latam-ndc.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [LatamNdcProviderModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
