import type { ConnectionOptions } from 'bullmq';

/**
 * Opciones de conexión a Redis para BullMQ desde el entorno. Devuelve null si no hay `REDIS_HOST`
 * → la cola/worker quedan deshabilitados (degradación elegante: el sistema sigue con reintento manual).
 * `maxRetriesPerRequest: null` es requerido por BullMQ para el Worker (bloqueos largos).
 */
export function redisConnection(): ConnectionOptions | null {
  const host = process.env['REDIS_HOST'];
  if (!host) return null;
  return {
    host,
    port: Number(process.env['REDIS_PORT'] ?? 6379),
    password: process.env['REDIS_PASSWORD'] || undefined,
    maxRetriesPerRequest: null,
  };
}
