import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { AdminController } from './admin.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { TenantsController } from './tenants.controller.js';

@Module({
  imports: [NetworkModule],
  controllers: [TenantsController, AdminController, InvitationsController],
  providers: [InvitationsService],
})
export class TenantsModule {}
