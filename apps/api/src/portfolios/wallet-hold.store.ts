import { Logger, type HttpException } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { CompiledQuery, type Transaction } from 'kysely';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  PortfolioHoldBusyError,
  PortfolioReleaseBusyError,
  type BookingHoldQuote,
  type BookingHoldRejection,
} from './booking-hold.js';
import { holdRejectionOfRule, walletHoldHttpError } from './portfolio-errors.js';

/**
 * La puerta de la API a las retenciones de cartera de 0060 (`wallet_hold_*`, db/migrations/0060).
 *
 * La base decide todo —la cadena de la red, el dueño de la credencial, los montos de cada nivel y
 * el orden de los bloqueos— desde la orden: acá sólo se la llama con la orden y el actor, se valida
 * lo que devuelve y se reintenta cuando la red está contenida.
 *
 * Todo corre con `app.current_tenant_id` del nodo que VENDE (`DatabaseService.withTenant`).
 */

/** El `lock_timeout` de la transacción de una retención: el mismo que declaran las funciones. */
export const WALLET_HOLD_LOCK_TIMEOUT = '2s';

/** Cuántas veces se reintenta la transacción entera ante un bloqueo, antes de responder BUSY. */
export const WALLET_HOLD_RETRIES = 2;

const JITTER_MIN_MS = 50;
const JITTER_MAX_MS = 250;

/**
 * Deadlock, `lock_timeout` vencido y serialización: la transacción no escribió nada y se puede
 * repetir entera. Con un solo nivel por `nlevel` en cada cadena y el mismo orden de bloqueo en
 * retain, settle y move no debería haber ciclos; si igual aparece uno, se reintenta.
 */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '55P03', '40001']);

const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que `wallet_hold_retain` devuelve: sólo datos del nodo que vende. */
export interface WalletHoldRetained {
  readonly groupId: string;
  readonly ownPortfolioId: string;
  readonly ownTransactionId: string;
  /** Cuántos niveles de la red retuvieron además del nodo que vende (0 fuera de enforce). */
  readonly networkLevels: number;
  readonly mode: 'off' | 'observe' | 'enforce';
}

export const WALLET_HOLD_SETTLE_OUTCOMES = [
  'released',
  'already-released',
  'captured',
  'already-captured',
  'open',
  'no-hold',
  'conflict',
] as const;

/** Qué hizo `wallet_hold_settle` con la retención de la orden. */
export type WalletHoldSettleOutcome = (typeof WALLET_HOLD_SETTLE_OUTCOMES)[number];

/** La precondición de una liberación: el estado en que la API cree que está la orden. */
export type WalletHoldExpectedStatus = 'failed' | 'cancelled';

/** El aviso previo, sin montos ni qué nivel falló. `undefined` = no se sabe (se sigue). */
export type WalletHoldPreviewDecision =
  | { readonly status: 'ok' }
  | { readonly status: 'blocked'; readonly reason: BookingHoldRejection };

const RetainedRowSchema = z.object({
  group_id: z.string().uuid(),
  own_portfolio_id: z.string().uuid(),
  own_transaction_id: z.string().uuid(),
  network_levels: z.number().int().min(0).max(3),
  mode: z.enum(['off', 'observe', 'enforce']),
});

const SettleRowSchema = z.object({ outcome: z.enum(WALLET_HOLD_SETTLE_OUTCOMES) });

const PreviewRowSchema = z.object({
  status: z.enum(['ok', 'blocked', 'unknown']),
  reason: z.string().nullable(),
});

/** La base devolvió algo que no es lo que promete 0060: un error de programación, no del usuario. */
export class WalletHoldContractError extends Error {
  constructor(fn: string) {
    super(`${fn} devolvió una fila que no cumple el contrato de 0060`);
    this.name = 'WalletHoldContractError';
  }
}

/** Esperas del reintento; inyectables para que los tests no duerman. */
export interface WalletHoldTiming {
  sleep(ms: number): Promise<void>;
  random(): number;
}

const REAL_TIMING: WalletHoldTiming = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

