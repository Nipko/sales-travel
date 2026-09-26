import {
  TboApiError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboRequestBuildError,
  TboResponseMappingError,
} from '@sales-travel/tbo-hotels';

/**
 * Por dónde pasa cada llamada a TBO de una corrida (05 §6.4 y §10): presupuesto de llamadas y de
 * tiempo, corte ordenado ante `429` y ante una racha de errores, y la traducción de lo que lanza el
 * ACL a "seguir con la siguiente ciudad", "cortar la corrida" o "la cuenta no sirve".
 *
 * Los reintentos con backoff de UNA llamada son del cliente HTTP del ACL (lecturas: hasta 5
 * intentos ante `429` o fallos de transporte). Lo de aquí es la capa de arriba: si después de esos
 * reintentos siguen llegando `429` en llamadas seguidas, la corrida termina "ok parcial" y deja el
 * resto para la próxima, en vez de insistir en bucle contra una cuota que no conocemos (Q-10).
 */

export type StopReason = 'budget' | 'throttled' | 'errors' | 'interrupted';

export interface GateLimits {
  readonly maxCalls: number;
  readonly maxDurationMs: number;
  readonly maxConsecutiveThrottled: number;
  readonly maxConsecutiveErrors: number;
}

export type CallFailure =
  /** La cuenta no sirve (`401`, `402`) o la config no deja armar la llamada: se corta todo. */
  | { readonly type: 'account'; readonly code: string }
  /** La corrida ya se cortó (o se cortó en esta llamada): no se llamó o no importa el resultado. */
  | { readonly type: 'stopped'; readonly reason: StopReason }
  /**
   * Esta llamada falló. `statusCode` va a `last_status_code`; si completó una racha de `429` o de
   * errores, `stopReason` ya quedó puesto y la próxima llamada sale como `stopped`.
   */
  | {
      readonly type: 'failed';
      readonly code: string;
      readonly statusCode: number;
    };

export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CallFailure };

export interface GateCallOptions {
  /**
   * Una llamada de la que la corrida puede prescindir (E5, `hotelcodelist`): su fallo se cuenta en
   * `status429` y `errorsByCode`, pero no suma ni reinicia las rachas que cortan la corrida. Sin
   * esto, el 404 de un método que quizá no existe (CE-05) le quitaría a E3 una llamada de margen y,
   * con un umbral de 1, la corrida entera (08 RF-30 CA 3).
   */
  readonly optional?: boolean;
  /**
   * La llamada aísla códigos de un lote de HotelDetails que ya falló (E4). Si TBO la rechaza por su
   * contenido (`isRequestAttributable`), el fallo se cuenta en `errorsByCode` pero no alarga la
   * racha de errores: aislar cinco códigos malos seguidos son diez fallos seguidos, y sin esto la
   * racha cortaba la corrida antes de terminar el primer lote, sin escribir nada y en cada corrida
   * (05 §10: "un código que falla solo se marca y se sigue"). Un fallo que parece un TBO caído
   * (500, timeout, transporte, cuerpo ilegible, HTTP sin sobre) cuenta igual que siempre.
   */
  readonly isolating?: boolean;
}

/**
 * TBO leyó el request y lo rechazó con un `Status.Code` propio (400, 201 "sin datos", uno que no
 * está en la tabla), o nuestro builder no lo pudo armar: la culpa es del contenido del request, no
 * de un TBO caído. Un 500 no entra, con cuerpo o sin él: es lo que devuelve un TBO que se cae. Un
 * HTTP sin sobre (un 404 de un path equivocado) tampoco, porque nadie leyó el request.
 */
function isRequestAttributable(err: unknown): boolean {
  if (err instanceof TboRequestBuildError) return true;
  return err instanceof TboApiError && err.tboCode !== undefined && err.kind !== 'UPSTREAM';
}

/** Qué hace un fallo con las rachas: sumar, sólo cortar la de `429`, o nada (`optional`). */
type StreakEffect = 'count' | 'answered' | 'ignore';

export interface GateCounters {
  readonly calls: number;
  readonly status429: number;
  readonly errorsByCode: Readonly<Record<string, number>>;
  readonly stopReason: StopReason | undefined;
}

const ACCOUNT_KINDS: ReadonlySet<string> = new Set(['CREDENTIALS_INVALID', 'ACCOUNT_BLOCKED']);

export class CallGate {
  readonly #limits: GateLimits;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #onInterrupt: () => void;
  readonly #interrupt: AbortSignal | undefined;
  #calls = 0;
  #status429 = 0;
  #consecutiveThrottled = 0;
  #consecutiveErrors = 0;
  #stopReason: StopReason | undefined;
  #interrupted = false;
  readonly #errorsByCode: Record<string, number> = {};

  constructor(limits: GateLimits, now: () => number, interrupt?: AbortSignal) {
    this.#limits = limits;
    this.#now = now;
    this.#startedAt = now();
    // El plazo también corta la llamada EN VUELO: sin esto, una llamada lanzada un segundo antes del
    // límite podría estirar la corrida hasta sus 60 s de timeout por 5 intentos.
    this.#timer = setTimeout(() => this.#controller.abort(), limits.maxDurationMs);
    this.#timer.unref?.();
    this.#interrupt = interrupt;
    this.#onInterrupt = () => {
      this.#interrupted = true;
      this.#controller.abort();
    };
    if (interrupt?.aborted === true) this.#onInterrupt();
    else interrupt?.addEventListener('abort', this.#onInterrupt, { once: true });
  }

