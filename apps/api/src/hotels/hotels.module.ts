import { Module } from '@nestjs/common';
import { DespegarHotelsProviderModule } from '../providers-despegar/despegar-hotels.module.js';
import { HotelsController } from './hotels.controller.js';
import { HotelsService } from './hotels.service.js';

@Module({
  imports: [DespegarHotelsProviderModule],
  controllers: [HotelsController],
  providers: [HotelsService],
})
export class HotelsModule {}
