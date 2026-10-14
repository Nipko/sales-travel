import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';
import { ProfileService } from './profile.service.js';

@Module({
  controllers: [MeController],
  providers: [ProfileService],
})
export class MeModule {}
