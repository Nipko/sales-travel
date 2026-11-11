import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import { RedisConnection, type RedisClient } from 'bullmq';
import { redisConnection } from '../queue/redis-connection.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';

/** Token de inyección: el servicio pide un `CachePort`; los tests le pasan la de memoria. */
export const SEARCH_CACHE = 'SEARCH_CACHE';

/** Todas las claves de esta caché van con prefijo: Redis lo comparte la cola de BullMQ. */
const PREFIX = 'st:cache:';

/**
 * Lo más que se espera a Redis. Una caché lenta no puede volver lenta la búsqueda: pasado esto se
 * sigue como si no hubiera caché (se consulta al proveedor) y se registra.
 */
const REDIS_TIMEOUT_MS = 400;

class RedisTimeout extends Error {
  override readonly name = 'RedisTimeout';
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisTimeout()), REDIS_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('redis'));
      },
    );
  });
}

/**
 * Caché de búsquedas en Redis, detrás de `CachePort` (docs/platform/18).
 *
 * La de memoria se perdía en cada deploy y no la compartirían dos réplicas. Redis ya está
 * aprovisionado (BullMQ) y se usa su cliente, sin otra dependencia. Si Redis no está configurado o
 * no responde, cae a la memoria del proceso: la caché es un ahorro, nunca un punto de falla.
 *
 * Los valores van como JSON: son respuestas de búsqueda (ofertas canónicas), sin datos del pasajero.
 */
@Injectable()
export class SearchCacheAdapter implements CachePort, OnModuleDestroy {
  private readonly logger = new Logger(SearchCacheAdapter.name);
  private readonly memory = new MemoryCacheAdapter();
  private readonly connection: RedisConnection | null;
  private warned = false;

  constructor() {
    const options = redisConnection();
    this.connection =
      options === null
        ? null
        : // Fuera de la cola: un comando que no sale no se reintenta ni se encola mientras Redis
          // está caído, falla y se sigue sin caché.
          new RedisConnection(
            {
              ...(options as Record<string, unknown>),
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
            },
            { shared: false, blocking: false, skipVersionCheck: true },
          );
  }

  private async client(): Promise<RedisClient | null> {
    if (this.connection === null) return null;
    try {
      return await withTimeout(this.connection.client);
    } catch (err) {
      this.warnOnce(err);
      return null;
    }
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    // Sólo la clase del error: el mensaje de ioredis puede traer host y puerto.
    this.logger.warn(
      `search.cache.redis_no_disponible error=${err instanceof Error ? err.name : 'unknown'} — se sigue con memoria`,
    );
  }

  async get<T>(key: string): Promise<T | null> {
    const redis = await this.client();
    if (redis === null) return this.memory.get<T>(key);
    try {
      const raw = await withTimeout(redis.get(PREFIX + key));
      this.warned = false;
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      this.warnOnce(err);
      return this.memory.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = 60): Promise<void> {
    const redis = await this.client();
    if (redis === null) return this.memory.set(key, value, ttlSeconds);
    try {
      await withTimeout(redis.set(PREFIX + key, JSON.stringify(value), { EX: ttlSeconds }));
    } catch (err) {
      this.warnOnce(err);
      await this.memory.set(key, value, ttlSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    await this.memory.delete(key);
    const redis = await this.client();
    if (redis === null) return;
    try {
      await withTimeout(redis.del(PREFIX + key));
    } catch (err) {
      this.warnOnce(err);
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    await this.memory.invalidatePattern(pattern);
    const redis = await this.client();
    if (redis === null) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await withTimeout(
          redis.scan(cursor, { MATCH: PREFIX + pattern, COUNT: 200 }),
        );
        if (keys.length > 0) await withTimeout(redis.del(...keys));
        cursor = next;
      } while (cursor !== '0');
    } catch (err) {
      this.warnOnce(err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close().catch(() => undefined);
  }
}
