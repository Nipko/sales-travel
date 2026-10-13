import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkService } from './network.service.js';
import { SuperadminGuard } from './superadmin.guard.js';

@Module({
  imports: [DatabaseModule],
  providers: [NetworkService, SuperadminGuard],
  exports: [NetworkService, SuperadminGuard],
})
export class NetworkModule {}
