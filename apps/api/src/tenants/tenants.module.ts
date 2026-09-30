import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { AdminController } from './admin.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { MemberSupportController } from './member-support.controller.js';
import { MemberSupportService } from './member-support.service.js';
import { SeatsController } from './seats.controller.js';
import { SeatsService } from './seats.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  imports: [NetworkModule, ProviderEnablementModule],
  controllers: [
    TenantsController,
    AdminController,
    InvitationsController,
    SeatsController,
    MemberSupportController,
  ],
  providers: [InvitationsService, TenantsService, SeatsService, MemberSupportService],
})
export class TenantsModule {}
