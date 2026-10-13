import { Global, Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { AuditService } from './audit.service.js';
import { UserAuditController } from './user-audit.controller.js';

/**
 * Global: cualquier módulo puede inyectar AuditService para emitir eventos de auditoría.
 *
 * Importa NetworkModule para autorizar el historial de una persona (UserAuditController). No hay
 * ciclo: NetworkModule sólo importa DatabaseModule.
 */
@Global()
@Module({
  imports: [NetworkModule],
  controllers: [UserAuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
