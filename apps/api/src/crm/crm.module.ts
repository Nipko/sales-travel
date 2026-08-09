import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { CrmOpportunitiesController } from './crm-opportunities.controller.js';
import { CrmOpportunitiesService } from './crm-opportunities.service.js';
import { CrmTasksController } from './crm-tasks.controller.js';
import { CrmTasksService } from './crm-tasks.service.js';
import { NetworkModule } from '../network/network.module.js';
import { CrmInteractionsController } from './crm-interactions.controller.js';
import { CrmInteractionsService } from './crm-interactions.service.js';

@Module({
  imports: [DatabaseModule, NetworkModule],
  controllers: [CrmOpportunitiesController, CrmInteractionsController, CrmTasksController],
  providers: [CrmOpportunitiesService, CrmInteractionsService, CrmTasksService],
  exports: [CrmOpportunitiesService, CrmInteractionsService],
})
export class CrmModule {}
