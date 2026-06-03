import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { AdminController } from './admin.controller.js';
import { TenantsController } from './tenants.controller.js';

@Module({
  imports: [NetworkModule],
  controllers: [TenantsController, AdminController],
})
export class TenantsModule {}
