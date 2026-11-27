import 'reflect-metadata';
import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { installGracefulShutdown } from './lifecycle/graceful-shutdown.js';
import { InflightWorkRegistry } from './lifecycle/inflight-work.registry.js';
import { loadShutdownConfig } from './lifecycle/shutdown.config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  // Detrás de Caddy: req.ip sale de X-Forwarded-For, que Caddy escribe con la IP del usuario que
  // resolvió (`{client_ip}`). Es sólo el respaldo: la IP de sesiones, auditoría y rate limiting se
  // lee en request-context/client-origin.ts.
  const express = app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void };
  express.set('trust proxy', true);

  // 1 MB: entra un logo de 512 KB en base64 (≈700 KB) y sigue cortando cuerpos abusivos con 413.
  // El valor por defecto de Express (100 KB) rechazaba logos de más de ~75 KB (QA-H-35).
  app.useBodyParser('json', { limit: '1mb' });

  // La API sólo devuelve JSON (y los blobs de marca): nada de ella se embebe ni ejecuta en un
  // navegador, así que la política es la más cerrada. Los valores por defecto de helmet dejaban
  // X-Frame-Options SAMEORIGIN, Referrer-Policy no-referrer y HSTS sin preload (QA-H-02).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Las respuestas llevan datos de la agencia y de sus clientes: ningún proxy ni el navegador las
  // guarda. Una ruta que quiera cache lo declara ella misma (pisa este valor).
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
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
