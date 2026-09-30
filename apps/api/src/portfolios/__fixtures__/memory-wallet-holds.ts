import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../database/database.service.js';

/**
 * Las funciones de retención de 0060 (`wallet_hold_retain`, `_settle`, `_preview`,
 * `_report_block`) y las tablas que la API lee alrededor, en memoria, para los tests unitarios del
 * servicio y del ledger. Modela lo que la API ve: la cartera del nodo que vende con las reglas de
 * `wallet_hold_decide`, el todo o nada, los errores con su SQLSTATE y su regla, y la RLS por tenant.
 * La red por encima es una perilla (`network`): quién retiene y cuánto lo prueban los tests de
 * integración contra la base.
 *
 * Cada `withTenant` es una transacción: trabaja sobre una copia y la publica sólo si el callback
 * termina, en serie como las filas bloqueadas de Postgres.
 */

const NOW = new Date('2026-09-29T12:00:00.000Z');

export interface MemoryOrder {
  id: string;
  tenant_id: string;
  status: string;
  total_amount: number;
  currency: string;
  provider: string;
  provider_order_id: string | null;
  provider_raw: unknown;
  create_request_key: string | null;
  vertical?: string;
}

export interface MemoryWallet {
  id: string;
  tenant_id: string;
  credit_limit_minor: number;
  balance_minor: number;
  currency: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryEntry {
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

export interface MemoryGroup {
  id: string;
  order_id: string;
  origin_tenant_id: string;
  status: 'held' | 'captured' | 'released' | 'conflict';
  created_by: string;
}

export interface MemoryLevel {
  group_id: string;
  order_id: string;
  depth: number;
  tenant_id: string;
  portfolio_id: string;
  amount_minor: number;
  hold_transaction_id: string;
  release_transaction_id: string | null;
  status: MemoryGroup['status'];
}

export type NetworkRule =
  | 'network_currency_not_enabled'
  | 'network_funds_unavailable'
  | 'network_cost_unavailable';

export interface MemoryWalletHoldState {
  orders: MemoryOrder[];
  wallets: MemoryWallet[];
  entries: MemoryEntry[];
  groups: MemoryGroup[];
  levels: MemoryLevel[];
}

export interface NetworkKnob {
  /** Un nivel de la red rechaza después de que la cartera propia alcanzó. */
  rejectWith?: NetworkRule;
  /** `wallet_hold_preview` no puede evaluar (una cuenta que no se resuelve). */
  previewUnknown?: boolean;
  /** `wallet_hold_retain` lanza `hold_owner_unresolvable`. */
  ownerUnresolvable?: boolean;
}

/** Un error como los de `pg`: SQLSTATE, regla y un mensaje con ids que no debe llegar al usuario. */
export function pgError(code: string, constraint?: string): Error {
  return Object.assign(
    new Error(`mensaje crudo de la base (order=7970ade5-0000-4000-8000-000000000000)`),
    { code, ...(constraint === undefined ? {} : { constraint }) },
  );
}

function clone(s: MemoryWalletHoldState): MemoryWalletHoldState {
  return {
    orders: s.orders.map((o) => ({ ...o })),
    wallets: s.wallets.map((w) => ({ ...w })),
    entries: s.entries.map((e) => ({ ...e })),
    groups: s.groups.map((g) => ({ ...g })),
    levels: s.levels.map((l) => ({ ...l })),
  };
}

function decide(wallet: MemoryWallet | undefined, amount: number): string {
  if (wallet === undefined) return 'currency_not_enabled';
  if (wallet.status !== 'active') return 'inactive';
  return wallet.balance_minor + Math.max(wallet.credit_limit_minor, 0) < amount
    ? 'funds_insufficient'
    : 'ok';
}

interface CompiledLike {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export class MemoryWalletHolds {
  readonly state: MemoryWalletHoldState;
  readonly network: NetworkKnob = {};
  /** Lo que la API ejecutó, en orden: el SQL de cada llamada y cada lectura con su tabla. */
  readonly log: string[] = [];
  /** Cada función de 0060 que se llamó, con el tenant de la transacción y sus parámetros. */
  readonly calls: { fn: string; tenantId: string; params: readonly unknown[] }[] = [];
  /** Las órdenes por las que se pidió el aviso al ancestro, con su tenant. */
  readonly reports: { tenantId: string; orderId: string }[] = [];
  /** Los avisos del PreBook bloqueado por la red, con su tenant y lo que se cotizó. */
  readonly previewReports: { tenantId: string; params: readonly unknown[] }[] = [];
  /** SQLSTATE que `wallet_hold_retain` lanza, uno por intento, antes de hacer nada. */
  readonly retainLockErrors: string[] = [];
  /** SQLSTATE que `wallet_hold_settle` lanza, uno por intento, antes de hacer nada. */
  readonly settleLockErrors: string[] = [];
  /** Si se define, `wallet_hold_report_block` y `wallet_hold_report_preview_block` fallan. */
  reportFailure: Error | undefined;
  private queue = Promise.resolve();

  constructor(initial: Partial<MemoryWalletHoldState> = {}) {
    this.state = {
      orders: initial.orders ?? [],
      wallets: initial.wallets ?? [],
      entries: initial.entries ?? [],
      groups: initial.groups ?? [],
      levels: initial.levels ?? [],
    };
  }

  static wallet(tenantId: string, extra: Partial<MemoryWallet> = {}): MemoryWallet {
    return {
      id: randomUUID(),
      tenant_id: tenantId,
      credit_limit_minor: 0,
      balance_minor: 0,
      currency: 'USD',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
      ...extra,
    };
  }

  wallet(tenantId: string, currency: string): MemoryWallet | undefined {
    return this.state.wallets.find((w) => w.tenant_id === tenantId && w.currency === currency);
  }

  groupOf(orderId: string): MemoryGroup | undefined {
    return this.state.groups.find((g) => g.order_id === orderId.toLowerCase());
  }

  asDatabase(): DatabaseService {
    return { withTenant: this.withTenant.bind(this) } as unknown as DatabaseService;
  }

  async withTenant<T>(tenantId: string, fn: (trx: unknown) => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => turn);
    await previous;

    const local = clone(this.state);
    try {
      const out = await fn(this.trx(tenantId, local));
      Object.assign(this.state, local);
      return out;
    } finally {
      release();
    }
  }

  private trx(tenantId: string, s: MemoryWalletHoldState) {
    const selectFrom = (from: string) => this.select(tenantId, s, from);
    const executeQuery = (q: CompiledLike) => this.execute(tenantId, s, q);
    return { selectFrom, executeQuery };
  }

  // ─────────────────────────── Lecturas de la API ───────────────────────────

  private select(tenantId: string, s: MemoryWalletHoldState, from: string) {
    const table = from.split(' ')[0] ?? from;
    const filters: [string, unknown, unknown][] = [];
    let locked = false;
    const matches = (row: Record<string, unknown>) =>
      filters.every(([column, op, value]) => {
        const key = column.includes('.') ? column.split('.')[1]! : column;
        if (!(key in row)) return true;
        const v = row[key];
        if (op === 'in') return (value as unknown[]).includes(v);
        return typeof v === 'string' && typeof value === 'string'
          ? v.toLowerCase() === value.toLowerCase()
          : v === value;
      });
    const rows = (): Record<string, unknown>[] => {
      switch (table) {
        case 'orders':
          return s.orders.filter((o) => o.tenant_id === tenantId) as unknown as Record<
            string,
            unknown
          >[];
        case 'agency_portfolios':
          return s.wallets.filter((w) => w.tenant_id === tenantId) as unknown as Record<
            string,
            unknown
          >[];
        case 'portfolio_transactions':
          return s.entries.filter((e) =>
            s.wallets.some((w) => w.id === e.portfolio_id && w.tenant_id === tenantId),
          ) as unknown as Record<string, unknown>[];
        case 'wallet_hold_groups':
          // El grupo con su nivel 0, como el JOIN de `BookingHoldLedger.load`.
          return s.groups
            .filter((g) => g.origin_tenant_id === tenantId)
            .flatMap((g) => {
              const own = s.levels.find((l) => l.group_id === g.id && l.depth === 0);
              return own === undefined
                ? []
                : [
                    {
                      order_id: g.order_id,
                      origin_tenant_id: g.origin_tenant_id,
                      status: g.status,
                      created_by: g.created_by,
                      hold_transaction_id: own.hold_transaction_id,
                      portfolio_id: own.portfolio_id,
                      amount_minor: String(own.amount_minor),
                    },
                  ];
            });
        default:
          throw new Error(`lectura inesperada de ${table}`);
      }
    };
    const q = {
      select: () => q,
      selectAll: () => q,
      innerJoin: () => q,
      where: (column: unknown, op?: unknown, value?: unknown) => {
        if (typeof column === 'string') filters.push([column, op, value]);
        return q;
      },
      forUpdate: () => {
        locked = true;
        return q;
      },
      executeTakeFirst: () => {
        this.log.push(`${table}${locked ? ' FOR UPDATE' : ''}`);
        const row = rows().find(matches);
        if (table !== 'orders' || row === undefined) return Promise.resolve(row);
        const o = row as unknown as MemoryOrder;
        return Promise.resolve({
          ...o,
          vertical: o.vertical ?? null,
        });
      },
    };
    return q;
  }

  // ─────────────────────────── Las funciones de 0060 ───────────────────────────

  // `async`: lo que lanzan las funciones de mentira llega como el rechazo de la consulta.
  private async execute(
    tenantId: string,
    s: MemoryWalletHoldState,
    q: CompiledLike,
  ): Promise<{ rows: unknown[] }> {
    await Promise.resolve();
    const text = q.sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SET LOCAL lock_timeout')) {
      this.log.push(text);
      return { rows: [] };
    }
    const fn = /wallet_hold_[a-z_]+/.exec(text)?.[0];
    if (fn === undefined) throw new Error(`consulta inesperada: ${text}`);
    this.log.push(fn);
    this.calls.push({ fn, tenantId, params: q.parameters });
    switch (fn) {
      case 'wallet_hold_retain':
        return { rows: [this.retain(tenantId, s, q.parameters)] };
      case 'wallet_hold_settle':
        return { rows: [{ outcome: this.settle(tenantId, s, q.parameters) }] };
      case 'wallet_hold_preview':
        return { rows: [this.preview(tenantId, s, q.parameters)] };
      case 'wallet_hold_report_block':
        if (this.reportFailure !== undefined) throw this.reportFailure;
        this.reports.push({ tenantId, orderId: String(q.parameters[0]) });
        return { rows: [{}] };
      case 'wallet_hold_report_preview_block':
        if (this.reportFailure !== undefined) throw this.reportFailure;
        this.previewReports.push({ tenantId, params: q.parameters });
        return { rows: [{}] };
      default:
        throw new Error(`función inesperada: ${fn}`);
    }
  }

  private retain(tenantId: string, s: MemoryWalletHoldState, params: readonly unknown[]) {
    const lockError = this.retainLockErrors.shift();
    if (lockError !== undefined) throw pgError(lockError);
    const orderId = String(params[0]).toLowerCase();
    const actor = String(params[1]);
    const order = s.orders.find((o) => o.id === orderId && o.tenant_id === tenantId);
    if (order === undefined) throw pgError('STW01', 'hold_order_not_found');

    let initial: MemoryGroup['status'];
    if (order.status === 'pending' && order.provider_raw === null && order.create_request_key) {
      initial = 'held';
    } else if (order.status === 'confirmed') {
      initial = 'captured';
    } else {
      throw pgError('STW01', 'hold_order_not_holdable');
    }
    if (
      s.groups.some((g) => g.order_id === order.id) ||
      s.entries.some(
        (e) => e.transaction_type === 'BOOKING_HOLD' && e.reference_id?.toLowerCase() === order.id,
      )
    ) {
      throw pgError('STW01', 'hold_already_exists');
    }
    const currency = order.currency.trim().toUpperCase();
    const amount = order.total_amount;
    if (!Number.isSafeInteger(amount) || amount < 1 || !/^[A-Z]{3}$/.test(currency)) {
      throw pgError('STW01', 'hold_amount_invalid');
    }

    const own = s.wallets.find((w) => w.tenant_id === tenantId && w.currency === currency);
    const decision = decide(own, amount);
    if (decision !== 'ok' || own === undefined) throw pgError('STW02', `hold_${decision}`);
    if (this.network.ownerUnresolvable === true) {
      throw pgError('STW01', 'hold_owner_unresolvable');
    }
    if (this.network.rejectWith !== undefined) throw pgError('STW02', this.network.rejectWith);

    const group: MemoryGroup = {
      id: randomUUID(),
      order_id: order.id,
      origin_tenant_id: tenantId,
      status: initial,
      created_by: actor,
    };
    const entry: MemoryEntry = {
      id: randomUUID(),
      portfolio_id: own.id,
      amount_minor: -amount,
      transaction_type: 'BOOKING_HOLD',
      reference_id: order.id,
      idempotency_key: null,
      notes:
        initial === 'held'
          ? 'Retención de saldo antes de reservar con el proveedor'
          : 'Retención preventiva de saldo por reserva pendiente de emisión',
      created_by: actor,
      created_at: NOW,
    };
    own.balance_minor -= amount;
    s.groups.push(group);
    s.entries.push(entry);
    s.levels.push({
      group_id: group.id,
      order_id: order.id,
      depth: 0,
      tenant_id: tenantId,
      portfolio_id: own.id,
      amount_minor: amount,
      hold_transaction_id: entry.id,
      release_transaction_id: null,
      status: initial,
    });
    return {
      group_id: group.id,
      own_portfolio_id: own.id,
      own_transaction_id: entry.id,
      network_levels: 0,
      mode: 'enforce',
    };
  }

  private settle(tenantId: string, s: MemoryWalletHoldState, params: readonly unknown[]) {
    const lockError = this.settleLockErrors.shift();
    if (lockError !== undefined) throw pgError(lockError);
    const orderId = String(params[0]).toLowerCase();
    const actor = String(params[1]);
    const expected = typeof params[2] === 'string' ? params[2] : null;
    const order = s.orders.find((o) => o.id === orderId && o.tenant_id === tenantId);
    if (order === undefined) throw pgError('STW01', 'hold_order_not_found');
    const group = s.groups.find((g) => g.order_id === order.id);
    if (group === undefined) return 'no-hold';
    if (
      expected !== null &&
      order.status !== expected &&
      (group.status === 'held' || group.status === 'captured')
    ) {
      throw pgError('STW01', 'hold_release_order_open');
    }
    if (order.status === 'pending') return 'open';
    if (order.status === 'confirmed' || order.status === 'ticketed') {
      if (group.status === 'held') {
        this.mark(s, group, 'captured');
        return 'captured';
      }
      return group.status === 'captured'
        ? 'already-captured'
        : group.status === 'released'
          ? 'already-released'
          : 'conflict';
    }
    if (order.status === 'failed' || order.status === 'cancelled') {
      if (group.status === 'released') return 'already-released';
      if (group.status === 'conflict') return 'conflict';
      if (order.status === 'failed' && group.status === 'captured') {
        this.mark(s, group, 'conflict');
        return 'conflict';
      }
      for (const level of s.levels.filter((l) => l.group_id === group.id)) {
        const wallet = s.wallets.find((w) => w.id === level.portfolio_id)!;
        const entry: MemoryEntry = {
          id: randomUUID(),
          portfolio_id: wallet.id,
          amount_minor: level.amount_minor,
          transaction_type: level.depth === 0 ? 'BOOKING_RELEASED' : 'NETWORK_RELEASED',
          reference_id: order.id,
          idempotency_key: null,
          notes:
            order.status === 'failed'
              ? 'El proveedor no hizo la reserva; saldo retenido liberado'
              : 'Cancelación confirmada por el proveedor; saldo retenido liberado',
          created_by: actor,
          created_at: NOW,
        };
        s.entries.push(entry);
        wallet.balance_minor += level.amount_minor;
        level.release_transaction_id = entry.id;
      }
      this.mark(s, group, 'released');
      return 'released';
    }
    return 'open';
  }

  private mark(s: MemoryWalletHoldState, group: MemoryGroup, status: MemoryGroup['status']) {
    group.status = status;
    for (const level of s.levels.filter((l) => l.group_id === group.id)) level.status = status;
  }

  private preview(tenantId: string, s: MemoryWalletHoldState, params: readonly unknown[]) {
    if (this.network.previewUnknown === true) return { status: 'unknown', reason: null };
    const currency = String(params[3]);
    const sale = Number(params[4]);
    const own = s.wallets.find((w) => w.tenant_id === tenantId && w.currency === currency);
    const decision = decide(own, sale);
    if (decision !== 'ok') return { status: 'blocked', reason: `hold_${decision}` };
    if (this.network.rejectWith !== undefined) {
      return { status: 'blocked', reason: this.network.rejectWith };
    }
    return { status: 'ok', reason: null };
  }
}