function sqlstate(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function isRetryableLock(error: unknown): boolean {
  const code = sqlstate(error);
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : 'UnknownError';
}

/**
 * Qué intenta la transacción: el 409 de "red ocupada" no dice lo mismo al retener (no se retuvo
 * nada) que al liberar (la reserva ya se cerró y falta devolver el saldo).
 */
export type WalletHoldOperation = 'retain' | 'release';

/**
 * Corre `fn` en UNA transacción con el tenant que vende y `lock_timeout` acotado, y la repite entera
 * hasta {@link WALLET_HOLD_RETRIES} veces, con una espera al azar de 50 a 250 ms, si Postgres la
 * abortó por un bloqueo. Agotados los reintentos, 409 {@link PortfolioHoldBusyError} al retener o
 * {@link PortfolioReleaseBusyError} al liberar: el vendedor espera como mucho unos 6 s en lugar de
 * quedar colgado detrás de la cartera del consolidador.
 *
 * `fn` no traduce errores: el reintento necesita ver el SQLSTATE crudo.
 */
export async function runHoldTransaction<T>(
  db: Pick<DatabaseService, 'withTenant'>,
  tenantId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
  timing: WalletHoldTiming = REAL_TIMING,
  operation: WalletHoldOperation = 'retain',
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.withTenant(tenantId, async (trx) => {
        await trx.executeQuery(
          CompiledQuery.raw(`SET LOCAL lock_timeout = '${WALLET_HOLD_LOCK_TIMEOUT}'`),
        );
        return fn(trx);
      });
    } catch (error) {
      if (!isRetryableLock(error)) throw error;
      if (attempt >= WALLET_HOLD_RETRIES) {
        throw operation === 'release'
          ? new PortfolioReleaseBusyError()
          : new PortfolioHoldBusyError();
      }
      const jitter =
        JITTER_MIN_MS + Math.floor(timing.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
      await timing.sleep(jitter);
    }
  }
}

/**
 * El error HTTP de un error de las retenciones, con la moneda de la reserva para el texto del
 * rechazo, o `undefined` si el error es otra cosa (y sigue su camino).
 */
export function translateWalletHoldError(
  error: unknown,
  currency?: string,
  notHoldableMessage?: string,
): HttpException | undefined {
  return walletHoldHttpError(error, {
    ...(currency === undefined ? {} : { currency }),
    ...(notHoldableMessage === undefined ? {} : { notHoldableMessage }),
  });
}

function safePositive(value: number | null): boolean {
  return value !== null && Number.isSafeInteger(value) && value > 0 && value <= MAX_SAFE_MINOR;
}

/**
 * Los parámetros de `wallet_hold_preview` y del aviso del PreBook, o `undefined` si la cotización
 * trae algo que la base no puede evaluar (y se sigue sin aviso).
 */
function quoteParams(quote: BookingHoldQuote): unknown[] | undefined {
  const account = quote.providerAccountId;
  if (account !== null && !UUID_RE.test(account)) return undefined;
  if (quote.netMinor !== null && !safePositive(quote.netMinor)) return undefined;
  if (!safePositive(quote.amount.amountMinor)) return undefined;
  return [
    quote.providerCode,
    account,
    quote.vertical,
    quote.amount.currency,
    quote.amount.amountMinor,
    quote.netMinor,
  ];
}

export class WalletHoldStore {
  private readonly logger = new Logger(WalletHoldStore.name);

  constructor(
    private readonly db: Pick<DatabaseService, 'withTenant'>,
    private readonly timing: WalletHoldTiming = REAL_TIMING,
  ) {}

