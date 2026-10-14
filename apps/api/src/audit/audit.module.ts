import { Global, Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { AdminAuditController } from './admin-audit.controller.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AuditService } from './audit.service.js';
import { UserAuditController } from './user-audit.controller.js';

/**
 * Global: cualquier módulo puede inyectar AuditService para emitir eventos de auditoría.
 *
 * Importa NetworkModule para autorizar el historial de una persona (UserAuditController) y para la
 * puerta del superadmin de Plataforma → Actividad (AdminAuditController, SuperadminGuard). No hay
 * ciclo: NetworkModule sólo importa DatabaseModule.
 */
@Global()
@Module({
  imports: [NetworkModule],
  controllers: [UserAuditController, AdminAuditController],
  providers: [AuditService, AdminAuditService],
  exports: [AuditService],
})
export class AuditModule {}
