import { Injectable, BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { OrderStatus } from '../database/database.types.js';

export interface PortfolioRow {
  id: string;
  tenant_id: string;
  credit_limit_minor: number;
  balance_minor: number;
  currency: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface PortfolioTransactionRow {
  id: string;
  portfolio_id: string;
  amount_minor: number;
  transaction_type: string;
  reference_id: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
}

@Injectable()
export class PortfoliosService {
  constructor(private readonly db: DatabaseService) {}

  async getPortfolio(tenantId: string): Promise<PortfolioRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      let row = await trx
        .selectFrom('agency_portfolios')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();

      if (!row) {
        // Auto-initialize default portfolio for new tenants
        row = await trx
          .insertInto('agency_portfolios')
          .values({
            tenant_id: tenantId,
            credit_limit_minor: 0,
            balance_minor: 0,
            currency: 'COP',
            status: 'active',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      return row as unknown as PortfolioRow;
    });
  }

  async updateCreditLimit(tenantId: string, limitMinor: number): Promise<PortfolioRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('agency_portfolios')
        .set({ credit_limit_minor: limitMinor })
        .where('tenant_id', '=', tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return row as unknown as PortfolioRow;
    });
  }

  async deposit(
    tenantId: string,
    amountMinor: number,
    createdBy: string,
    notes?: string,
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
    if (amountMinor <= 0) throw new BadRequestException('Deposit amount must be positive');

    return this.db.withTenant(tenantId, async (trx) => {
      const portfolio = await this.getPortfolio(tenantId);

      const updatedPortfolio = await trx
        .updateTable('agency_portfolios')
        .set({
          balance_minor: sql`balance_minor + ${amountMinor}`,
        })
        .where('id', '=', portfolio.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      const transaction = await trx
        .insertInto('portfolio_transactions')
        .values({
          portfolio_id: portfolio.id,
          amount_minor: amountMinor,
          transaction_type: 'DEPOSIT_PAYMENT',
          notes: notes ?? 'Recarga de saldo por transferencia',
          created_by: createdBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        portfolio: updatedPortfolio as unknown as PortfolioRow,
        transaction: transaction as unknown as PortfolioTransactionRow,
      };
    });
  }

  async withdraw(
    tenantId: string,
    amountMinor: number,
    createdBy: string,
    notes?: string,
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
    if (amountMinor <= 0) throw new BadRequestException('Withdrawal amount must be positive');

    return this.db.withTenant(tenantId, async (trx) => {
      const portfolio = await this.getPortfolio(tenantId);
      const available = Number(portfolio.balance_minor) + Number(portfolio.credit_limit_minor);

      if (available < amountMinor) {
        throw new BadRequestException('Insufficient credit limit and portfolio balance');
      }

      const updatedPortfolio = await trx
        .updateTable('agency_portfolios')
        .set({
          balance_minor: sql`balance_minor - ${amountMinor}`,
        })
        .where('id', '=', portfolio.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      const transaction = await trx
        .insertInto('portfolio_transactions')
        .values({
          portfolio_id: portfolio.id,
          amount_minor: -amountMinor,
          transaction_type: 'MANUAL_ADJUSTMENT',
          notes: notes ?? 'Retiro o ajuste manual de saldo',
          created_by: createdBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        portfolio: updatedPortfolio as unknown as PortfolioRow,
        transaction: transaction as unknown as PortfolioTransactionRow,
      };
    });
  }

  async getTransactions(tenantId: string): Promise<PortfolioTransactionRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const portfolio = await this.getPortfolio(tenantId);
      const rows = await trx
        .selectFrom('portfolio_transactions')
        .selectAll()
        .where('portfolio_id', '=', portfolio.id)
        .orderBy('created_at', 'desc')
        .execute();
      return rows as unknown as PortfolioTransactionRow[];
    });
  }

  // Flujo de Aprobación de Reserva
  async holdBooking(
    tenantId: string,
    orderId: string,
    amountMinor: number,
    createdBy: string,
  ): Promise<{ portfolio: PortfolioRow; transaction: PortfolioTransactionRow }> {
    return this.db.withTenant(tenantId, async (trx) => {
      const portfolio = await this.getPortfolio(tenantId);
      const available = Number(portfolio.balance_minor) + Number(portfolio.credit_limit_minor);

      if (available < amountMinor) {
        throw new BadRequestException(
          'Saldo insuficiente para reservar. Recargue saldo o solicite límite de crédito.',
        );
      }

      // Provisionar saldo restándolo del balance corriente
      const updatedPortfolio = await trx
        .updateTable('agency_portfolios')
        .set({
          balance_minor: sql`balance_minor - ${amountMinor}`,
        })
        .where('id', '=', portfolio.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Registrar retención de saldo
      const transaction = await trx
        .insertInto('portfolio_transactions')
        .values({
          portfolio_id: portfolio.id,
          amount_minor: -amountMinor,
          transaction_type: 'BOOKING_HOLD',
          reference_id: orderId,
          notes: `Retención preventiva de saldo por reserva pendiente de emisión`,
          created_by: createdBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        portfolio: updatedPortfolio as unknown as PortfolioRow,
        transaction: transaction as unknown as PortfolioTransactionRow,
      };
    });
  }

  async approveBooking(
    tenantId: string,
    orderId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.db.withTenant(tenantId, async (trx) => {
      // 1. Verificar transacción de hold
      const holdTx = await trx
        .selectFrom('portfolio_transactions')
        .selectAll()
        .where('reference_id', '=', orderId)
        .where('transaction_type', '=', 'BOOKING_HOLD')
        .executeTakeFirst();

      if (!holdTx) {
        throw new BadRequestException('No booking hold transaction found for this order');
      }

      // 2. Convertir hold a cargo definitivo
      await trx
        .updateTable('portfolio_transactions')
        .set({
          transaction_type: 'BOOKING_CHARGE',
          notes: 'Cargo final aprobado y tiquete emitido por administración',
        })
        .where('id', '=', holdTx.id)
        .execute();

      // 3. Cambiar estado de la orden en la base de datos a confirmado
      await trx
        .updateTable('orders')
        .set({ status: 'confirmed' as OrderStatus })
        .where('id', '=', orderId)
        .execute();

      return {
        success: true,
        message: 'Reserva aprobada, saldo debitado y tiquete marcado como emitido.',
      };
    });
  }

  async rejectBooking(
    tenantId: string,
    orderId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.db.withTenant(tenantId, async (trx) => {
      const holdTx = await trx
        .selectFrom('portfolio_transactions')
        .selectAll()
        .where('reference_id', '=', orderId)
        .where('transaction_type', '=', 'BOOKING_HOLD')
        .executeTakeFirst();

      if (!holdTx) {
        throw new BadRequestException('No booking hold transaction found for this order');
      }

      const portfolio = await this.getPortfolio(tenantId);
      const refundAmount = Math.abs(Number(holdTx.amount_minor));

      // 1. Devolver saldo retenido
      await trx
        .updateTable('agency_portfolios')
        .set({
          balance_minor: sql`balance_minor + ${refundAmount}`,
        })
        .where('id', '=', portfolio.id)
        .execute();

      // 2. Marcar transacción como liberada/cancelada
      await trx
        .updateTable('portfolio_transactions')
        .set({
          transaction_type: 'BOOKING_REJECTED',
          notes: 'Reserva rechazada por administración, saldo liberado',
          amount_minor: 0, // Libera la retención contable
        })
        .where('id', '=', holdTx.id)
        .execute();

      // 3. Cambiar estado de la orden a cancelada
      await trx
        .updateTable('orders')
        .set({ status: 'cancelled' as OrderStatus })
        .where('id', '=', orderId)
        .execute();

      return {
        success: true,
        message: 'Reserva rechazada. El saldo retenido ha sido completamente devuelto.',
      };
    });
  }
}
