import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { AdminInvitationsController } from './admin-invitations.controller.js';
import { AdminInvitationsService } from './admin-invitations.service.js';
import { AdminController } from './admin.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { MemberDetailController } from './member-detail.controller.js';
import { MemberDetailService } from './member-detail.service.js';
import { MemberSupportController } from './member-support.controller.js';
import { MemberSupportService } from './member-support.service.js';
import { PlatformUsersService } from './platform-users.service.js';
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
    MemberDetailController,
    AdminInvitationsController,
  ],
  providers: [
    InvitationsService,
    TenantsService,
    SeatsService,
    MemberSupportService,
    PlatformUsersService,
    MemberDetailService,
    AdminInvitationsService,
  ],
})
export class TenantsModule {}
