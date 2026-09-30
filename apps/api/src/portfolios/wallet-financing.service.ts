import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, DepositReportStatus, PortfolioStatus } from '../database/database.types.js';
import {
  PortfolioConflictError,
  PortfolioForbiddenError,
  PortfolioNotFoundError,
  isUniqueViolation,
  rethrowPortfolioError,
  walletAlreadyEnabled,
} from './portfolio-errors.js';
import type {
  ApproveDepositReportDto,
  EnableWalletDto,
  NetworkHoldsQuery,
  RecordAdjustmentDto,
  RecordDepositDto,
  RejectDepositReportDto,
  UpdateWalletDto,
} from './portfolios.schemas.js';
import { walletCurrencies } from './wallet-currency.js';
import {
  depositReportById,
  listDepositReports,
  listMovements,
  listNetworkHolds,
  listWallets,
  movementView,
  walletById,
  walletView,
  type DepositReportView,
  type NetworkHoldsView,
  type PortfolioRow,
  type PortfolioTransactionRow,
  type WalletMovementView,
  type WalletView,
} from './wallet-store.js';

/** Los eventos que deja cada operación de quien financia (los de 0053 usan los mismos nombres). */
export const WALLET_EVENTS = {
  created: 'portfolio.created',
  creditLimitChanged: 'portfolio.credit_limit.changed',
  statusChanged: 'portfolio.status.changed',
  depositRecorded: 'portfolio.deposit.recorded',
  adjustmentRecorded: 'portfolio.adjustment.recorded',
} as const;

const AGGREGATE = 'agency_portfolio';

/** El nodo cuyas carteras se gestionan. */
export interface FinancedNodeView {
  id: string;
  name: string;
  tenantType: string;
  isBranch: boolean;
  status: string;
  defaultCurrency: string;
}

export interface FinancedWalletsView {
  tenant: FinancedNodeView;
  portfolios: WalletView[];
  /** Depósitos que informó el nodo y esperan que quien lo financia los apruebe o rechace. */
  pendingDepositReports: number;
  /** Monedas que se le pueden habilitar: las de ISO 4217 con centésimos que todavía no tiene. */
  availableCurrencies: string[];
}

export interface WalletEntryResult {
  portfolio: WalletView;
  transaction: WalletMovementView;
}

export interface ResolvedDepositReport {
  report: DepositReportView;
  portfolio: WalletView;
  transaction?: WalletMovementView;
}

interface FinancedNodeRow {
  id: string;
  name: string;
  tenant_type: string;
  is_branch: boolean;
  status: string;
  default_currency: string;
  allowed: boolean;
}

type EntryType = 'DEPOSIT_PAYMENT' | 'MANUAL_ADJUSTMENT';

interface EntryInput {
  readonly type: EntryType;
  /** Con signo: positivo acredita, negativo debita. */
  readonly amountMinor: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * Lo que hace quien FINANCIA a un nodo con sus carteras (decisión del founder del 2026-09-29, opción
 * A): habilitarle monedas, fijarle el cupo, suspender o reactivar una cartera, registrarle depósitos
 * y ajustes, y aprobar o rechazar los depósitos que el nodo informó.
 *
 * Quién financia a quién lo decide la base (`can_finance_tenant`, db/migrations/0052): el superadmin
 * de Planetour a cualquier nodo (la raíz incluida); los admins de un consolidador a sus agencias; los
 * de una agencia a sus sub-agencias. Nunca el propio nodo, ni un ancestro por encima del que lo
 * financia. Este servicio lo pregunta al empezar cada operación para responder 403 con motivo antes
 * de escribir nada, y la base lo vuelve a exigir en cada escritura (la guarda de 0052).
 *
 * Cada operación corre en UNA transacción con `withRequestContext({ userId: quien actúa, tenantId:
 * nodo dueño })`, el contrato de 0052: con sólo el tenant la base no sabe quién actúa y rechaza. El
 * `domain_event` va en la misma transacción: un movimiento de plata sin rastro no entra.
 */
@Injectable()
export class WalletFinancingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Las carteras del nodo, cuántos depósitos informados esperan y qué monedas le faltan. */
  async overview(actorUserId: string, tenantId: string): Promise<FinancedWalletsView> {
    return this.run(actorUserId, tenantId, async (trx, node) => {
      const wallets = await listWallets(trx, tenantId);
      const pending = await trx
        .selectFrom('portfolio_deposit_reports')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      const enabled = new Set(wallets.map((w) => w.currency));
      return {
        tenant: node,
        portfolios: wallets.map(walletView),
        pendingDepositReports: Number(pending?.n ?? 0),
        availableCurrencies: walletCurrencies([node.defaultCurrency, 'USD']).filter(
          (code) => !enabled.has(code),
        ),
      };
    });
  }

