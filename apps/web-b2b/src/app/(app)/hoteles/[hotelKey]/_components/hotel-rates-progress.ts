import type { HotelAccountEnvironment, HotelOffer } from '../../actions';
import type { HotelProviderHotelRef } from '../../_components/hotel-key';
import type { HotelDetailRatesResult, HotelRatesOutcome } from '../actions';

/*
 * Las tarifas de la ficha llegan proveedor por proveedor (`POST /api/hotels/rates`, un pedido por
 * cada uno): lo que respondió se pinta ya, y lo que falta se cuenta aparte. Un proveedor colgado
 * hasta su plazo ya no frena a los demás, y uno que falla queda con su motivo sin tapar a nadie.
 */

export const RATES_ENDPOINT = '/api/hotels/rates';

export const RATES_UNREACHABLE =
  'No pudimos conectar para traer las tarifas. Revisa tu conexión e intenta de nuevo.';
const INCOMPLETE = 'La respuesta del proveedor llegó incompleta.';

/** Las tarifas de una consulta de la ficha mientras llegan. */
export interface RatesProgress {
  /** Los proveedores de la clave, en su orden. */
  readonly refs: readonly HotelProviderHotelRef[];
  /** Los que ya respondieron (con tarifas, sin ellas o con un error), por código. */
  readonly settled: ReadonlyMap<string, HotelRatesOutcome>;
  /** La última hora del servidor que llegó (epoch en ms). */
  readonly receivedAt?: number;
  readonly nonRefundableBlocked: boolean;
}

/** La respuesta de un proveedor, ya leída. */
export interface ProviderRatesArrival {
  readonly outcome: HotelRatesOutcome;
  readonly receivedAt?: number;
  readonly nonRefundableBlocked?: boolean;
}

export function startRates(refs: readonly HotelProviderHotelRef[]): RatesProgress {
  return { refs, settled: new Map(), nonRefundableBlocked: false };
}

/** Suma la respuesta de un proveedor. La de uno que no está en la clave no cuenta. */
export function settleProvider(
  progress: RatesProgress,
  arrival: ProviderRatesArrival,
): RatesProgress {
  const provider = arrival.outcome.ref.provider;
  if (!progress.refs.some((r) => r.provider === provider)) return progress;
  const settled = new Map(progress.settled);
  settled.set(provider, arrival.outcome);
  const receivedAt =
    arrival.receivedAt === undefined
      ? progress.receivedAt
      : Math.max(progress.receivedAt ?? 0, arrival.receivedAt);
  return {
    refs: progress.refs,
    settled,
    ...(receivedAt === undefined ? {} : { receivedAt }),
    nonRefundableBlocked: progress.nonRefundableBlocked || arrival.nonRefundableBlocked === true,
  };
}

/** Cuántos proveedores faltan. */
export function pendingProviders(progress: RatesProgress): number {
  return progress.refs.filter((r) => !progress.settled.has(r.provider)).length;
}

/**
 * Lo que ya se puede pintar, en el orden de la clave; `undefined` mientras no respondió ninguno.
 * Mientras falte alguno, `ok` dice si ya hay tarifas de alguien.
 */
export function ratesSoFar(progress: RatesProgress): HotelDetailRatesResult | undefined {
  const outcomes = progress.refs
    .map((r) => progress.settled.get(r.provider))
    .filter((o): o is HotelRatesOutcome => o !== undefined);
  if (outcomes.length === 0) return undefined;
  return {
    ok: outcomes.some((o) => o.offer !== undefined),
    outcomes,
    ...(progress.receivedAt === undefined ? {} : { receivedAt: progress.receivedAt }),
    ...(progress.nonRefundableBlocked ? { nonRefundableBlocked: true } : {}),
  };
}

function isOffer(value: unknown): value is HotelOffer {
  if (typeof value !== 'object' || value === null) return false;
  const { hotelId, roompacks } = value as { hotelId?: unknown; roompacks?: unknown };
  return typeof hotelId === 'string' && Array.isArray(roompacks);
}

function messageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

/**
 * Lee lo que respondió `POST /api/hotels/rates` para `ref`. El desenlace se arma con el `ref`
 * pedido, no con el que diga la respuesta; un cuerpo raro es un error de ESE proveedor.
 */
export function readProviderRates(
  ref: HotelProviderHotelRef,
  status: number,
  body: unknown,
): ProviderRatesArrival {
  if (status < 200 || status >= 300) {
    return { outcome: { ref, error: messageOf(body) ?? RATES_UNREACHABLE } };
  }
  if (typeof body !== 'object' || body === null) return { outcome: { ref, error: INCOMPLETE } };
  const raw = body as { outcome?: unknown; receivedAt?: unknown; nonRefundableBlocked?: unknown };
  const receivedAt =
    typeof raw.receivedAt === 'number' && Number.isFinite(raw.receivedAt)
      ? raw.receivedAt
      : undefined;
  const extras = {
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(raw.nonRefundableBlocked === true ? { nonRefundableBlocked: true } : {}),
  };
  const outcome =
    typeof raw.outcome === 'object' && raw.outcome !== null
      ? (raw.outcome as { offer?: unknown; error?: unknown; accountEnvironment?: unknown })
      : undefined;
  if (outcome !== undefined && isOffer(outcome.offer)) {
    const env = outcome.accountEnvironment;
    const accountEnvironment: HotelAccountEnvironment | undefined =
      env === 'test' || env === 'live' ? env : undefined;
    return {
      outcome: {
        ref,
        offer: outcome.offer,
        ...(accountEnvironment === undefined ? {} : { accountEnvironment }),
      },
      ...extras,
    };
  }
  const error =
    typeof outcome?.error === 'string' && outcome.error.trim() ? outcome.error : INCOMPLETE;
  return { outcome: { ref, error }, ...extras };
}

/**
 * Pide las tarifas de cada proveedor por separado y avisa cada una apenas llega. Nunca rechaza:
 * un corte de red o una respuesta que no es JSON es el error de ese proveedor.
 */
export function fetchRatesByProvider(
  hotelKey: string,
  refs: readonly HotelProviderHotelRef[],
  stay: unknown,
  onArrival: (arrival: ProviderRatesArrival) => void,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  return Promise.all(
    refs.map(async (ref) => {
      let arrival: ProviderRatesArrival;
      try {
        const res = await fetcher(RATES_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hotelKey, provider: ref.provider, stay }),
          cache: 'no-store',
          signal,
        });
        let body: unknown;
        try {
          body = (await res.json()) as unknown;
        } catch {
          body = undefined;
        }
        arrival = readProviderRates(ref, res.status, body);
      } catch {
        arrival = { outcome: { ref, error: RATES_UNREACHABLE } };
      }
      if (!signal.aborted) onArrival(arrival);
    }),
  ).then(() => undefined);
}
