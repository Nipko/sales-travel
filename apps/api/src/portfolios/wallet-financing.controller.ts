import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ApproveDepositReportSchema,
  DepositReportIdParamSchema,
  DepositReportsQuerySchema,
  EnableWalletSchema,
  IdempotencyKeySchema,
  PortfolioIdParamSchema,
  RecordAdjustmentSchema,
  RecordDepositSchema,
  RejectDepositReportSchema,
  TenantIdParamSchema,
  TransactionsQuerySchema,
  UpdateWalletSchema,
  type ApproveDepositReportDto,
  type DepositReportsQuery,
  type EnableWalletDto,
  type RecordAdjustmentDto,
  type RecordDepositDto,
  type RejectDepositReportDto,
  type TransactionsQuery,
  type UpdateWalletDto,
} from './portfolios.schemas.js';
import {
  WalletFinancingService,
  type FinancedWalletsView,
  type ResolvedDepositReport,
  type WalletEntryResult,
} from './wallet-financing.service.js';
import type { DepositReportView, WalletMovementView, WalletView } from './wallet-store.js';

/**
 * Las carteras de un nodo, gestionadas por quien lo financia: el superadmin desde Gestión de
 * Agencias (cualquier nodo) y un consolidador o una agencia desde Mi Red (sus agencias o sus
 * sub-agencias).
 *
 * `@Roles` sólo deja fuera a quien no administra ningún nodo (vendedores, clientes); si quien actúa
 * financia a ESE nodo lo decide la base (`can_finance_tenant`) en el servicio, antes de escribir, y
 * de nuevo en cada escritura. La agencia nunca gestiona su propia cartera.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('tenants/:tenantId/portfolios')
export class WalletFinancingController {
  constructor(private readonly financing: WalletFinancingService) {}

  @Get()
  async overview(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<FinancedWalletsView> {
    return this.financing.overview(actor(userId), tenantId);
  }

  /** Habilita una moneda: abre la cartera del nodo en ella. */
  @Post()
  async enableCurrency(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(EnableWalletSchema)) body: EnableWalletDto,
  ): Promise<{ portfolio: WalletView }> {
    return { portfolio: await this.financing.enableCurrency(actor(userId), tenantId, body) };
  }

  @Get('transactions')
  async listTransactions(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Query(new ZodValidationPipe(TransactionsQuerySchema)) query: TransactionsQuery,
  ): Promise<{ transactions: WalletMovementView[] }> {
    return {
      transactions: await this.financing.listMovements(actor(userId), tenantId, query.currency),
    };
  }

  @Get('deposit-reports')
  async listDepositReports(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Query(new ZodValidationPipe(DepositReportsQuerySchema)) query: DepositReportsQuery,
  ): Promise<{ reports: DepositReportView[] }> {
    return {
      reports: await this.financing.listDepositReports(actor(userId), tenantId, query.status),
    };
  }

  @Post('deposit-reports/:reportId/approve')
  async approveDepositReport(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('reportId', new ZodValidationPipe(DepositReportIdParamSchema)) reportId: string,
    @Body(new ZodValidationPipe(ApproveDepositReportSchema)) body: ApproveDepositReportDto,
  ): Promise<ResolvedDepositReport> {
    return this.financing.approveDepositReport(actor(userId), tenantId, reportId, body);
  }

  @Post('deposit-reports/:reportId/reject')
  async rejectDepositReport(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('reportId', new ZodValidationPipe(DepositReportIdParamSchema)) reportId: string,
    @Body(new ZodValidationPipe(RejectDepositReportSchema)) body: RejectDepositReportDto,
  ): Promise<ResolvedDepositReport> {
    return this.financing.rejectDepositReport(actor(userId), tenantId, reportId, body);
  }

  /** Fija el cupo, o suspende y reactiva la cartera. */
  @Patch(':portfolioId')
  async updateWallet(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('portfolioId', new ZodValidationPipe(PortfolioIdParamSchema)) portfolioId: string,
    @Body(new ZodValidationPipe(UpdateWalletSchema)) body: UpdateWalletDto,
  ): Promise<{ portfolio: WalletView }> {
    return {
      portfolio: await this.financing.updateWallet(actor(userId), tenantId, portfolioId, body),
    };
  }

  @Post(':portfolioId/deposits')
  async recordDeposit(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('portfolioId', new ZodValidationPipe(PortfolioIdParamSchema)) portfolioId: string,
    @Body(new ZodValidationPipe(RecordDepositSchema)) body: RecordDepositDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WalletEntryResult> {
    const key = new ZodValidationPipe(IdempotencyKeySchema).transform(idempotencyKey);
    return this.financing.recordDeposit(actor(userId), tenantId, portfolioId, body, key);
  }

  @Post(':portfolioId/adjustments')
  async recordAdjustment(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('portfolioId', new ZodValidationPipe(PortfolioIdParamSchema)) portfolioId: string,
    @Body(new ZodValidationPipe(RecordAdjustmentSchema)) body: RecordAdjustmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WalletEntryResult> {
    const key = new ZodValidationPipe(IdempotencyKeySchema).transform(idempotencyKey);
    return this.financing.recordAdjustment(actor(userId), tenantId, portfolioId, body, key);
  }
}

function actor(userId: string | undefined): string {
  if (!userId) throw new UnauthorizedException();
  return userId;
}
