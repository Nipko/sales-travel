import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkService } from './network.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [NetworkService],
  exports: [NetworkService],
})
export class NetworkModule {}
