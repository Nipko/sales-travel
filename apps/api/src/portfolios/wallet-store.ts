import { sql, type Transaction } from 'kysely';
import type { DB, DepositReportStatus } from '../database/database.types.js';
import { currencyExponent } from './wallet-currency.js';

/**
 * Lecturas de las carteras de UN nodo y sus vistas, compartidas por lo que ve la agencia (Cartera
 * B2B) y lo que ve quien la financia. Todas reciben la transacción del llamador: la RLS de
 * `agency_portfolios` filtra por `app.current_tenant_id`, así que el nodo de la transacción tiene
 * que ser el dueño de las carteras, y además cada consulta lo filtra explícitamente.
 */

/** Tope de filas de un listado: un nodo con más movimientos los pagina por moneda. */
const LIST_LIMIT = 500;

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
  idempotency_key: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
}

export interface WalletView {
  id: string;
  tenantId: string;
  currency: string;
  /** Exponente ISO 4217: los montos van en unidades de 10^-exponent. `null`: moneda retirada. */
  exponent: number | null;
  creditLimitMinor: number;
  balanceMinor: number;
  /** Saldo más cupo: lo que la agencia puede retener para reservar. Negativo si se pasó del cupo. */
  availableMinor: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementView {
  id: string;
  portfolioId: string;
  currency: string;
  exponent: number | null;
  amountMinor: number;
  transactionType: string;
  referenceId: string | null;
  notes: string | null;
  createdBy: string;
  /** El nombre de quien lo registró, si lo cargó. Nunca el email: lo ve toda la agencia. */
  createdByName: string | null;
  createdAt: Date;
}

export interface DepositReportView {
  id: string;
  portfolioId: string;
  currency: string;
  exponent: number | null;
  amountMinor: number;
  reference: string;
  /** `AAAA-MM-DD`, como la informó la agencia. */
  depositedOn: string | null;
  notes: string | null;
  status: DepositReportStatus;
  reportedBy: string;
  reportedByName: string | null;
  reportedAt: Date;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  portfolioTransactionId: string | null;
}

export function walletView(row: PortfolioRow): WalletView {
  const creditLimitMinor = Number(row.credit_limit_minor);
  const balanceMinor = Number(row.balance_minor);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    currency: row.currency,
    exponent: currencyExponent(row.currency) ?? null,
    creditLimitMinor,
    balanceMinor,
    availableMinor: balanceMinor + creditLimitMinor,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function movementView(
  row: PortfolioTransactionRow,
  currency: string,
  createdByName: string | null = null,
): WalletMovementView {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    currency,
    exponent: currencyExponent(currency) ?? null,
    amountMinor: Number(row.amount_minor),
    transactionType: row.transaction_type,
    referenceId: row.reference_id,
    notes: row.notes,
    createdBy: row.created_by,
    createdByName,
    createdAt: row.created_at,
  };
}

/** Las carteras del nodo, por moneda. */
export async function listWallets(trx: Transaction<DB>, tenantId: string): Promise<PortfolioRow[]> {
  const rows = await trx
    .selectFrom('agency_portfolios')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('currency')
    .execute();
  return rows as unknown as PortfolioRow[];
}

/**
 * LA cartera del nodo en esa moneda, o `undefined`. Nunca crea una: qué monedas opera una agencia
 * lo decide quien la financia. Con `forUpdate`, bloquea la fila hasta el final de la transacción.
 */
export async function findWallet(
  trx: Transaction<DB>,
  tenantId: string,
  currency: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PortfolioRow | undefined> {
  let query = trx
    .selectFrom('agency_portfolios')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('currency', '=', currency);
  if (opts.forUpdate === true) query = query.forUpdate();
  return (await query.executeTakeFirst()) as PortfolioRow | undefined;
}

/** Una cartera del nodo por id, o `undefined` si no es suya. */
export async function walletById(
  trx: Transaction<DB>,
  tenantId: string,
  portfolioId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PortfolioRow | undefined> {
  let query = trx
    .selectFrom('agency_portfolios')
    .selectAll()
    .where('id', '=', portfolioId)
    .where('tenant_id', '=', tenantId);
  if (opts.forUpdate === true) query = query.forUpdate();
  return (await query.executeTakeFirst()) as PortfolioRow | undefined;
}

/** Los movimientos de las carteras del nodo (o de la de una moneda), del más nuevo al más viejo. */
export async function listMovements(
  trx: Transaction<DB>,
  tenantId: string,
  currency?: string,
): Promise<WalletMovementView[]> {
  let query = trx
    .selectFrom('portfolio_transactions as t')
    .innerJoin('agency_portfolios as p', 'p.id', 't.portfolio_id')
    .leftJoin('users as u', 'u.id', 't.created_by')
    .selectAll('t')
    .select(['p.currency as wallet_currency', 'u.name as created_by_name'])
    .where('p.tenant_id', '=', tenantId);
  if (currency !== undefined) query = query.where('p.currency', '=', currency);
  const rows = await query
    .orderBy('t.created_at', 'desc')
    .orderBy('t.id', 'desc')
    .limit(LIST_LIMIT)
    .execute();
  return rows.map((row) =>
    movementView(
      row as unknown as PortfolioTransactionRow,
      row.wallet_currency,
      row.created_by_name ?? null,
    ),
  );
}

/** Los depósitos informados del nodo, del más nuevo al más viejo. */
export async function listDepositReports(
  trx: Transaction<DB>,
  tenantId: string,
  filter: { status?: DepositReportStatus; id?: string } = {},
): Promise<DepositReportView[]> {
  let query = trx
    .selectFrom('portfolio_deposit_reports as r')
    .leftJoin('users as rb', 'rb.id', 'r.reported_by')
    .leftJoin('users as sb', 'sb.id', 'r.resolved_by')
    .select([
      'r.id',
      'r.portfolio_id',
      'r.currency',
      'r.amount_minor',
      'r.reference',
      sql<string | null>`to_char(r.deposited_on, 'YYYY-MM-DD')`.as('deposited_on'),
      'r.notes',
      'r.status',
      'r.reported_by',
      'rb.name as reported_by_name',
      'r.reported_at',
      'r.resolved_by',
      'sb.name as resolved_by_name',
      'r.resolved_at',
      'r.resolution_reason',
      'r.portfolio_transaction_id',
    ])
    .where('r.tenant_id', '=', tenantId);
  if (filter.status !== undefined) query = query.where('r.status', '=', filter.status);
  if (filter.id !== undefined) query = query.where('r.id', '=', filter.id);
  const rows = await query
    .orderBy('r.reported_at', 'desc')
    .orderBy('r.id', 'desc')
    .limit(LIST_LIMIT)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    portfolioId: r.portfolio_id,
    currency: r.currency,
    exponent: currencyExponent(r.currency) ?? null,
    amountMinor: Number(r.amount_minor),
    reference: r.reference,
    depositedOn: r.deposited_on,
    notes: r.notes,
    status: r.status,
    reportedBy: r.reported_by,
    reportedByName: r.reported_by_name ?? null,
    reportedAt: r.reported_at as unknown as Date,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name ?? null,
    resolvedAt: r.resolved_at,
    resolutionReason: r.resolution_reason,
    portfolioTransactionId: r.portfolio_transaction_id,
  }));
}

/** Un depósito informado del nodo, o `undefined` si no es suyo. */
export async function depositReportById(
  trx: Transaction<DB>,
  tenantId: string,
  reportId: string,
): Promise<DepositReportView | undefined> {
  const [report] = await listDepositReports(trx, tenantId, { id: reportId });
  return report;
}