  /** La señal que el sync pasa a cada llamada del ACL. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get stopReason(): StopReason | undefined {
    return this.#stopReason;
  }

  /**
   * SIGTERM llegó, aunque ninguna llamada lo haya visto todavía. Lo miran las etapas que no pasan
   * por la puerta (E6, sólo SQL): con el contenedor apagándose no se empieza una escritura nueva.
   */
  get interrupted(): boolean {
    return this.#interrupted;
  }

  counters(): GateCounters {
    return {
      calls: this.#calls,
      status429: this.#status429,
      errorsByCode: { ...this.#errorsByCode },
      stopReason: this.#stopReason,
    };
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#interrupt?.removeEventListener('abort', this.#onInterrupt);
  }

  async call<T>(
    run: (signal: AbortSignal) => Promise<T>,
    options: GateCallOptions = {},
  ): Promise<CallResult<T>> {
    const stop = this.#checkBeforeCall();
    if (stop !== undefined) return { ok: false, failure: { type: 'stopped', reason: stop } };
    this.#calls += 1;
    try {
      const value = await run(this.#controller.signal);
      this.#consecutiveThrottled = 0;
      this.#consecutiveErrors = 0;
      return { ok: true, value };
    } catch (err) {
      return { ok: false, failure: this.#classify(err, options) };
    }
  }

  #checkBeforeCall(): StopReason | undefined {
    if (this.#stopReason !== undefined) return this.#stopReason;
    if (this.#controller.signal.aborted) return this.#stop(this.#abortReason());
    if (this.#calls >= this.#limits.maxCalls) return this.#stop('budget');
    if (this.#now() - this.#startedAt >= this.#limits.maxDurationMs) return this.#stop('budget');
    return undefined;
  }

  #abortReason(): StopReason {
    return this.#interrupted ? 'interrupted' : 'budget';
  }

  #stop(reason: StopReason): StopReason {
    this.#stopReason ??= reason;
    return this.#stopReason;
  }

  #classify(err: unknown, options: GateCallOptions): CallFailure {
    // Cortada por el plazo o por SIGTERM: el error que haya lanzado (transporte, cupo abortado) es
    // consecuencia del corte y no dice nada de TBO.
    if (this.#controller.signal.aborted) {
      return { type: 'stopped', reason: this.#stop(this.#abortReason()) };
    }
    const optional = options.optional === true;
    const effect: StreakEffect = optional
      ? 'ignore'
      : options.isolating === true && isRequestAttributable(err)
        ? 'answered'
        : 'count';
    if (err instanceof TboApiError) {
      if (ACCOUNT_KINDS.has(err.kind)) return { type: 'account', code: err.kind };
      if (err.kind === 'THROTTLED') return this.#throttled(optional);
      return this.#failed(err.kind, err.tboCode ?? err.status, effect);
    }
    if (err instanceof TboDispatchRejectedError) {
      return this.#failed(`NOT_DISPATCHED_${err.reason}`, 0, effect);
    }
    // Status 200 con un cuerpo que no entendemos: TBO respondió, lo roto es la lectura. `0` y no
    // `200` en `last_status_code`, que se lee como "esta ciudad está al día".
    if (err instanceof TboResponseMappingError) {
      return this.#failed('MALFORMED_RESPONSE', 0, effect);
    }
    // Un código de ciudad que el builder no acepta: afecta a esa ciudad, no a la cuenta.
    if (err instanceof TboRequestBuildError) return this.#failed('REQUEST_REJECTED', 0, effect);
    if (err instanceof TboConfigError || err instanceof TboCredentialsMissingError) {
      return { type: 'account', code: err.name };
    }
    // Cualquier otra cosa es un bug nuestro: que falle fuerte en vez de contarse como "error de TBO".
    throw err;
  }

  #throttled(optional: boolean): CallFailure {
    this.#status429 += 1;
    this.#count('THROTTLED');
    if (!optional) {
      this.#consecutiveThrottled += 1;
      this.#consecutiveErrors = 0;
      if (this.#consecutiveThrottled >= this.#limits.maxConsecutiveThrottled) {
        this.#stop('throttled');
      }
    }
    return { type: 'failed', code: 'THROTTLED', statusCode: 429 };
  }

  #failed(code: string, statusCode: number, effect: StreakEffect): CallFailure {
    this.#count(code);
    if (effect !== 'ignore') this.#consecutiveThrottled = 0;
    if (effect === 'count') {
      this.#consecutiveErrors += 1;
      if (this.#consecutiveErrors >= this.#limits.maxConsecutiveErrors) this.#stop('errors');
    }
    return { type: 'failed', code, statusCode };
  }

  #count(code: string): void {
    this.#errorsByCode[code] = (this.#errorsByCode[code] ?? 0) + 1;
  }
}
