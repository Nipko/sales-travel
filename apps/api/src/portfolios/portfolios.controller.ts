import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

const MAX_MINOR = 1_000_000_000_000; // 10^12 — tope de cordura

function assertPositiveAmount(amountMinor: unknown): number {
  if (
    typeof amountMinor !== 'number' ||
    !Number.isInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > MAX_MINOR
  ) {
    throw new BadRequestException('amountMinor must be a positive integer');
  }
  return amountMinor;
}
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import {
  PortfoliosService,
  type PortfolioRow,
  type PortfolioTransactionRow,
} from './portfolios.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('portfolios')
export class PortfoliosController {
  constructor(
    private readonly portfolios: PortfoliosService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  @Get()
  async get(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const portfolio = await this.portfolios.getPortfolio(tenantId);
    return { portfolio: this.serializePortfolio(portfolio) };
  }

  @Get('transactions')
  async listTransactions(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const txs = await this.portfolios.getTransactions(tenantId);
    return { transactions: txs.map((tx) => this.serializeTransaction(tx)) };
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('deposit')
  async deposit(
    @CurrentUser() userId: string | undefined,
    @Body() body: { amountMinor: number; notes?: string },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId); // operación financiera → admin
    const amount = assertPositiveAmount(body.amountMinor);
    const { portfolio, transaction } = await this.portfolios.deposit(
      tenantId,
      amount,
      userId,
      body.notes,
    );
    return {
      portfolio: this.serializePortfolio(portfolio),
      transaction: this.serializeTransaction(transaction),
    };
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('withdraw')
  async withdraw(
    @CurrentUser() userId: string | undefined,
    @Body() body: { amountMinor: number; notes?: string },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId); // operación financiera → admin
    const amount = assertPositiveAmount(body.amountMinor);
    const { portfolio, transaction } = await this.portfolios.withdraw(
      tenantId,
      amount,
      userId,
      body.notes,
    );
    return {
      portfolio: this.serializePortfolio(portfolio),
      transaction: this.serializeTransaction(transaction),
    };
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Patch('credit-limit')
  async updateLimit(
    @CurrentUser() userId: string | undefined,
    @Body() body: { creditLimitMinor: number },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId);

    if (
      typeof body.creditLimitMinor !== 'number' ||
      !Number.isInteger(body.creditLimitMinor) ||
      body.creditLimitMinor < 0 ||
      body.creditLimitMinor > MAX_MINOR
    ) {
      throw new BadRequestException('creditLimitMinor must be a non-negative integer');
    }
    const portfolio = await this.portfolios.updateCreditLimit(tenantId, body.creditLimitMinor);
    return { portfolio: this.serializePortfolio(portfolio) };
  }

  @Post('hold-booking')
  async hold(
    @CurrentUser() userId: string | undefined,
    @Body() body: { orderId: string; amountMinor: number },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const amount = assertPositiveAmount(body.amountMinor);
    const { portfolio, transaction } = await this.portfolios.holdBooking(
      tenantId,
      body.orderId,
      amount,
      userId,
    );
    return {
      portfolio: this.serializePortfolio(portfolio),
      transaction: this.serializeTransaction(transaction),
    };
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('orders/:orderId/approve')
  async approve(@CurrentUser() userId: string | undefined, @Param('orderId') orderId: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId);

    return this.portfolios.approveBooking(tenantId, orderId);
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('orders/:orderId/reject')
  async reject(@CurrentUser() userId: string | undefined, @Param('orderId') orderId: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    await this.assertAdminMembership(userId, tenantId);

    return this.portfolios.rejectBooking(tenantId, orderId);
  }

  private serializePortfolio(p: PortfolioRow) {
    return {
      id: p.id,
      tenantId: p.tenant_id,
      creditLimitMinor: Number(p.credit_limit_minor),
      balanceMinor: Number(p.balance_minor),
      currency: p.currency,
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }

  private serializeTransaction(tx: PortfolioTransactionRow) {
    return {
      id: tx.id,
      portfolioId: tx.portfolio_id,
      amountMinor: Number(tx.amount_minor),
      transactionType: tx.transaction_type,
      referenceId: tx.reference_id,
      notes: tx.notes,
      createdBy: tx.created_by,
      createdAt: tx.created_at,
    };
  }

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