  /** Habilita una moneda: abre la cartera del nodo en ella, con su cupo inicial. */
  async enableCurrency(
    actorUserId: string,
    tenantId: string,
    input: EnableWalletDto,
  ): Promise<WalletView> {
    return this.run(actorUserId, tenantId, async (trx) => {
      const created = (await trx
        .insertInto('agency_portfolios')
        .values({
          tenant_id: tenantId,
          currency: input.currency,
          credit_limit_minor: input.creditLimitMinor,
          balance_minor: 0,
          status: 'active',
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'currency']).doNothing())
        .returningAll()
        .executeTakeFirst()) as PortfolioRow | undefined;
      if (!created) throw walletAlreadyEnabled(input.currency);

      await this.audit.emitWithin(trx, {
        eventType: WALLET_EVENTS.created,
        tenantId,
        actorUserId,
        aggregateType: AGGREGATE,
        aggregateId: created.id,
        payload: {
          currency: created.currency,
          creditLimitMinor: input.creditLimitMinor,
          reason: input.reason,
          source: 'api',
        },
      });
      return walletView(created);
    });
  }

  /**
   * Fija el cupo o el estado de una cartera. Lo que no cambia no se escribe ni se audita: el panel
   * puede reenviar el mismo valor.
   */
  async updateWallet(
    actorUserId: string,
    tenantId: string,
    portfolioId: string,
    input: UpdateWalletDto,
  ): Promise<WalletView> {
    return this.run(actorUserId, tenantId, async (trx) => {
      const wallet = await this.lockedWallet(trx, tenantId, portfolioId);
      const fromLimit = Number(wallet.credit_limit_minor);
      const toLimit = input.creditLimitMinor ?? fromLimit;
      const toStatus: PortfolioStatus = input.status ?? (wallet.status as PortfolioStatus);
      if (fromLimit === toLimit && wallet.status === toStatus) return walletView(wallet);

      const updated = (await trx
        .updateTable('agency_portfolios')
        .set({
          credit_limit_minor: toLimit,
          status: toStatus,
        })
        .where('id', '=', wallet.id)
        .where('tenant_id', '=', tenantId)
        .returningAll()
        .executeTakeFirstOrThrow()) as unknown as PortfolioRow;

      if (fromLimit !== toLimit) {
        await this.audit.emitWithin(trx, {
          eventType: WALLET_EVENTS.creditLimitChanged,
          tenantId,
          actorUserId,
          aggregateType: AGGREGATE,
          aggregateId: wallet.id,
          payload: {
            currency: wallet.currency,
            fromMinor: fromLimit,
            toMinor: toLimit,
            reason: input.reason,
            source: 'api',
          },
        });
      }
      if (wallet.status !== toStatus) {
        await this.audit.emitWithin(trx, {
          eventType: WALLET_EVENTS.statusChanged,
          tenantId,
          actorUserId,
          aggregateType: AGGREGATE,
          aggregateId: wallet.id,
          payload: {
            currency: wallet.currency,
            from: wallet.status,
            to: toStatus,
            reason: input.reason,
            source: 'api',
          },
        });
      }
      return walletView(updated);
    });
  }

  /** Un depósito que quien financia ya verificó: acredita el monto en la cartera. */
  async recordDeposit(
    actorUserId: string,
    tenantId: string,
    portfolioId: string,
    input: RecordDepositDto,
    idempotencyKey: string,
  ): Promise<WalletEntryResult> {
    return this.recordEntry(actorUserId, tenantId, portfolioId, {
      type: 'DEPOSIT_PAYMENT',
      amountMinor: input.amountMinor,
      reason: input.reason,
      idempotencyKey,
    });
  }

  /**
   * Un ajuste con signo: un reintegro a la agencia, una comisión, la corrección de un depósito mal
   * cargado. Un débito puede dejar la cartera por debajo de su cupo: es quien financia registrando lo
   * que la agencia le debe, y frenarlo escondería la deuda. La agencia no podrá retener más hasta
   * que se cubra.
   */
  async recordAdjustment(
    actorUserId: string,
    tenantId: string,
    portfolioId: string,
    input: RecordAdjustmentDto,
    idempotencyKey: string,
  ): Promise<WalletEntryResult> {
    return this.recordEntry(actorUserId, tenantId, portfolioId, {
      type: 'MANUAL_ADJUSTMENT',
      amountMinor: input.amountMinor,
      reason: input.reason,
      idempotencyKey,
    });
  }

  async listMovements(
    actorUserId: string,
    tenantId: string,
    currency?: string,
  ): Promise<WalletMovementView[]> {
    // Esta vista es sólo de admins de quien financia (el controller y `run` lo exigen).
    return this.run(actorUserId, tenantId, (trx) =>
      listMovements(trx, tenantId, currency, { includeNetwork: true }),
    );
  }

  /**
   * Las reservas de la red del nodo retenidas en sus carteras (0060). Corre con el tenant del nodo:
   * la RLS de `wallet_hold_levels` muestra sus niveles, no los de quien financia.
   */
  async listNetworkHolds(
    actorUserId: string,
    tenantId: string,
    query: NetworkHoldsQuery,
  ): Promise<NetworkHoldsView> {
    return this.run(actorUserId, tenantId, (trx) => listNetworkHolds(trx, tenantId, query));
  }

  async listDepositReports(
    actorUserId: string,
    tenantId: string,
    status?: DepositReportStatus,
  ): Promise<DepositReportView[]> {
    return this.run(actorUserId, tenantId, (trx) =>
      listDepositReports(trx, tenantId, status === undefined ? {} : { status }),
    );
  }

  /**
   * Aprueba un depósito informado, en UNA transacción y en este orden: el `DEPOSIT_PAYMENT` por ese
   * monto en esa cartera (con el informe como referencia), el saldo, y el informe pasa a aprobado
   * apuntando a ese asiento. El informe se bloquea primero: una segunda aprobación que compita espera
   * y encuentra el informe resuelto, sin acreditar dos veces. El rastro
   * (`portfolio.deposit_report.approved`) lo deja la base.
   */
  async approveDepositReport(
    actorUserId: string,
    tenantId: string,
    reportId: string,
    input: ApproveDepositReportDto,
  ): Promise<ResolvedDepositReport> {
    return this.run(actorUserId, tenantId, async (trx) => {
      const report = await this.lockedPendingReport(trx, tenantId, reportId);
      const wallet = await this.lockedWallet(trx, tenantId, report.portfolio_id);
      const amountMinor = Number(report.amount_minor);

      const entry = await this.insertEntry(trx, wallet, {
        type: 'DEPOSIT_PAYMENT',
        amountMinor,
        notes:
          `Depósito informado aprobado (ref. ${report.reference})` +
          (input.reason === null ? '' : `: ${input.reason}`),
        referenceId: report.id,
        idempotencyKey: null,
        actorUserId,
      });
      const updated = await this.credit(trx, wallet, amountMinor);

      const resolved = await trx
        .updateTable('portfolio_deposit_reports')
        .set({
          status: 'approved',
          resolved_by: actorUserId,
          resolution_reason: input.reason,
          portfolio_transaction_id: entry.id,
        })
        .where('id', '=', report.id)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!resolved) throw new PortfolioConflictError('DEPOSIT_REPORT_NOT_PENDING');

      return {
        report: await this.reportOrFail(trx, tenantId, report.id),
        portfolio: walletView(updated),
        transaction: movementView(entry, wallet.currency, await this.actorName(trx, actorUserId)),
      };
    });
  }

  /** Rechaza un depósito informado, con motivo. No mueve el saldo. */
  async rejectDepositReport(
    actorUserId: string,
    tenantId: string,
    reportId: string,
    input: RejectDepositReportDto,
  ): Promise<ResolvedDepositReport> {
    return this.run(actorUserId, tenantId, async (trx) => {
      const report = await this.lockedPendingReport(trx, tenantId, reportId);
      const resolved = await trx
        .updateTable('portfolio_deposit_reports')
        .set({ status: 'rejected', resolved_by: actorUserId, resolution_reason: input.reason })
        .where('id', '=', report.id)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!resolved) throw new PortfolioConflictError('DEPOSIT_REPORT_NOT_PENDING');

      const wallet = await walletById(trx, tenantId, report.portfolio_id);
      if (!wallet) throw new PortfolioNotFoundError('PORTFOLIO_NOT_FOUND');
      return {
        report: await this.reportOrFail(trx, tenantId, report.id),
        portfolio: walletView(wallet),
      };
    });
  }

  // ───────────────────────────── Internos ─────────────────────────────

  /**
   * Corre `fn` como quien actúa sobre el nodo dueño, después de comprobar que lo financia, y traduce
   * los errores de la base a 409/403 con motivo.
   */
  private async run<T>(
    actorUserId: string,
    tenantId: string,
    fn: (trx: Transaction<DB>, node: FinancedNodeView) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.withRequestContext({ userId: actorUserId, tenantId }, async (trx) =>
        fn(trx, await this.financedNode(trx, tenantId)),
      );
    } catch (error) {
      return rethrowPortfolioError(error);
    }
  }

  /**
   * El nodo, si quien actúa lo financia. Un nodo que no existe responde lo mismo que uno ajeno: 403,
   * sin confirmar qué ids existen fuera de la red de quien pregunta.
   */
  private async financedNode(trx: Transaction<DB>, tenantId: string): Promise<FinancedNodeView> {
    // `tenants` no tiene RLS; can_finance_tenant mira app.current_user_id de esta transacción.
    const row: FinancedNodeRow | undefined = await trx
      .selectFrom('tenants')
      .select([
        'id',
        'name',
        'tenant_type',
        'is_branch',
        'status',
        'default_currency',
        sql<boolean>`can_finance_tenant(id)`.as('allowed'),
      ])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row?.allowed !== true) throw new PortfolioForbiddenError('PORTFOLIO_FINANCIER_REQUIRED');
    return {
      id: row.id,
      name: row.name,
      tenantType: row.tenant_type,
      isBranch: row.is_branch,
      status: row.status,
      defaultCurrency: row.default_currency,
    };
  }

  private async lockedWallet(
    trx: Transaction<DB>,
    tenantId: string,
    portfolioId: string,
  ): Promise<PortfolioRow> {
    const wallet = await walletById(trx, tenantId, portfolioId, { forUpdate: true });
    if (!wallet) throw new PortfolioNotFoundError('PORTFOLIO_NOT_FOUND');
    return wallet;
  }

  private async lockedPendingReport(trx: Transaction<DB>, tenantId: string, reportId: string) {
    const report = await trx
      .selectFrom('portfolio_deposit_reports')
      .select(['id', 'portfolio_id', 'amount_minor', 'reference', 'status'])
      .where('id', '=', reportId)
      .where('tenant_id', '=', tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (!report) throw new PortfolioNotFoundError('DEPOSIT_REPORT_NOT_FOUND');
    if (report.status !== 'pending') throw new PortfolioConflictError('DEPOSIT_REPORT_NOT_PENDING');
    return report;
  }

  private async reportOrFail(
    trx: Transaction<DB>,
    tenantId: string,
    reportId: string,
  ): Promise<DepositReportView> {
    const report = await depositReportById(trx, tenantId, reportId);
    if (!report) throw new PortfolioNotFoundError('DEPOSIT_REPORT_NOT_FOUND');
    return report;
  }

  /**
   * Depósito o ajuste idempotente: la Idempotency-Key se reclama con el asiento (índice único de
   * 0040 por cartera), antes de tocar el saldo. Un reenvío con la misma clave y los mismos datos
   * (la misma cartera incluida) devuelve el asiento que ya existe; con otros, 409.
   */
  private async recordEntry(
    actorUserId: string,
    tenantId: string,
    portfolioId: string,
    input: EntryInput,
  ): Promise<WalletEntryResult> {
    const attempt = () =>
      this.run(actorUserId, tenantId, async (trx) => {
        const wallet = await this.lockedWallet(trx, tenantId, portfolioId);
        // La clave se busca en TODAS las carteras del nodo, no sólo en ésta: reenviarla contra la
        // cartera de otra moneda es otro movimiento con la misma clave (409), no un reintento que
        // acredite por segunda vez. El índice único de 0040 es por cartera; esto cubre el reenvío.
        const prior = (await trx
          .selectFrom('portfolio_transactions as t')
          .innerJoin('agency_portfolios as p', 'p.id', 't.portfolio_id')
          .selectAll('t')
          .where('p.tenant_id', '=', tenantId)
          .where('t.idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst()) as PortfolioTransactionRow | undefined;
        if (prior) {
          const same =
            prior.portfolio_id === wallet.id &&
            prior.transaction_type === input.type &&
            Number(prior.amount_minor) === input.amountMinor &&
            prior.created_by === actorUserId &&
            prior.notes === input.reason;
          if (!same) throw new PortfolioConflictError('PORTFOLIO_IDEMPOTENCY_KEY_REUSED');
          return {
            portfolio: walletView(wallet),
            transaction: movementView(
              prior,
              wallet.currency,
              await this.actorName(trx, actorUserId),
            ),
          };
        }

        const entry = await this.insertEntry(trx, wallet, {
          type: input.type,
          amountMinor: input.amountMinor,
          notes: input.reason,
          referenceId: null,
          idempotencyKey: input.idempotencyKey,
          actorUserId,
        });
        const updated = await this.credit(trx, wallet, input.amountMinor);
        await this.audit.emitWithin(trx, {
          eventType:
            input.type === 'DEPOSIT_PAYMENT'
              ? WALLET_EVENTS.depositRecorded
              : WALLET_EVENTS.adjustmentRecorded,
          tenantId,
          actorUserId,
          aggregateType: AGGREGATE,
          aggregateId: wallet.id,
          payload: {
            currency: wallet.currency,
            amountMinor: input.amountMinor,
            transactionId: entry.id,
            reason: input.reason,
          },
        });
        return {
          portfolio: walletView(updated),
          transaction: movementView(entry, wallet.currency, await this.actorName(trx, actorUserId)),
        };
      });

    try {
      return await attempt();
    } catch (error) {
      // Otro envío con la misma clave confirmó mientras este insertaba: el reintento lo encuentra.
      if (isUniqueViolation(error)) return attempt();
      throw error;
    }
  }

  /** El nombre de quien actúa: la respuesta de un asiento dice lo mismo que el listado. */
  private async actorName(trx: Transaction<DB>, userId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('users')
      .select('name')
      .where('id', '=', userId)
      .executeTakeFirst();
    return row?.name ?? null;
  }

  /** El asiento, firmado por quien actúa (la guarda de 0052 lo exige y le pone la hora). */
  private async insertEntry(
    trx: Transaction<DB>,
    wallet: PortfolioRow,
    entry: {
      type: EntryType;
      amountMinor: number;
      notes: string;
      referenceId: string | null;
      idempotencyKey: string | null;
      actorUserId: string;
    },
  ): Promise<PortfolioTransactionRow> {
    return (await trx
      .insertInto('portfolio_transactions')
      .values({
        portfolio_id: wallet.id,
        amount_minor: entry.amountMinor,
        transaction_type: entry.type,
        reference_id: entry.referenceId,
        idempotency_key: entry.idempotencyKey,
        notes: entry.notes,
        created_by: entry.actorUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as PortfolioTransactionRow;
  }

  /** Suma `amountMinor` (con signo) al saldo, sin salir del rango que la API lee sin redondear. */
  private async credit(
    trx: Transaction<DB>,
    wallet: PortfolioRow,
    amountMinor: number,
  ): Promise<PortfolioRow> {
    const updated = (await trx
      .updateTable('agency_portfolios')
      .set({ balance_minor: sql<number>`balance_minor + ${amountMinor}` })
      .where('id', '=', wallet.id)
      .where(
        sql<boolean>`balance_minor::numeric + ${amountMinor} BETWEEN ${Number.MIN_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`,
      )
      .returningAll()
      .executeTakeFirst()) as PortfolioRow | undefined;
    if (!updated) throw new PortfolioConflictError('PORTFOLIO_BALANCE_OUT_OF_RANGE');
    return updated;
  }
}
