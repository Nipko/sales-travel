import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkModule } from '../network/network.module.js';
import { ProviderEnablementAdminModule } from '../provider-enablement/provider-enablement-admin.module.js';
import { SearchModule } from '../search/search.module.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminTenantsController } from './admin-tenants.controller.js';
import { AdminTenantsService } from './admin-tenants.service.js';

/**
 * La consola de la plataforma (`/admin/...`): las lecturas de toda la red que sólo ve el superadmin.
 * `SearchModule` por el circuit breaker, cuyo estado vive en memoria y es UNA instancia por réplica;
 * `ProviderEnablementAdminModule` por el apagado de emergencia de cada proveedor, el mismo que
 * muestra Proveedores de la plataforma.
 *
 * Agencias en números (AdminTenantsController): puestos, ventas y pendientes de cada nodo, y qué
 * arrastraría suspender uno con su red.
 */
@Module({
  imports: [DatabaseModule, NetworkModule, SearchModule, ProviderEnablementAdminModule],
  controllers: [AdminOverviewController, AdminTenantsController],
  providers: [AdminOverviewService, AdminTenantsService],
})
export class AdminConsoleModule {}
