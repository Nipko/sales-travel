import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { BookingPermissionsController } from './booking-permissions.controller.js';
import { BookingPermissionsService } from './booking-permissions.service.js';

/**
 * Los permisos de reserva de cada nodo, que fija quien lo financia (db/migrations/0055).
 * `HotelsModule` lo importa para rechazar el PreBook y el Book de una tarifa no reembolsable
 * bloqueada. `AuditModule` es global.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [BookingPermissionsController],
  providers: [BookingPermissionsService],
  exports: [BookingPermissionsService],
})
export class BookingPermissionsModule {}
