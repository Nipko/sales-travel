import type { TboHttpDeps } from '@sales-travel/tbo-hotels';
import type { SyncLogLevel } from './env.js';

/**
 * Logger JSON de una línea por evento (05 §6.6). Lo usan el sync y el cliente del ACL, así que
 * cumple el `LoggerPort` de `packages/core` sin importarlo: el tipo sale de las dependencias del
 * propio cliente.
 *
 * El cliente HTTP ya loguea con lista blanca (nunca cabeceras ni cuerpos) y el sync sólo emite
 * contadores y códigos. La redacción de abajo es la red por si alguien, algún día, pasa un objeto
 * de más: una clave con forma de credencial nunca sale con su valor (08 RF-30 CA 4).
 */
export type SyncLogger = NonNullable<TboHttpDeps['logger']>;

export type LogSink = (line: string) => void;

const LEVEL_RANK: Readonly<Record<SyncLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** `Authorization`, `password`, `username`, `secret`, `token`, API keys, en cualquier casing. */
const SENSITIVE_KEY = /authori[sz]ation|passw(?:or)?d|^user(?:name)?$|secret|^token$|api_?key/i;

export const REDACTED = '[redacted]';

function redact(value: unknown, depth: number): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(child, depth + 1);
  }
  return out;
}

export interface JsonLoggerOptions {
  readonly level: SyncLogLevel;
  readonly sink: LogSink;
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly clock?: () => Date;
}

export class JsonLogger implements SyncLogger {
  readonly #options: JsonLoggerOptions;

  constructor(options: JsonLoggerOptions) {
    this.#options = options;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.#write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.#write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.#write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.#write('error', message, meta);
  }

  child(bindings: Record<string, unknown>): JsonLogger {
    return new JsonLogger({
      ...this.#options,
      bindings: { ...this.#options.bindings, ...bindings },
    });
  }

  #write(level: SyncLogLevel, message: string, meta: Record<string, unknown> | undefined): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#options.level]) return;
    const time = (this.#options.clock ?? (() => new Date()))().toISOString();
    const record = redact({ ...this.#options.bindings, ...meta }, 0) as Record<string, unknown>;
    let line: string;
    try {
      line = JSON.stringify({ time, level, msg: message, ...record });
    } catch {
      // Un ciclo o un `toJSON` que lanza no tumban la corrida: se pierde el detalle, no el evento.
      line = JSON.stringify({ time, level, msg: message, logError: 'unserializable_meta' });
    }
    try {
      this.#options.sink(line);
    } catch {
      // Un stdout cerrado no puede cambiar el desenlace de la corrida.
    }
  }
}

export const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};
