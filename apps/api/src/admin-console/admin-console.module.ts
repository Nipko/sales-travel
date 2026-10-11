import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkModule } from '../network/network.module.js';
import { SearchModule } from '../search/search.module.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewService } from './admin-overview.service.js';

/**
 * La consola de la plataforma (`/admin/...`): las lecturas de toda la red que sólo ve el superadmin.
 * `SearchModule` por el circuit breaker, cuyo estado vive en memoria y es UNA instancia por réplica.
 */
@Module({
  imports: [DatabaseModule, NetworkModule, SearchModule],
  controllers: [AdminOverviewController],
  providers: [AdminOverviewService],
})
export class AdminConsoleModule {}
