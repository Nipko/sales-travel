import { sql, type Transaction } from 'kysely';
import type { DB, DepositReportStatus, WalletHoldStatus } from '../database/database.types.js';
import { currencyExponent } from './wallet-currency.js';

/**
 * Lecturas de las carteras de UN nodo y sus vistas, compartidas por lo que ve la agencia (Cartera
 * B2B) y lo que ve quien la financia. Todas reciben la transacción del llamador: la RLS de
 * `agency_portfolios` filtra por `app.current_tenant_id`, así que el nodo de la transacción tiene
 * que ser el dueño de las carteras, y además cada consulta lo filtra explícitamente.
 */

/** Tope de filas de un listado: un nodo con más movimientos los pagina por moneda. */
const LIST_LIMIT = 500;

/** Tope de las reservas de la red que se listan de una vez (con filtros por moneda y estado). */
export const NETWORK_HOLDS_LIMIT = 200;

/**
 * Los asientos que la red deja en la cartera de quien la financia (0060). No los firma nadie de
 * este nodo: se muestran con la agencia de origen y el número de reserva, nunca con el vendedor.
 */
const NETWORK_ENTRY_TYPES: readonly string[] = ['NETWORK_HOLD', 'NETWORK_RELEASED'];

/**
 * Los asientos de la retención del propio nodo (0060). Los firma quien retuvo o, en una liberación
 * por conciliación, el admin del dueño de la cuenta o de la plataforma: alguien de arriba que el
 * personal del nodo no tiene por qué conocer.
 */
const BOOKING_ENTRY_TYPES: readonly string[] = [
  'BOOKING_HOLD',
  'BOOKING_RELEASED',
  'BOOKING_CHARGE',
];

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

/** De qué reserva de la red es un asiento `NETWORK_*`. */
export interface WalletMovementNetwork {
  originTenantId: string;
  originTenantName: string | null;
  orderNumber: number | null;
  status: WalletHoldStatus;
}

export interface WalletMovementView {
  id: string;
  portfolioId: string;
  currency: string;
  exponent: number | null;
  amountMinor: number;
  transactionType: string;
  /**
   * La referencia del asiento (la orden en los de retención). `null` en los `NETWORK_*`: es el id de
   * una orden de otro nodo, que éste no puede abrir.
   */
  referenceId: string | null;
  notes: string | null;
  /**
   * Quién lo registró. `null` en los asientos de la red (`NETWORK_*`), que firma un vendedor de otro
   * nodo, y en los de retención (`BOOKING_*`) que firmó alguien sin membership en el nodo.
   */
  createdBy: string | null;
  /** El nombre de quien lo registró, si lo cargó. Nunca el email: lo ve toda la agencia. */
  createdByName: string | null;
  /**
   * La reserva de la red de un asiento `NETWORK_*`, sólo para quien administra el nodo; `null` en
   * los demás asientos y para el resto del personal.
   */
  network: WalletMovementNetwork | null;
  createdAt: Date;
}

/** Una reserva de la red retenida en una cartera del nodo, al costo de su nivel. */
export interface NetworkHoldItemView {
  levelId: string;
  currency: string;
  exponent: number | null;
  amountMinor: number;
  status: WalletHoldStatus;
  originTenantId: string;
  originTenantName: string | null;
  orderNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Lo retenido (retenido o en revisión) y lo cobrado por la red, por moneda. */
export interface NetworkHoldTotalView {
  currency: string;
  exponent: number | null;
  heldMinor: number;
  chargedMinor: number;
}

export interface NetworkHoldsView {
  items: NetworkHoldItemView[];
  totals: NetworkHoldTotalView[];
}

/** Lo que el listado de movimientos muestra de cada asiento, además del monto y el tipo. */
export interface MovementsOptions {
  /** Los datos de la reserva de la red en los `NETWORK_*`: sólo para quien administra el nodo. */
  readonly includeNetwork: boolean;
}

/** Lo que `movementView` sabe de un asiento además de su fila. */
export interface MovementExtras {
  readonly network?: WalletMovementNetwork | null;
  /** `false`: quien lo firmó no tiene membership en el nodo (sólo pesa en los `BOOKING_*`). */
  readonly authorIsMember?: boolean;
}

export interface NetworkHoldsFilter {
  readonly currency?: string;
  readonly status?: WalletHoldStatus;
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
  extras: MovementExtras = {},
): WalletMovementView {
  const fromNetwork = NETWORK_ENTRY_TYPES.includes(row.transaction_type);
  const authorHidden =
    fromNetwork ||
    (extras.authorIsMember === false && BOOKING_ENTRY_TYPES.includes(row.transaction_type));
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    currency,
    exponent: currencyExponent(currency) ?? null,
    amountMinor: Number(row.amount_minor),
    transactionType: row.transaction_type,
    referenceId: fromNetwork ? null : row.reference_id,
    notes: row.notes,
    createdBy: authorHidden ? null : row.created_by,
    createdByName: authorHidden ? null : createdByName,
    network: fromNetwork ? (extras.network ?? null) : null,
    createdAt: row.created_at,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
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

/**
 * Los movimientos de las carteras del nodo (o de la de una moneda), del más nuevo al más viejo.
 *
 * Un asiento de la red (`NETWORK_*`) sale sin quién lo firmó (ni siquiera se cruza con `users`) y
 * sin el id de la orden de otro nodo; con `includeNetwork`, con la agencia de origen y el número de
 * reserva de su nivel (la RLS de `wallet_hold_levels` deja ver sólo los niveles de este nodo). Un
 * asiento de retención propio (`BOOKING_*`) muestra quién lo firmó sólo si tiene membership en el
 * nodo: la liberación de una conciliación la firma alguien de arriba.
 */
export async function listMovements(
  trx: Transaction<DB>,
  tenantId: string,
  currency: string | undefined,
  options: MovementsOptions,
): Promise<WalletMovementView[]> {
  let query = trx
    .selectFrom('portfolio_transactions as t')
    .innerJoin('agency_portfolios as p', 'p.id', 't.portfolio_id')
    .leftJoin('users as u', (join) =>
      join
        .onRef('u.id', '=', 't.created_by')
        .on('t.transaction_type', 'not in', [...NETWORK_ENTRY_TYPES]),
    )
    .leftJoin('wallet_hold_levels as l', (join) =>
      join
        .on((eb) =>
          eb.or([
            eb('l.hold_transaction_id', '=', eb.ref('t.id')),
            eb('l.release_transaction_id', '=', eb.ref('t.id')),
          ]),
        )
        .on('l.depth', '>', 0),
    )
    .leftJoin('tenants as ot', 'ot.id', 'l.origin_tenant_id')
    .selectAll('t')
    .select([
      'p.currency as wallet_currency',
      'u.name as created_by_name',
      'l.origin_tenant_id as network_origin_tenant_id',
      'ot.name as network_origin_tenant_name',
      'l.order_number as network_order_number',
      'l.status as network_status',
      sql<boolean>`EXISTS (
        SELECT 1 FROM memberships m WHERE m.user_id = t.created_by AND m.tenant_id = p.tenant_id
      )`.as('author_is_member'),
    ])
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
      {
        authorIsMember: row.author_is_member === true,
        network:
          !options.includeNetwork ||
          row.network_origin_tenant_id === null ||
          row.network_status === null
            ? null
            : {
                originTenantId: row.network_origin_tenant_id,
                originTenantName: row.network_origin_tenant_name ?? null,
                orderNumber: numberOrNull(row.network_order_number),
                status: row.network_status,
              },
      },
    ),
  );
}

