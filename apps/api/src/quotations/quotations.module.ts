import { Module } from '@nestjs/common';
import { QuotationsController } from './quotations.controller.js';
import { QuotationsService } from './quotations.service.js';

@Module({
  controllers: [QuotationsController],
  providers: [QuotationsService],
})
export class QuotationsModule {}
