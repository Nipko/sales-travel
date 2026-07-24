import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { CrmOpportunitiesController } from './crm-opportunities.controller.js';
import { CrmOpportunitiesService } from './crm-opportunities.service.js';
import { CrmInteractionsController } from './crm-interactions.controller.js';
import { CrmInteractionsService } from './crm-interactions.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [CrmOpportunitiesController, CrmInteractionsController],
  providers: [CrmOpportunitiesService, CrmInteractionsService],
  exports: [CrmOpportunitiesService, CrmInteractionsService],
})
export class CrmModule {}
