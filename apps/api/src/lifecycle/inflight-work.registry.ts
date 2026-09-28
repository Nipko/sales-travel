import { Injectable } from '@nestjs/common';

interface ShutdownStopper {
  readonly kind: string;
  readonly stop: () => Promise<unknown>;
}

/**
 * Trabajo del proceso que el apagado ordenado tiene que dejar terminar (`graceful-shutdown.ts`).
 *
 * El caso que lo motiva es el Book híbrido de hoteles (docs/tbo/03 §4.5, RF-22): la petición
 * responde `202` a los 25 s y la saga sigue hasta el timeout de 120 s del proveedor. Para el
 * servidor HTTP esa petición ya terminó, así que un apagado que sólo esperara a las peticiones en
 * curso cortaría el Book en vuelo y lo mandaría a la recuperación de RF-21 aunque sobrara periodo
 * de gracia. Lo mismo pasa con un handler cuyo cliente se fue (`InflightHandlersInterceptor`) y
 * con los jobs activos de un worker de BullMQ (`onShutdown`).
 *
 * Sólo cuenta: no cancela, no reintenta y no toca el resultado. El llamador sigue siendo dueño del
 * valor y del error de la promesa que registra.
 */
@Injectable()
export class InflightWorkRegistry {
  private readonly pending = new Map<symbol, string>();
  private idleWaiters: Array<() => void> = [];
  private stoppers: ShutdownStopper[] = [];
  private shutdownErrorHandler: ((kind: string, err: unknown) => void) | undefined;

  /**
   * Cuenta un trabajo desde ya hasta que se llame a la función devuelta, que es idempotente.
   *
   * `kind` va al log del apagado: un nombre fijo del tipo de trabajo (`hotel-book`), nunca ids,
   * localizadores ni datos del pasajero.
   */
  begin(kind: string): () => void {
    const id = Symbol(kind);
    this.pending.set(id, kind);
    return () => {
      if (!this.pending.delete(id)) return;
      if (this.pending.size === 0) this.notifyIdle();
    };
  }

  /** Registra `work` hasta que se resuelva o falle y lo devuelve tal cual. */
  track<T>(kind: string, work: Promise<T>): Promise<T> {
    const release = this.begin(kind);
    // El rechazo se observa aquí sólo para liberar el registro; el llamador lo sigue recibiendo en
    // la promesa que devolvemos.
    void work.then(release, release);
    return work;
  }

  /**
   * `stop` corre al empezar el apagado, no en `app.close()`, y se espera como un trabajo más.
   *
   * Es para un worker de BullMQ: si siguiera tomando jobs durante el drenaje, `app.close()` los
   * encontraría a medias y Nest destruye `DatabaseService` antes que el módulo del worker (orden
   * por distancia de módulos), así que se quedarían sin pool. Con `worker.close()` aquí deja de
   * tomar jobs y termina los activos con la base abierta; lo que quedó en la cola lo toma el
   * contenedor nuevo.
   */
  onShutdown(kind: string, stop: () => Promise<unknown>): void {
    if (this.shutdownErrorHandler !== undefined) {
      this.runStopper({ kind, stop }, this.shutdownErrorHandler);
      return;
    }
    this.stoppers.push({ kind, stop });
  }

  /** Corre cada `stop` registrado una sola vez; un fallo va a `onError` y libera el registro. */
  startShutdown(onError: (kind: string, err: unknown) => void): void {
    if (this.shutdownErrorHandler !== undefined) return;
    this.shutdownErrorHandler = onError;
    const stoppers = this.stoppers;
    this.stoppers = [];
    for (const stopper of stoppers) this.runStopper(stopper, onError);
  }

  get size(): number {
    return this.pending.size;
  }

  countsByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const kind of this.pending.values()) counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }

  /** Resuelve cuando no queda trabajo registrado; en el acto si ya no hay. */
  whenIdle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private runStopper(
    { kind, stop }: ShutdownStopper,
    onError: (kind: string, err: unknown) => void,
  ): void {
    // `then` y no una llamada directa: un `stop` que lanza en el acto cae en el mismo `catch`.
    void this.track(kind, Promise.resolve().then(stop)).catch((err: unknown) => onError(kind, err));
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
