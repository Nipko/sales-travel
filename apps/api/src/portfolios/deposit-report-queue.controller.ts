import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  DepositReportQueueQuerySchema,
  type DepositReportQueueQuery,
} from './deposit-report-queue.schemas.js';
import {
  DepositReportQueueService,
  type DepositReportQueueView,
  type PendingDepositReportsCount,
} from './deposit-report-queue.service.js';

/**
 * Plataforma → Carteras: los depósitos informados de toda la red, en una sola cola.
 *
 * Sólo el superadmin, como el resto del panel de la plataforma: `@Roles` deja fuera a los roles de
 * nodo y {@link SuperadminGuard} a `platform_admin`. Sólo lee; aprobar y rechazar van por las rutas
 * de cada nodo (WalletFinancingController), que son las que escriben el asiento y dejan el rastro. No
 * es venta: el superadmin financia a la red.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/deposit-reports')
export class DepositReportQueueController {
  constructor(private readonly queue: DepositReportQueueService) {}

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(DepositReportQueueQuerySchema)) query: DepositReportQueueQuery,
  ): Promise<DepositReportQueueView> {
    return this.queue.list(userId, query);
  }

  /** El contador del menú (Plataforma → Carteras). */
  @Get('pending-count')
  async pendingCount(@CurrentUser() userId: string): Promise<PendingDepositReportsCount> {
    return this.queue.pendingCount(userId);
  }
}
