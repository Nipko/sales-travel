import type { TboLane } from './operations';

/**
 * Cuota de QPS y concurrencia por cuenta TBO (docs/tbo/01 §7.2; 08 RNF-02; D-TBO-17 A).
 *
 * TBO devuelve `429 LIMIT_EXCEEDED` pero no publica el valor, ni si va por usuario, por IP o por
 * método (p. 9; Q-10). Hasta que lo publique:
 *
 * - La clave es la CUENTA resuelta (`accountRef`, digest de dueño + usuario), no el tenant: las
 *   sub-agencias que heredan la cuenta del consolidador comparten el cupo que TBO les ve (INFERIDO).
 * - 5 QPS y 4 llamadas en vuelo por cuenta, configurables (INFERIDO, sin evidencia de TBO).
 * - Cupos separados. El dinero (Book, Cancel y la lectura de cierre de un Book) puede usar toda la
 *   capacidad y tiene una reserva que nadie más toca: una campaña de búsquedas no puede dejar sin
 *   conciliar una reserva. El fondo (HCN, conciliación) tiene un techo propio para no quitarle
 *   cupo al vendedor. La verificación de un Book incierto desde un job también tiene techo propio
 *   —sin él, una ráfaga de jobs tras una caída de TBO ocupaba toda la cuenta—, pero pasa antes que
 *   las búsquedas: una campaña de ventas no puede impedir averiguar si una reserva existe (04 §9.5
 *   punto 5, PV-41).
 * - Ante un 429 el ritmo de la cuenta baja a la mitad durante 60 s (INFERIDO).
 *
 * Estado en memoria mientras haya un solo contenedor de API, como el breaker
 * (`apps/api/src/search/circuit-breaker.service.ts`). Cuando se escale, la implementación
 * compartida va detrás de un port de `packages/core`: `CachePort` no tiene operaciones atómicas
 * (01 §7.2 punto 6). Por eso el cliente depende de la interfaz {@link TboRateLimiter} y no de esta
 * clase.
 */

export interface TboLimiterRequest {
  readonly accountRef: string;
  readonly lane: TboLane;
  /** Lo máximo que se espera un cupo. Vencido, se rechaza sin llamar a TBO. */
  readonly maxWaitMs: number;
  /** Señal del llamador: si se aborta mientras espera, se rechaza. */
  readonly signal?: AbortSignal;
}

export interface TboLimiterPermit {
  /** Libera el cupo de concurrencia. Idempotente. */
  release(): void;
}

/**
 * Un rechazo NO es una excepción: el limitador no conoce la operación, y quien arma el error
 * tipado con su path es el cliente.
 */
export type TboLimiterGrant =
  | { readonly granted: true; readonly permit: TboLimiterPermit }
  | { readonly granted: false; readonly reason: 'QUEUE_TIMEOUT' | 'ABORTED' };

export interface TboRateLimiter {
  acquire(request: TboLimiterRequest): Promise<TboLimiterGrant>;
  /** TBO respondió 429 (en el cuerpo o en el HTTP) para esa cuenta. */
  reportThrottled(accountRef: string): void;
}

export interface TboLaneQuota {
  readonly qps: number;
  readonly concurrent: number;
}

export interface TboLimiterOptions {
  /** QPS de la cuenta entera. */
  readonly maxQps: number;
  /** Llamadas en vuelo de la cuenta entera. */
  readonly maxConcurrent: number;
  /** Capacidad que sólo puede usar el cupo `money`. */
  readonly moneyReserve: TboLaneQuota;
  /** Techo del cupo `verification`, además de la reserva de dinero. */
  readonly verification: TboLaneQuota;
  /** Techo del cupo `background`, además de la reserva de dinero. */
  readonly background: TboLaneQuota;
  /** Factor del ritmo tras un 429. */
  readonly throttleFactor: number;
  /** Cuánto dura la reducción tras un 429. */
  readonly throttleMs: number;
  readonly now?: () => number;
}

export const TBO_LIMITER_DEFAULTS: Readonly<Omit<TboLimiterOptions, 'now'>> = Object.freeze({
  maxQps: 5,
  maxConcurrent: 4,
  moneyReserve: Object.freeze({ qps: 1, concurrent: 1 }),
  verification: Object.freeze({ qps: 1, concurrent: 1 }),
  background: Object.freeze({ qps: 1, concurrent: 1 }),
  throttleFactor: 0.5,
  throttleMs: 60_000,
});

/** Ventana deslizante del QPS. */
const WINDOW_MS = 1_000;

