import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { TenantsController } from './tenants.controller.js';

@Module({
  controllers: [TenantsController, AdminController],
})
export class TenantsModule {}
