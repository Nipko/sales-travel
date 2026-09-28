import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { InflightWorkRegistry } from './inflight-work.registry.js';

/**
 * Apagado ordenado del contenedor `api` (docs/tbo/09 PR-4.10; 08 RF-22 CA 3 y R-23).
 *
 * Al recibir SIGTERM —`docker compose up -d` recrea el contenedor en cada despliegue—:
 *
 * 1. deja de aceptar conexiones y marca `Connection: close` en las respuestas pendientes, para que
 *    los sockets keep-alive del proxy se cierren al terminar la respuesta y no sigan trayendo
 *    peticiones;
 * 2. arranca los `onShutdown` del registro (los workers de BullMQ dejan de tomar jobs) y espera a
 *    las peticiones HTTP en curso y al trabajo registrado en `InflightWorkRegistry` —la saga del
 *    Book que sigue después de un `202`, los handlers cuyo cliente se fue y los jobs activos—,
 *    hasta `drainTimeoutMs`;
 * 3. recién entonces corre `app.close()`: los `onModuleDestroy` que cierran el pool de Postgres, la
 *    cola y el worker de BullMQ.
 *
 * No se usa `app.enableShutdownHooks()` porque en Nest 10 su manejador hace el paso 3 ANTES de
 * cerrar el servidor HTTP (`callDestroyHook` y después `dispose`): la petición que se quería dejar
 * terminar se quedaría sin base de datos a mitad del Book. `app.close()` corre los mismos hooks en
 * el mismo orden, así que nada que dependa de ellos cambia.
 *
 * Lo que no termina a tiempo se corta y sale con código 1: un Book cortado deja su intent
 * `pending` para la recuperación de RF-21, que es correcta aunque más lenta.
 */

export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export interface ShutdownLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, stack?: string): void;
}

/** Lo que el apagado usa de `process`; los tests pasan un `EventEmitter`. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface GracefulShutdownOptions {
  readonly server: Server;
  readonly work: Pick<InflightWorkRegistry, 'size' | 'whenIdle' | 'countsByKind' | 'startShutdown'>;
  readonly closeApp: () => Promise<void>;
  readonly drainTimeoutMs: number;
  readonly logger: ShutdownLogger;
  readonly signals?: readonly NodeJS.Signals[];
  readonly signalSource?: SignalSource;
  readonly exit?: (code: number) => void;
}

export interface GracefulShutdown {
  /** Lo que corre la primera señal. Idempotente: una segunda llamada devuelve la misma promesa. */
  readonly shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { server, work, closeApp, drainTimeoutMs, logger } = options;
  const exit = options.exit ?? ((code: number): void => process.exit(code));

  const inflight = new Set<ServerResponse>();
  let httpIdleWaiters: Array<() => void> = [];
  let draining = false;
  let running: Promise<void> | undefined;

  // `prependListener` para correr antes que Express: una respuesta que el framework manda en el
  // mismo tick (un 404) ya tendría las cabeceras enviadas si llegáramos después.
  server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
    inflight.add(res);
    // Una petición que entra durante el drenaje llega por un socket keep-alive ya abierto: se
    // atiende, pero ese socket no puede traer otra.
    if (draining) res.setHeader('Connection', 'close');
    res.once('close', () => {
      inflight.delete(res);
      if (inflight.size === 0) {
        const waiters = httpIdleWaiters;
        httpIdleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
  });

  const httpIdle = (): Promise<void> =>
    inflight.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => httpIdleWaiters.push(resolve));

  const drain = async (): Promise<void> => {
    // Una petición en curso puede registrar trabajo (la saga del Book) cuando el registro ya
    // estaba vacío: se repite hasta ver los dos lados vacíos a la vez.
    while (inflight.size > 0 || work.size > 0) {
      await Promise.all([httpIdle(), work.whenIdle()]);
    }
  };

  const drainWithDeadline = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), drainTimeoutMs);
    });
    try {
      return await Promise.race([drain().then(() => true as const), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  const pendingSummary = (): string =>
    `${inflight.size} peticiones HTTP, trabajos ${describeCounts(work.countsByKind())}`;

  const run = async (signal: NodeJS.Signals): Promise<void> => {
    draining = true;
    logger.log(`${signal}: no se aceptan conexiones nuevas; en curso: ${pendingSummary()}`);
    // En Node >= 19, `close()` también cierra en el acto los sockets keep-alive ociosos.
    server.close();
    for (const res of inflight) {
      if (!res.headersSent) res.setHeader('Connection', 'close');
    }
    work.startShutdown((kind, err) => {
      logger.warn(
        `${kind}: falló al detenerse (${err instanceof Error ? err.message : String(err)})`,
      );
    });

    const drained = await drainWithDeadline();
    if (!drained) {
      logger.warn(
        `el drenaje superó ${drainTimeoutMs} ms; se corta lo que queda: ${pendingSummary()}. ` +
          'Un Book cortado queda pending para la recuperación (RF-21).',
      );
    }
    // Todas, también tras un drenaje completo: lo que quede es un socket ocioso o una petición a
    // medio llegar que ya no se va a atender. Con ella abierta, el `server.close` de `app.close()`
    // esperaría hasta el `headersTimeout` (60 s) y el SIGKILL llegaría antes que el cierre del pool.
    server.closeAllConnections();

    await closeApp();
    logger.log(drained ? 'apagado completo' : 'apagado completo con trabajo cortado');
    exit(drained ? 0 : 1);
  };

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    running ??= run(signal).catch((err: unknown) => {
      logger.error(
        `falló el apagado: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      exit(1);
    });
    return running;
  };

  const source = options.signalSource ?? process;
  for (const signal of options.signals ?? SHUTDOWN_SIGNALS) {
    source.on(signal, (received: NodeJS.Signals) => {
      if (running !== undefined) {
        // Docker manda una sola SIGTERM y después SIGKILL: una segunda señal la manda una
        // persona (Ctrl+C dos veces) que no quiere esperar el drenaje.
        logger.warn(`segunda señal ${received} durante el apagado: salida inmediata`);
        exit(1);
        return;
      }
      void shutdown(received);
    });
  }

  return { shutdown };
}

function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'ninguno';
  return entries.map(([kind, count]) => `${kind}=${count}`).join(', ');
}
