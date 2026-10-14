import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { AdminInvitationsController } from './admin-invitations.controller.js';
import { AdminInvitationsService } from './admin-invitations.service.js';
import { AdminController } from './admin.controller.js';
import { InvitationPreviewController } from './invitation-preview.controller.js';
import { InvitationPreviewService } from './invitation-preview.service.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { LegacyPasswordsController } from './legacy-passwords.controller.js';
import { LegacyPasswordsService } from './legacy-passwords.service.js';
import { MemberDetailController } from './member-detail.controller.js';
import { MemberDetailService } from './member-detail.service.js';
import { MemberSupportController } from './member-support.controller.js';
import { MemberSupportService } from './member-support.service.js';
import { PlatformUsersService } from './platform-users.service.js';
import { SeatsController } from './seats.controller.js';
import { SeatsService } from './seats.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';
import { UserExportController } from './user-export.controller.js';
import { UserExportService } from './user-export.service.js';

@Module({
  imports: [NetworkModule, ProviderEnablementModule],
  controllers: [
    TenantsController,
    AdminController,
    InvitationsController,
    InvitationPreviewController,
    SeatsController,
    MemberSupportController,
    MemberDetailController,
    AdminInvitationsController,
    UserExportController,
    LegacyPasswordsController,
  ],
  providers: [
    InvitationsService,
    InvitationPreviewService,
    TenantsService,
    SeatsService,
    MemberSupportService,
    PlatformUsersService,
    MemberDetailService,
    AdminInvitationsService,
    UserExportService,
    LegacyPasswordsService,
  ],
})
export class TenantsModule {}
