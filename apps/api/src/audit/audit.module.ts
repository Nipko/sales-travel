import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Global: cualquier módulo puede inyectar AuditService para emitir eventos de auditoría. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
