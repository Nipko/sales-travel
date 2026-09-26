import { z } from 'zod';

/**
 * Por defecto, 125 s: el `Book` de TBO puede tardar 120 s (docs/tbo/03 §4.5) y el contenedor
 * `api` tiene `stop_grace_period: 130s` (infrastructure/hostinger/docker-compose.prod.yml). Los 5 s
 * que sobran son para `app.close()` —pool de Postgres, cola y worker de BullMQ— antes del SIGKILL.
 * Si se sube uno de los dos números, se sube el otro.
 */
export const SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS = 125_000;

/**
 * Tope: el `requestTimeout` por defecto del servidor HTTP de Node es de 300 s, así que ninguna
 * petición vive más que eso y esperar más sólo retrasaría el despliegue.
 */
export const SHUTDOWN_MAX_DRAIN_TIMEOUT_MS = 300_000;

const DrainTimeoutSchema = z
  .string()
  .regex(/^\d{1,7}$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(SHUTDOWN_MAX_DRAIN_TIMEOUT_MS));

export interface ShutdownConfig {
  readonly drainTimeoutMs: number;
  /** Por qué se ignoró el valor del entorno. Nombra la variable, nunca repite el valor. */
  readonly invalidReason?: string;
}

/**
 * Un valor mal escrito cae al de por defecto con aviso en lugar de tumbar el arranque: es una
 * perilla del apagado y no puede dejar sin API a la red.
 */
export function loadShutdownConfig(
  env: Readonly<Record<string, string | undefined>>,
): ShutdownConfig {
  const raw = env['SHUTDOWN_DRAIN_TIMEOUT_MS']?.trim();
  // `${VAR:-}` del compose llega como cadena vacía: vacío es "no configurado", no un error.
  if (raw === undefined || raw.length === 0) {
    return { drainTimeoutMs: SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS };
  }
  const parsed = DrainTimeoutSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      drainTimeoutMs: SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS,
      invalidReason: `SHUTDOWN_DRAIN_TIMEOUT_MS debe ser un entero de milisegundos entre 0 y ${SHUTDOWN_MAX_DRAIN_TIMEOUT_MS}; se usa ${SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS}`,
    };
  }
  return { drainTimeoutMs: parsed.data };
}
