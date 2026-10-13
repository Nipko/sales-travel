import { Controller, ForbiddenException, Get, Query, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
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

/** Quien no es superadmin no ve la cola de toda la red. 403. */
export class DepositReportQueueSuperadminOnlyError extends ForbiddenException {
  readonly reason = 'DEPOSIT_REPORT_QUEUE_SUPERADMIN_ONLY';

  constructor() {
    super(
      'Sólo el superadmin ve los depósitos informados de toda la red. Los de un nodo se ven en sus carteras.',
    );
    this.name = 'DepositReportQueueSuperadminOnlyError';
  }
}

/**
 * Plataforma → Aprobaciones: los depósitos informados de toda la red, en una sola cola.
 *
 * Sólo el superadmin, como el resto del panel de la plataforma (`/admin/tenants`, `/admin/providers`):
 * `@Roles` deja fuera a los roles de nodo y la comprobación explícita a `platform_admin`. Sólo lee;
 * aprobar y rechazar van por las rutas de cada nodo (WalletFinancingController), que son las que
 * escriben el asiento y dejan el rastro. No es venta: el superadmin financia a la red.
 */
@Roles(...PLATFORM_ROLES)
@Controller('admin/deposit-reports')
export class DepositReportQueueController {
  constructor(
    private readonly queue: DepositReportQueueService,
    private readonly network: NetworkService,
  ) {}

  @Get()
  async list(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(DepositReportQueueQuerySchema)) query: DepositReportQueueQuery,
  ): Promise<DepositReportQueueView> {
    return this.queue.list(await this.assertSuperadmin(userId), query);
  }

  /** El contador del menú (Plataforma → Aprobaciones). */
  @Get('pending-count')
  async pendingCount(
    @CurrentUser() userId: string | undefined,
  ): Promise<PendingDepositReportsCount> {
    return this.queue.pendingCount(await this.assertSuperadmin(userId));
  }

  private async assertSuperadmin(userId: string | undefined): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new DepositReportQueueSuperadminOnlyError();
    }
    return userId;
  }
}
