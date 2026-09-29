import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { AdminController } from './admin.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  imports: [NetworkModule, ProviderEnablementModule],
  controllers: [TenantsController, AdminController, InvitationsController],
  providers: [InvitationsService, TenantsService],
})
export class TenantsModule {}
