import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { NetworkModule } from '../network/network.module.js';
import {
  ChangeRequestsController,
  PlatformAdminsController,
} from './platform-admins.controller.js';
import { PlatformAdminsService } from './platform-admins.service.js';
import { SupervisionService } from './supervision.service.js';

/**
 * Superadmins plenos y supervisados (docs/platform/16). Global: cada módulo con rutas sensibles
 * (gobierno, proveedores, usuarios) usa {@link SupervisionService} como puerta y registra cómo se
 * aplica cada tipo de cambio, sin que este módulo dependa de ellos.
 */
@Global()
@Module({
  imports: [AuditModule, AuthModule, NetworkModule],
  controllers: [PlatformAdminsController, ChangeRequestsController],
  providers: [SupervisionService, PlatformAdminsService],
  exports: [SupervisionService],
})
export class PlatformAdminsModule {}