/**
 * Lo que la red del nodo tiene retenido o cobrado en sus carteras (los niveles de 0060 con depth
 * ≥ 1 de los que es dueño), al costo de su nivel: la agencia de origen, el número de reserva, el
 * monto, el estado y las fechas. Nunca el vendedor, los pasajeros ni el precio de venta.
 *
 * Los totales son por moneda sobre todas las reservas abiertas del nodo (con el filtro de moneda,
 * no el de estado): `heldMinor` lo retenido o en revisión, `chargedMinor` lo cobrado.
 */
export async function listNetworkHolds(
  trx: Transaction<DB>,
  tenantId: string,
  filter: NetworkHoldsFilter = {},
): Promise<NetworkHoldsView> {
  let items = trx
    .selectFrom('wallet_hold_levels as l')
    .leftJoin('tenants as ot', 'ot.id', 'l.origin_tenant_id')
    .select([
      'l.id',
      'l.currency',
      'l.amount_minor',
      'l.status',
      'l.origin_tenant_id',
      'ot.name as origin_tenant_name',
      'l.order_number',
      'l.created_at',
      'l.updated_at',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.depth', '>', 0);
  if (filter.currency !== undefined) items = items.where('l.currency', '=', filter.currency);
  if (filter.status !== undefined) items = items.where('l.status', '=', filter.status);
  const rows = await items
    .orderBy('l.created_at', 'desc')
    .orderBy('l.id', 'desc')
    .limit(NETWORK_HOLDS_LIMIT)
    .execute();

  let totals = trx
    .selectFrom('wallet_hold_levels as l')
    .select([
      'l.currency',
      sql<string>`COALESCE(sum(l.amount_minor) FILTER (WHERE l.status IN ('held', 'conflict')), 0)`.as(
        'held_minor',
      ),
      sql<string>`COALESCE(sum(l.amount_minor) FILTER (WHERE l.status = 'captured'), 0)`.as(
        'charged_minor',
      ),
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.depth', '>', 0)
    .where('l.status', 'in', ['held', 'captured', 'conflict']);
  if (filter.currency !== undefined) totals = totals.where('l.currency', '=', filter.currency);
  const sums = await totals.groupBy('l.currency').orderBy('l.currency').execute();

  return {
    items: rows.map((r) => ({
      levelId: r.id,
      currency: r.currency,
      exponent: currencyExponent(r.currency) ?? null,
      amountMinor: Number(r.amount_minor),
      status: r.status,
      originTenantId: r.origin_tenant_id,
      originTenantName: r.origin_tenant_name ?? null,
      orderNumber: numberOrNull(r.order_number),
      createdAt: r.created_at as unknown as Date,
      updatedAt: r.updated_at as unknown as Date,
    })),
    totals: sums.map((t) => ({
      currency: t.currency,
      exponent: currencyExponent(t.currency) ?? null,
      heldMinor: Number(t.held_minor),
      chargedMinor: Number(t.charged_minor),
    })),
  };
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