const MAX_TIMER_MS = 2_147_483_647;

/** Orden de despacho cuando se libera capacidad: el dinero primero, siempre. */
const LANE_PRIORITY: readonly TboLane[] = ['money', 'verification', 'sales', 'background'];

interface Waiter {
  readonly lane: TboLane;
  readonly resolve: (grant: TboLimiterGrant) => void;
  readonly cleanup: () => void;
}

interface AccountState {
  inFlight: number;
  readonly inFlightByLane: Map<TboLane, number>;
  /** Instantes de despacho dentro de la ventana, por cupo. */
  readonly dispatches: { at: number; lane: TboLane }[];
  throttledUntil: number;
  readonly waiters: Waiter[];
  wakeTimer: ReturnType<typeof setTimeout> | undefined;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export class TboInMemoryRateLimiter implements TboRateLimiter {
  readonly #options: Omit<TboLimiterOptions, 'now'>;
  readonly #now: () => number;
  readonly #accounts = new Map<string, AccountState>();

  constructor(options: Partial<TboLimiterOptions> = {}) {
    const merged = { ...TBO_LIMITER_DEFAULTS, ...options };
    this.#options = Object.freeze({
      maxQps: positiveInteger(merged.maxQps, TBO_LIMITER_DEFAULTS.maxQps),
      maxConcurrent: positiveInteger(merged.maxConcurrent, TBO_LIMITER_DEFAULTS.maxConcurrent),
      moneyReserve: merged.moneyReserve,
      verification: merged.verification,
      background: merged.background,
      throttleFactor: merged.throttleFactor,
      throttleMs: merged.throttleMs,
    });
    this.#now = options.now ?? (() => Date.now());
  }

  acquire(request: TboLimiterRequest): Promise<TboLimiterGrant> {
    const state = this.#state(request.accountRef);
    if (request.signal?.aborted === true) {
      return Promise.resolve({ granted: false, reason: 'ABORTED' });
    }
    // Sin cola delante del mismo cupo o de uno más prioritario, se despacha ya; si no, se respeta
    // el orden de llegada para que una ráfaga no adelante a quien ya esperaba.
    if (!this.#hasPriorityWaiter(state, request.lane) && this.#canDispatch(state, request.lane)) {
      return Promise.resolve({
        granted: true,
        permit: this.#dispatch(request.accountRef, state, request.lane),
      });
    }
    return this.#enqueue(request, state);
  }

  reportThrottled(accountRef: string): void {
    const state = this.#state(accountRef);
    state.throttledUntil = this.#now() + this.#options.throttleMs;
  }

  /** Para tests y diagnóstico: llamadas en vuelo de una cuenta. */
  inFlight(accountRef: string): number {
    return this.#accounts.get(accountRef)?.inFlight ?? 0;
  }

  #state(accountRef: string): AccountState {
    let state = this.#accounts.get(accountRef);
    if (state === undefined) {
      state = {
        inFlight: 0,
        inFlightByLane: new Map(),
        dispatches: [],
        throttledUntil: 0,
        waiters: [],
        wakeTimer: undefined,
      };
      this.#accounts.set(accountRef, state);
    }
    return state;
  }

  #effectiveQps(state: AccountState): number {
    const { maxQps, throttleFactor } = this.#options;
    if (this.#now() >= state.throttledUntil) return maxQps;
    return Math.max(1, Math.floor(maxQps * throttleFactor));
  }

  /**
   * Cuánto de la cuenta puede ocupar un cupo. El dinero llega a toda la capacidad; los demás, a
   * toda menos la reserva, con un mínimo de 1 para que un 429 no apague las ventas un minuto entero.
   */
  #accountQuota(state: AccountState, lane: TboLane): TboLaneQuota {
    const qps = this.#effectiveQps(state);
    const { maxConcurrent, moneyReserve } = this.#options;
    if (lane === 'money') return { qps, concurrent: maxConcurrent };
    return {
      qps: Math.max(1, qps - moneyReserve.qps),
      concurrent: Math.max(1, maxConcurrent - moneyReserve.concurrent),
    };
  }

  #prune(state: AccountState): void {
    const horizon = this.#now() - WINDOW_MS;
    while (state.dispatches.length > 0 && (state.dispatches[0]?.at ?? 0) <= horizon) {
      state.dispatches.shift();
    }
  }

  #canDispatch(state: AccountState, lane: TboLane): boolean {
    this.#prune(state);
    const account = this.#accountQuota(state, lane);
    if (state.inFlight >= account.concurrent || state.dispatches.length >= account.qps) {
      return false;
    }
    const own = this.#ceilingOf(lane);
    if (own === undefined) return true;
    // Los jobs, además, se miden contra su propio techo: no ocupan el cupo del vendedor.
    const laneDispatches = state.dispatches.filter((entry) => entry.lane === lane).length;
    return (state.inFlightByLane.get(lane) ?? 0) < own.concurrent && laneDispatches < own.qps;
  }

  #ceilingOf(lane: TboLane): TboLaneQuota | undefined {
    if (lane === 'background') return this.#options.background;
    if (lane === 'verification') return this.#options.verification;
    return undefined;
  }

  #dispatch(accountRef: string, state: AccountState, lane: TboLane): TboLimiterPermit {
    state.inFlight += 1;
    state.inFlightByLane.set(lane, (state.inFlightByLane.get(lane) ?? 0) + 1);
    state.dispatches.push({ at: this.#now(), lane });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.inFlight -= 1;
        state.inFlightByLane.set(lane, Math.max(0, (state.inFlightByLane.get(lane) ?? 1) - 1));
        this.#pump(accountRef, state);
      },
    };
  }

  #hasPriorityWaiter(state: AccountState, lane: TboLane): boolean {
    const rank = LANE_PRIORITY.indexOf(lane);
    return state.waiters.some((waiter) => LANE_PRIORITY.indexOf(waiter.lane) <= rank);
  }

  #enqueue(request: TboLimiterRequest, state: AccountState): Promise<TboLimiterGrant> {
    return new Promise<TboLimiterGrant>((resolve) => {
      const onAbort = (): void => finish({ granted: false, reason: 'ABORTED' });
      const timer = setTimeout(
        () => finish({ granted: false, reason: 'QUEUE_TIMEOUT' }),
        // Node convierte en 1 ms cualquier espera por encima de 2^31-1: un `Infinity` despacharía ya.
        Math.min(MAX_TIMER_MS, Math.max(0, request.maxWaitMs)),
      );
      const waiter: Waiter = {
        lane: request.lane,
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
        },
      };
      function finish(grant: TboLimiterGrant): void {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        waiter.cleanup();
        resolve(grant);
      }
      request.signal?.addEventListener('abort', onAbort, { once: true });
      state.waiters.push(waiter);
      // Un cupo más prioritario puede estar esperando sólo su propio techo (una ráfaga de
      // verificaciones): eso no frena a éste, que sale ya si su cupo tiene lugar.
      this.#pump(request.accountRef, state);
    }).finally(() => {
      // Quien se va de la cola por timeout o por abort puede estar tapando a otros del mismo cupo.
      const current = this.#accounts.get(request.accountRef);
      if (current !== undefined) this.#pump(request.accountRef, current);
    });
  }

  /**
   * Despacha a quien espera, por prioridad de cupo y en orden de llegada dentro del cupo. Si lo que
   * frena es la ventana de QPS y no la concurrencia, programa un despertar para cuando se libere.
   */
  #pump(accountRef: string, state: AccountState): void {
    for (const lane of LANE_PRIORITY) {
      for (;;) {
        const waiter = state.waiters.find((candidate) => candidate.lane === lane);
        if (waiter === undefined || !this.#canDispatch(state, lane)) break;
        state.waiters.splice(state.waiters.indexOf(waiter), 1);
        waiter.cleanup();
        waiter.resolve({ granted: true, permit: this.#dispatch(accountRef, state, lane) });
      }
    }
    this.#scheduleWake(accountRef, state);
    this.#forgetIfIdle(accountRef, state);
  }

  #scheduleWake(accountRef: string, state: AccountState): void {
    if (state.wakeTimer !== undefined || state.waiters.length === 0) return;
    const oldest = state.dispatches[0];
    if (oldest === undefined) return;
    const delay = Math.max(1, oldest.at + WINDOW_MS - this.#now());
    state.wakeTimer = setTimeout(() => {
      state.wakeTimer = undefined;
      this.#pump(accountRef, state);
    }, delay);
  }

  /** Una cuenta sin actividad no ocupa memoria: sin esto el mapa crece con cada credencial rotada. */
  #forgetIfIdle(accountRef: string, state: AccountState): void {
    this.#prune(state);
    if (
      state.inFlight === 0 &&
      state.waiters.length === 0 &&
      state.dispatches.length === 0 &&
      state.wakeTimer === undefined &&
      this.#now() >= state.throttledUntil
    ) {
      this.#accounts.delete(accountRef);
    }
  }
}
