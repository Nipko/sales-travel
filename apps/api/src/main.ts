import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  // Detrás de Caddy + Cloudflare: confiar en el proxy para que req.ip refleje X-Forwarded-For
  // (fallback del rate limiter; la IP real del cliente la tomamos de CF-Connecting-IP).
  const express = app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void };
  express.set('trust proxy', true);

  app.use(helmet());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api');

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(`API escuchando en :${port}`);
}

void bootstrap();
