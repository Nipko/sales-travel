import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import {
  Controller,
  Get,
  Injectable,
  Module,
  type INestApplication,
  type OnModuleDestroy,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_SIGNALS, installGracefulShutdown } from './graceful-shutdown.js';
import { InflightWorkRegistry } from './inflight-work.registry.js';
import { LifecycleModule } from './lifecycle.module.js';

/**
 * Apagado ordenado del contenedor `api` (docs/tbo/09 PR-4.10; 08 RF-22 CA 3, R-23).
 *
 * Salida del PR: "un despliegue con una petición larga en curso la deja terminar". Se verifica con
 * servidores HTTP reales en un puerto efímero, sin Postgres ni Redis; la SIGTERM se simula con un
 * `EventEmitter` para no tocar las señales del proceso de vitest.
 */

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Reply {
  readonly status: number;
  readonly connection: string | undefined;
  readonly body: string;
}

function get(port: number, path: string, agent: http.Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** El código del error de red, o `respondió`: se engancha en el acto para que no quede sin manejar. */
function outcome(reply: Promise<Reply>): Promise<string | undefined> {
  return reply.then(
    () => 'respondió',
    (err: NodeJS.ErrnoException) => err.code,
  );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeLogger(): {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const agents: http.Agent[] = [];
const servers: Server[] = [];

function keepAliveAgent(options: http.AgentOptions = {}): http.Agent {
  const agent = new http.Agent({ keepAlive: true, ...options });
  agents.push(agent);
  return agent;
}

function plainServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const server = http.createServer(handler);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Con Nest de verdad: el orden entre la respuesta y los `onModuleDestroy` es lo que decide si el
// Book en vuelo conserva la base de datos hasta terminar.
// ---------------------------------------------------------------------------------------------

const nest = {
  entered: deferred(),
  release: deferred(),
  clientGone: deferred(),
  events: [] as string[],
};

@Controller('lento')
class SlowController {
  @Get()
  async slow(): Promise<string> {
    nest.entered.resolve();
    await nest.release.promise;
    nest.events.push('handler');
    return 'ok';
  }
}

/** Hace de `DatabaseService`, que cierra el pool de Postgres en `onModuleDestroy`. */
@Injectable()
class DestroyRecorder implements OnModuleDestroy {
  onModuleDestroy(): void {
    nest.events.push('onModuleDestroy');
  }
}

@Module({ imports: [LifecycleModule], controllers: [SlowController], providers: [DestroyRecorder] })
class SlowModule {}

async function createNestApp(): Promise<{ app: INestApplication; server: Server }> {
  const app = await NestFactory.create(SlowModule, { logger: false, abortOnError: false });
  const server = app.getHttpServer() as Server;
  server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
    res.once('finish', () => nest.events.push('respuesta'));
    res.once('close', () => {
      if (!res.writableFinished) nest.clientGone.resolve();
    });
  });
  return { app, server };
}

async function listenNest(app: INestApplication): Promise<number> {
  await app.listen(0, '127.0.0.1');
  return ((app.getHttpServer() as Server).address() as AddressInfo).port;
}

describe('installGracefulShutdown con Nest', () => {
  beforeEach(() => {
    nest.entered = deferred();
    nest.release = deferred();
    nest.clientGone = deferred();
    nest.events = [];
  });

  it('deja terminar la petición en curso y cierra la app (onModuleDestroy) recién después', async () => {
    const { app, server } = await createNestApp();
    const source = new EventEmitter();
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: app.get(InflightWorkRegistry),
      closeApp: () => app.close(),
      drainTimeoutMs: 5_000,
      logger,
      signalSource: source,
      exit,
    });
    const port = await listenNest(app);

    const slow = get(port, '/lento', keepAliveAgent());
    await nest.entered.promise;
    source.emit('SIGTERM', 'SIGTERM');
    const done = shutdown('SIGTERM');

    // Lo nuevo ya no entra; lo que estaba en curso sigue y la app no cerró nada todavía.
    await expect(outcome(get(port, '/lento', new http.Agent()))).resolves.toBe('ECONNREFUSED');
    expect(nest.events).toEqual([]);

    nest.release.resolve();
    // `Connection: close`: el socket keep-alive del proxy no puede traer otra petición.
    await expect(slow).resolves.toEqual({ status: 200, connection: 'close', body: 'ok' });
    await done;

    expect(nest.events).toEqual(['handler', 'respuesta', 'onModuleDestroy']);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.log).toHaveBeenNthCalledWith(
      1,
      'SIGTERM: no se aceptan conexiones nuevas; en curso: 1 peticiones HTTP, trabajos http-handler=1',
    );
    expect(logger.log).toHaveBeenLastCalledWith('apagado completo');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('contraste: el cierre de Nest que dispara enableShutdownHooks corre onModuleDestroy antes de responder', async () => {
    // Por esto main.ts no llama a `enableShutdownHooks`: su manejador hace exactamente
    // `app.close()`. Si una versión de Nest cambia el orden, este test lo avisa.
    const { app } = await createNestApp();
    const port = await listenNest(app);
    const agent = keepAliveAgent();

    const slow = get(port, '/lento', agent);
    await nest.entered.promise;
    const closing = app.close();
    await vi.waitFor(() => expect(nest.events).toEqual(['onModuleDestroy']));

    nest.release.resolve();
    await expect(slow).resolves.toMatchObject({ status: 200, connection: 'keep-alive' });
    agent.destroy();
    await closing;

    expect(nest.events).toEqual(['onModuleDestroy', 'handler', 'respuesta']);
  });

  it('un cliente que se va (524 de Cloudflare, pestaña cerrada) no adelanta el cierre: se espera al handler', async () => {
    // Node emite `close` en la respuesta cuando se cae el socket, pero Nest no cancela el handler:
    // el Book sigue contra el proveedor y la base. Contar sólo respuestas cerraría el pool debajo
    // de él.
    const { app, server } = await createNestApp();
    const exit = vi.fn();
    const { shutdown } = installGracefulShutdown({
      server,
      work: app.get(InflightWorkRegistry),
      closeApp: () => app.close(),
      drainTimeoutMs: 5_000,
      logger: fakeLogger(),
      signalSource: new EventEmitter(),
      exit,
    });
    const port = await listenNest(app);

    const req = http.get({ host: '127.0.0.1', port, path: '/lento', agent: keepAliveAgent() });
    const aborted = new Promise<void>((resolve) => req.once('error', () => resolve()));
    await nest.entered.promise;
    req.destroy();
    await aborted;
    await nest.clientGone.promise;

    const done = shutdown('SIGTERM');
    await sleep(50);
    expect(nest.events).toEqual([]);

    nest.release.resolve();
    await done;
    expect(nest.events).toEqual(['handler', 'onModuleDestroy']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Casos de borde con un servidor HTTP plano.
// ---------------------------------------------------------------------------------------------

describe('installGracefulShutdown', () => {
  it('escucha SIGTERM y SIGINT; sin nada en curso cierra en el acto y la segunda llamada es la misma', async () => {
    const server = plainServer((_req, res) => res.end());
    const source = new EventEmitter();
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const { shutdown } = installGracefulShutdown({
      server,
      work: new InflightWorkRegistry(),
      closeApp,
      drainTimeoutMs: 5_000,
      logger: fakeLogger(),
      signalSource: source,
      exit,
    });
    await listen(server);

    expect(SHUTDOWN_SIGNALS).toEqual(['SIGTERM', 'SIGINT']);
    expect(source.listenerCount('SIGTERM')).toBe(1);
    expect(source.listenerCount('SIGINT')).toBe(1);

    const first = shutdown('SIGTERM');
    expect(shutdown('SIGINT')).toBe(first);
    await first;

    expect(server.listening).toBe(false);
    expect(closeApp).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('espera la saga registrada que sigue después de responder 202 (Book híbrido)', async () => {
    const registry = new InflightWorkRegistry();
    const saga = deferred();
    const server = plainServer((_req, res) => {
      void registry.track('hotel-book', saga.promise);
      res.statusCode = 202;
      res.end('pending');
    });
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp,
      drainTimeoutMs: 5_000,
      logger,
      signalSource: new EventEmitter(),
      exit,
    });
    const port = await listen(server);

    await expect(get(port, '/hotels/book', keepAliveAgent())).resolves.toMatchObject({
      status: 202,
    });
    const done = shutdown('SIGTERM');
    await sleep(30);

    expect(closeApp).not.toHaveBeenCalled();
    // Sólo tipos y cantidades: nada de la reserva llega al log.
    expect(logger.log).toHaveBeenCalledWith(
      'SIGTERM: no se aceptan conexiones nuevas; en curso: 0 peticiones HTTP, trabajos hotel-book=1',
    );

    saga.resolve();
    await done;
    expect(closeApp).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('también espera el trabajo que registra una petición en curso cuando el registro ya estaba vacío', async () => {
    const registry = new InflightWorkRegistry();
    const entered = deferred();
    const respond = deferred();
    const saga = deferred();
    const server = plainServer((_req, res) => {
      entered.resolve();
      void respond.promise.then(() => {
        void registry.track('hotel-book', saga.promise);
        res.statusCode = 202;
        res.end();
      });
    });
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp,
      drainTimeoutMs: 5_000,
      logger: fakeLogger(),
      signalSource: new EventEmitter(),
      exit,
    });
    const port = await listen(server);

    const reply = get(port, '/hotels/book', keepAliveAgent());
    await entered.promise;
    const done = shutdown('SIGTERM');

    respond.resolve();
    await expect(reply).resolves.toMatchObject({ status: 202, connection: 'close' });
    await sleep(30);
    expect(closeApp).not.toHaveBeenCalled();

    saga.resolve();
    await done;
    expect(closeApp).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('una petición que llega por un socket keep-alive ya abierto durante el drenaje se atiende con Connection: close', async () => {
    const registry = new InflightWorkRegistry();
    const saga = deferred();
    void registry.track('hotel-book', saga.promise);
    const streaming = deferred();
    const finish = deferred();
    const server = plainServer((req, res) => {
      if (req.url === '/stream') {
        // Cabeceras ya enviadas cuando empieza el drenaje: esta respuesta no puede cambiarlas.
        res.writeHead(200);
        res.write('a');
        streaming.resolve();
        void finish.promise.then(() => res.end('b'));
        return;
      }
      res.end('otra');
    });
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp,
      drainTimeoutMs: 5_000,
      logger: fakeLogger(),
      signalSource: new EventEmitter(),
      exit,
    });
    const port = await listen(server);
    const agent = keepAliveAgent({ maxSockets: 1 });

    const first = get(port, '/stream', agent);
    await streaming.promise;
    const done = shutdown('SIGTERM');
    finish.resolve();
    await expect(first).resolves.toEqual({ status: 200, connection: 'keep-alive', body: 'ab' });

    // Mismo socket (maxSockets 1): el servidor ya no escucha, pero el socket seguía abierto.
    await expect(get(port, '/otra', agent)).resolves.toEqual({
      status: 200,
      connection: 'close',
      body: 'otra',
    });

    saga.resolve();
    await done;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('detiene los workers al empezar y cierra la app recién cuando terminaron sus jobs activos', async () => {
    // Nest destruye `DatabaseService` antes que el módulo del worker: si el worker se cerrara en
    // `app.close()`, sus jobs activos terminarían sin pool.
    const registry = new InflightWorkRegistry();
    const jobsDone = deferred();
    const closeWorker = vi.fn(() => jobsDone.promise);
    registry.onShutdown('post-sale-worker', closeWorker);
    const server = plainServer((_req, res) => res.end());
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp,
      drainTimeoutMs: 5_000,
      logger,
      signalSource: new EventEmitter(),
      exit,
    });
    await listen(server);
    expect(closeWorker).not.toHaveBeenCalled();

    const done = shutdown('SIGTERM');
    await vi.waitFor(() => expect(closeWorker).toHaveBeenCalledOnce());
    await sleep(30);
    expect(closeApp).not.toHaveBeenCalled();

    jobsDone.resolve();
    await done;
    expect(closeApp).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('un worker que falla al detenerse se registra y no frena el apagado', async () => {
    const registry = new InflightWorkRegistry();
    registry.onShutdown('post-sale-worker', () =>
      Promise.reject(new Error('Connection is closed.')),
    );
    const server = plainServer((_req, res) => res.end());
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp,
      drainTimeoutMs: 5_000,
      logger,
      signalSource: new EventEmitter(),
      exit,
    });
    await listen(server);

    await shutdown('SIGTERM');

    expect(logger.warn).toHaveBeenCalledWith(
      'post-sale-worker: falló al detenerse (Connection is closed.)',
    );
    expect(closeApp).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('una petición a medio llegar no deja colgado el cierre del servidor de app.close()', async () => {
    const server = plainServer((_req, res) => res.end());
    const exit = vi.fn();
    const { shutdown } = installGracefulShutdown({
      server,
      work: new InflightWorkRegistry(),
      // Como el adaptador de Express de Nest: resuelve con el evento `close` del servidor, que
      // espera a que no quede ninguna conexión.
      closeApp: () => new Promise<void>((resolve) => server.close(() => resolve())),
      drainTimeoutMs: 5_000,
      logger: fakeLogger(),
      signalSource: new EventEmitter(),
      exit,
    });
    const port = await listen(server);
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('POST /hotels/book HTTP/1.1\r\nHost: api\r\n');
    await sleep(30);

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(0);
    socket.destroy();
  });

  it('al vencer el plazo corta lo que queda, cierra la app igual y sale con 1', async () => {
    const registry = new InflightWorkRegistry();
    void registry.track('hotel-book', new Promise<never>(() => undefined));
    const entered = deferred();
    const server = plainServer(() => {
      entered.resolve();
    });
    const closeApp = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp,
      drainTimeoutMs: 50,
      logger,
      signalSource: new EventEmitter(),
      exit,
    });
    const port = await listen(server);

    const reply = outcome(get(port, '/colgada', keepAliveAgent()));
    await entered.promise;
    await shutdown('SIGTERM');

    await expect(reply).resolves.toBe('ECONNRESET');
    expect(logger.warn).toHaveBeenCalledWith(
      'el drenaje superó 50 ms; se corta lo que queda: 1 peticiones HTTP, trabajos hotel-book=1. ' +
        'Un Book cortado queda pending para la recuperación (RF-21).',
    );
    expect(closeApp).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.log).toHaveBeenLastCalledWith('apagado completo con trabajo cortado');
  });

  it('una segunda señal durante el drenaje sale en el acto', async () => {
    const registry = new InflightWorkRegistry();
    const saga = deferred();
    void registry.track('hotel-book', saga.promise);
    const server = plainServer((_req, res) => res.end());
    const source = new EventEmitter();
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: registry,
      closeApp: () => Promise.resolve(),
      drainTimeoutMs: 5_000,
      logger,
      signalSource: source,
      exit,
    });
    await listen(server);

    source.emit('SIGINT', 'SIGINT');
    expect(exit).not.toHaveBeenCalled();
    source.emit('SIGINT', 'SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'segunda señal SIGINT durante el apagado: salida inmediata',
    );

    saga.resolve();
    await shutdown('SIGINT');
  });

  it('si el cierre de la app falla, lo registra y sale con 1', async () => {
    const server = plainServer((_req, res) => res.end());
    const exit = vi.fn();
    const logger = fakeLogger();
    const { shutdown } = installGracefulShutdown({
      server,
      work: new InflightWorkRegistry(),
      closeApp: () => Promise.reject(new Error('pool ya cerrado')),
      drainTimeoutMs: 5_000,
      logger,
      signalSource: new EventEmitter(),
      exit,
    });
    await listen(server);

    await shutdown('SIGTERM');

    expect(logger.error).toHaveBeenCalledWith(
      'falló el apagado: pool ya cerrado',
      expect.any(String),
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
