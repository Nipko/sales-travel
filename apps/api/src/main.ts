import 'reflect-metadata';
import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { installGracefulShutdown } from './lifecycle/graceful-shutdown.js';
import { InflightWorkRegistry } from './lifecycle/inflight-work.registry.js';
import { loadShutdownConfig } from './lifecycle/shutdown.config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  // Detrás de Caddy: req.ip sale de X-Forwarded-For, que Caddy escribe con la IP del usuario que
  // resolvió (`{client_ip}`). Es sólo el respaldo: la IP de sesiones, auditoría y rate limiting se
  // lee en request-context/client-origin.ts.
  const express = app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void };
  express.set('trust proxy', true);

  app.use(helmet());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api');

  // Sin `app.enableShutdownHooks()` a propósito: en Nest 10 cierra el pool de Postgres antes que el
  // servidor HTTP y cortaría el Book en vuelo que el apagado ordenado quiere dejar terminar. Ver
  // `lifecycle/graceful-shutdown.ts`. Se instala antes de `listen` para contar la primera petición.
  const shutdownLogger = new Logger('Shutdown');
  const shutdownConfig = loadShutdownConfig(process.env);
  if (shutdownConfig.invalidReason !== undefined) shutdownLogger.warn(shutdownConfig.invalidReason);
  installGracefulShutdown({
    server: app.getHttpServer() as Server,
    work: app.get(InflightWorkRegistry),
    closeApp: () => app.close(),
    drainTimeoutMs: shutdownConfig.drainTimeoutMs,
    logger: shutdownLogger,
  });

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(`API escuchando en :${port}`);
}

void bootstrap();