  /** {@link runHoldTransaction} de una retención, con la base y las esperas de este store. */
  run<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return runHoldTransaction(this.db, tenantId, fn, this.timing, 'retain');
  }

  /** {@link runHoldTransaction} de un cierre (`wallet_hold_settle`): agotado, 409 de liberación. */
  runRelease<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return runHoldTransaction(this.db, tenantId, fn, this.timing, 'release');
  }

  /**
   * Retiene la orden del nodo de la transacción (`wallet_hold_retain`): su cartera y, en enforce,
   * la de cada nivel de su red hasta el dueño de la credencial. Todo o nada: un rechazo lanza STW02
   * y no deja nada. Montos, moneda y cadena salen de la orden, nunca de acá.
   */
  async retain(
    trx: Transaction<DB>,
    orderId: string,
    actorId: string,
  ): Promise<WalletHoldRetained> {
    const { rows } = await trx.executeQuery<unknown>(
      CompiledQuery.raw('SELECT * FROM public.wallet_hold_retain($1::uuid, $2::uuid)', [
        orderId,
        actorId,
      ]),
    );
    const parsed = RetainedRowSchema.safeParse(rows[0]);
    if (!parsed.success || rows.length !== 1) {
      throw new WalletHoldContractError('wallet_hold_retain');
    }
    return {
      groupId: parsed.data.group_id,
      ownPortfolioId: parsed.data.own_portfolio_id,
      ownTransactionId: parsed.data.own_transaction_id,
      networkLevels: parsed.data.network_levels,
      mode: parsed.data.mode,
    };
  }

  /**
   * Cierra la retención de la orden según su estado (`wallet_hold_settle`), sobre lo registrado:
   * captura, libera todos los niveles o la deja en conflicto. Con `expected`, la orden tiene que
   * estar en ese estado si la retención sigue abierta (STW01 `hold_release_order_open`).
   */
  async settle(
    trx: Transaction<DB>,
    orderId: string,
    actorId: string,
    expected?: WalletHoldExpectedStatus,
  ): Promise<WalletHoldSettleOutcome> {
    const { rows } = await trx.executeQuery<unknown>(
      CompiledQuery.raw(
        'SELECT public.wallet_hold_settle($1::uuid, $2::uuid, $3::text) AS outcome',
        [orderId, actorId, expected ?? null],
      ),
    );
    const parsed = SettleRowSchema.safeParse(rows[0]);
    if (!parsed.success) throw new WalletHoldContractError('wallet_hold_settle');
    return parsed.data.outcome;
  }

  /**
   * El aviso previo (`wallet_hold_preview`): la misma decisión que la retención, sin bloquear ni
   * escribir, con lo que la API sabe antes de abrir la orden. `undefined` = no se sabe (datos que la
   * base no puede evaluar o una cuenta que no se resuelve): quien llama sigue y decide la reserva.
   */
  async preview(
    trx: Transaction<DB>,
    quote: BookingHoldQuote,
  ): Promise<WalletHoldPreviewDecision | undefined> {
    const params = quoteParams(quote);
    if (params === undefined) return undefined;

    const { rows } = await trx.executeQuery<unknown>(
      CompiledQuery.raw(
        `SELECT status, reason
           FROM public.wallet_hold_preview($1::text, $2::uuid, $3::text, $4::text, $5::bigint, $6::bigint)`,
        params,
      ),
    );
    const parsed = PreviewRowSchema.safeParse(rows[0]);
    if (!parsed.success) throw new WalletHoldContractError('wallet_hold_preview');
    if (parsed.data.status === 'ok') return { status: 'ok' };
    if (parsed.data.status === 'unknown') return undefined;
    const reason = holdRejectionOfRule(parsed.data.reason);
    return reason === undefined ? undefined : { status: 'blocked', reason };
  }

  /**
   * Después de un rechazo de la red, el aviso al ancestro que bloqueó (`wallet_hold_report_block`,
   * deduplicado por la base), en su propia transacción: la de la retención ya se revirtió. Es
   * best-effort: si falla, queda un log sin el mensaje de la base (puede citar ids de otros nodos).
   */
  async reportBlock(tenantId: string, orderId: string): Promise<void> {
    await this.report(
      tenantId,
      `order=${orderId}`,
      'SELECT public.wallet_hold_report_block($1::uuid)',
      [orderId],
    );
  }

  /**
   * Lo mismo cuando la red bloquea en el PreBook, antes de que exista la orden
   * (`wallet_hold_report_preview_block`, deduplicado por la base por nodo, moneda y día). Sin esto el
   * nivel que bloquea no se entera: la web frena al vendedor en el PreBook y el Book no corre.
   */
  async reportPreviewBlock(tenantId: string, quote: BookingHoldQuote): Promise<void> {
    const params = quoteParams(quote);
    if (params === undefined) return;
    await this.report(
      tenantId,
      'stage=prebook',
      `SELECT public.wallet_hold_report_preview_block(
         $1::text, $2::uuid, $3::text, $4::text, $5::bigint, $6::bigint)`,
      params,
    );
  }

  private async report(
    tenantId: string,
    what: string,
    query: string,
    params: unknown[],
  ): Promise<void> {
    try {
      await this.db.withTenant(tenantId, (trx) =>
        trx.executeQuery(CompiledQuery.raw(query, params)),
      );
    } catch (error) {
      this.logger.warn(`portfolios.network_hold.report_failed ${what} error=${errorName(error)}`);
    }
  }
}
