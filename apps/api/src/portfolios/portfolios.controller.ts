import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SalesOperation } from '../auth/decorators/sales-operation.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { PortfolioForbiddenError } from './portfolio-errors.js';
import {
  DepositReportsQuerySchema,
  HoldBookingSchema,
  IdempotencyKeySchema,
  OrderIdParamSchema,
  SubmitDepositReportSchema,
  TransactionsQuerySchema,
  type DepositReportsQuery,
  type HoldBookingDto,
  type SubmitDepositReportDto,
  type TransactionsQuery,
} from './portfolios.schemas.js';
import { PortfoliosService, type AgencyWalletsView } from './portfolios.service.js';
import {
  movementView,
  walletView,
  type DepositReportView,
  type WalletMovementView,
  type WalletView,
} from './wallet-store.js';

/**
 * Por qué la agencia ya no mueve su propia cartera (decisión del founder del 2026-09-29, opción A;
 * brecha crítica de la auditoría del 2026-09-28): el cupo, los depósitos y los ajustes los registra
 * quien la financia. Las rutas viejas responden 403 con el motivo en vez de desaparecer, para que
 * quien las siga llamando sepa qué hacer.
 */
const NOT_THE_AGENCY = {
  deposit:
    'Tu agencia no registra depósitos en su cartera: informalo en Cartera B2B y quien te financia lo aprueba.',
  withdraw:
    'Tu agencia no registra retiros ni ajustes en su cartera: los registra quien te financia.',
  creditLimit:
    'El cupo de la cartera lo fija quien financia a tu agencia: pedíselo a tu consolidador, a tu agencia o a Planetour.',
} as const;

/**
 * La cartera vista desde la agencia (Cartera B2B): sus carteras (una por moneda), sus movimientos y
 * los depósitos que informa. Y la retención de una reserva confirmada, que sigue siendo suya.
 */
@Roles(...SELLING_ROLES)
@Controller('portfolios')
export class PortfoliosController {
  constructor(
    private readonly portfolios: PortfoliosService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  @Get()
  async get(@CurrentUser() userId: string | undefined): Promise<AgencyWalletsView> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return this.portfolios.overview(tenantId);
  }

  @Get('transactions')
  async listTransactions(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(TransactionsQuerySchema)) query: TransactionsQuery,
  ): Promise<{ transactions: WalletMovementView[] }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return { transactions: await this.portfolios.listTransactions(tenantId, query.currency) };
  }

  @Get('deposit-reports')
  async listDepositReports(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(DepositReportsQuerySchema)) query: DepositReportsQuery,
  ): Promise<{ reports: DepositReportView[] }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return { reports: await this.portfolios.listDepositReports(tenantId, query.status) };
  }

  /**
   * La agencia informa un depósito (transferencia, consignación). Queda pendiente y no suma saldo
   * hasta que quien la financia lo aprueba. Lo informa un admin de la agencia.
   */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('deposit-reports')
  async submitDepositReport(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SubmitDepositReportSchema)) body: SubmitDepositReportDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ report: DepositReportView }> {
    if (!userId) throw new ForbiddenException();
    const key = new ZodValidationPipe(IdempotencyKeySchema).transform(idempotencyKey);
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId);
    return {
      report: await this.portfolios.submitDepositReport(userId, tenantId, body, key),
    };
  }

  @Post('deposit')
  deposit(): never {
    throw new PortfolioForbiddenError('PORTFOLIO_FINANCIER_REQUIRED', NOT_THE_AGENCY.deposit);
  }

  @Post('withdraw')
  withdraw(): never {
    throw new PortfolioForbiddenError('PORTFOLIO_FINANCIER_REQUIRED', NOT_THE_AGENCY.withdraw);
  }

  @Patch('credit-limit')
  updateLimit(): never {
    throw new PortfolioForbiddenError('PORTFOLIO_FINANCIER_REQUIRED', NOT_THE_AGENCY.creditLimit);
  }

  /** Retiene saldo por una reserva confirmada (vuelos y autos), en la cartera de su moneda. */
  @SalesOperation()
  @Post('hold-booking')
  async hold(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(HoldBookingSchema)) body: HoldBookingDto,
  ): Promise<{ portfolio: WalletView; transaction: WalletMovementView }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const expected = {
      ...(body.amountMinor === undefined ? {} : { amountMinor: body.amountMinor }),
      ...(body.currency === undefined ? {} : { currency: body.currency }),
    };
    const { portfolio, transaction } = await this.portfolios.holdBooking(
      tenantId,
      body.orderId,
      userId,
      expected,
    );
    return {
      portfolio: walletView(portfolio),
      transaction: movementView(transaction, portfolio.currency),
    };
  }

  @SalesOperation()
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('orders/:orderId/approve')
  async approve(
    @CurrentUser() userId: string | undefined,
    @Param('orderId', new ZodValidationPipe(OrderIdParamSchema)) orderId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId);

    return this.portfolios.approveBooking(tenantId, orderId);
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('orders/:orderId/reject')
  async reject(
    @CurrentUser() userId: string | undefined,
    @Param('orderId', new ZodValidationPipe(OrderIdParamSchema)) orderId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId);

    return this.portfolios.rejectBooking(tenantId, orderId, userId);
  }

  /**
   * Un admin con membership activa EN la agencia activa. RolesGuard deja pasar a los roles de
   * plataforma aunque operen sobre la agencia sin ser miembros; esta comprobación, no.
   */
  private async assertAdminMembership(userId: string, tenantId: string): Promise<void> {
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select('role')
        .where('user_id', '=', userId)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('not a member of this tenant');
      const adminRoles = [
        'superadmin',
        'platform_admin',
        'consolidator_admin',
        'tenant_admin',
        'agency_admin',
        'admin',
      ];
      if (!adminRoles.includes(row.role)) {
        throw new ForbiddenException('admin role required');
      }
    });
  }
}
