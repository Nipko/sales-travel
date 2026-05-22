import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { PortfoliosService } from './portfolios.service.js';

@Controller('portfolios')
export class PortfoliosController {
  constructor(
    private readonly portfolios: PortfoliosService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  async get(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const portfolio = await this.portfolios.getPortfolio(tenantId);
    return { portfolio: this.serializePortfolio(portfolio) };
  }

  @Get('transactions')
  async listTransactions(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const txs = await this.portfolios.getTransactions(tenantId);
    return { transactions: txs.map((tx) => this.serializeTransaction(tx)) };
  }

  @Post('deposit')
  async deposit(
    @CurrentUser() userId: string | undefined,
    @Body() body: { amountMinor: number; notes?: string },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const { portfolio, transaction } = await this.portfolios.deposit(
      tenantId,
      body.amountMinor,
      userId,
      body.notes,
    );
    return {
      portfolio: this.serializePortfolio(portfolio),
      transaction: this.serializeTransaction(transaction),
    };
  }

  @Post('withdraw')
  async withdraw(
    @CurrentUser() userId: string | undefined,
    @Body() body: { amountMinor: number; notes?: string },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const { portfolio, transaction } = await this.portfolios.withdraw(
      tenantId,
      body.amountMinor,
      userId,
      body.notes,
    );
    return {
      portfolio: this.serializePortfolio(portfolio),
      transaction: this.serializeTransaction(transaction),
    };
  }

  @Patch('credit-limit')
  async updateLimit(
    @CurrentUser() userId: string | undefined,
    @Body() body: { creditLimitMinor: number },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    await this.assertAdminMembership(userId, tenantId);

    const portfolio = await this.portfolios.updateCreditLimit(tenantId, body.creditLimitMinor);
    return { portfolio: this.serializePortfolio(portfolio) };
  }

  @Post('hold-booking')
  async hold(
    @CurrentUser() userId: string | undefined,
    @Body() body: { orderId: string; amountMinor: number },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const { portfolio, transaction } = await this.portfolios.holdBooking(
      tenantId,
      body.orderId,
      body.amountMinor,
      userId,
    );
    return {
      portfolio: this.serializePortfolio(portfolio),
      transaction: this.serializeTransaction(transaction),
    };
  }

  @Post('orders/:orderId/approve')
  async approve(
    @CurrentUser() userId: string | undefined,
    @Param('orderId') orderId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    await this.assertAdminMembership(userId, tenantId);

    return this.portfolios.approveBooking(tenantId, orderId);
  }

  @Post('orders/:orderId/reject')
  async reject(
    @CurrentUser() userId: string | undefined,
    @Param('orderId') orderId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    await this.assertAdminMembership(userId, tenantId);

    return this.portfolios.rejectBooking(tenantId, orderId);
  }

  private serializePortfolio(p: any) {
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

  private serializeTransaction(tx: any) {
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

  private async resolveActiveTenant(userId: string): Promise<string> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select(['tenant_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('user has no active membership');
      return row.tenant_id;
    });
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
      if (row.role !== 'tenant_admin' && row.role !== 'superadmin' && row.role !== 'admin') {
        throw new ForbiddenException('admin role required');
      }
    });
  }
}
