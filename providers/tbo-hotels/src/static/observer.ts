import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS, type TboOperationName } from '../http/operations';
import { MAX_ISSUE_REFS } from '../internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import type { TboStaticDiagnostics, TboStaticNote, TboStaticRejection } from './content.types';

/**
 * Lo que los mappers de contenido estático cuentan mientras leen (docs/tbo/05 §6.6; 08 §9 C-12):
 * elementos recibidos, descartes con su motivo, normalizaciones y NOMBRES de claves desconocidas.
 * Nunca valores: un nombre de hotel o una dirección no son datos personales, pero el log es una
 * lista blanca y no hay por qué abrirla (01 §11.1).
 *
 * La observabilidad nunca cambia el resultado: un logger o unas métricas que lanzan no le quitan
 * hoteles al catálogo.
 */

/** Las cinco operaciones de contenido estático. Las demás no tienen nada que hacer aquí. */
export type TboStaticOperation = Extract<
  TboOperationName,
  'countryList' | 'cityList' | 'tboHotelCodeList' | 'hotelDetails' | 'hotelCodeList'
>;

export interface TboStaticMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class TboStaticObserver {
  received = 0;
  mapped = 0;
  readonly #rejected: Partial<Record<TboStaticRejection, number>> = {};
  readonly #notes: Partial<Record<TboStaticNote, number>> = {};
  readonly #unknownKeys = new Set<string>();
  readonly #issues: string[] = [];
  readonly #op: TboStaticOperation;
  readonly #deps: TboStaticMapDeps;

  constructor(op: TboStaticOperation, deps: TboStaticMapDeps) {
    this.#op = op;
    this.#deps = deps;
  }

  get path(): string {
    return TBO_OPERATIONS[this.#op].path;
  }

  reject(reason: TboStaticRejection, issues: readonly string[]): void {
    this.#rejected[reason] = (this.#rejected[reason] ?? 0) + 1;
    for (const issue of issues) this.#issue(`${reason} ${issue}`);
  }

  note(note: TboStaticNote, issue?: string): void {
    this.#notes[note] = (this.#notes[note] ?? 0) + 1;
    if (issue !== undefined) this.#issue(`${note} ${issue}`);
  }

  /** Nombres de claves de `value` que no están en `known` (minúsculas), con la ruta del nivel. */
  collectUnknownKeys(value: unknown, known: readonly string[], prefix: string): void {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (known.includes(key.toLowerCase()) || this.#unknownKeys.size >= MAX_UNKNOWN_KEYS) continue;
      this.#unknownKeys.add(`${prefix}${key}`.slice(0, UNKNOWN_KEY_MAX));
    }
  }

  /**
   * Un contenedor declarado Object (05 §3, CE-01) como lista: array tal cual, objeto único como
   * lista de uno, ausente como lista vacía. El esquema del sobre ya rechazó cualquier otra forma.
   */
  container(
    value: readonly unknown[] | Readonly<Record<string, unknown>> | null | undefined,
    name: string,
  ): readonly unknown[] {
    if (value === undefined || value === null) {
      this.note('CONTAINER_MISSING', `${name}:missing`);
      return [];
    }
    if (Array.isArray(value)) return value as readonly unknown[];
    this.note('CONTAINER_SINGLE_OBJECT', `${name}:single_object`);
    return [value];
  }

  /**
   * Si llega aquí un `Status.Code` distinto de 200 es un error de cableado: el cliente HTTP sólo
   * entrega éxitos, y un 201 en una operación estática ya es un `TboApiError`.
   */
  assertSuccess(status: { readonly Code: number } | undefined): void {
    if (status !== undefined && status.Code !== 200) {
      throw new TboResponseMappingError(this.path, ['Status.Code:not_a_success_code']);
    }
  }

  finish(): TboStaticDiagnostics {
    const op = this.#op;
    const unknownKeys = [...this.#unknownKeys];
    this.#safely(() => {
      for (const key of unknownKeys) {
        this.#deps.metrics?.counter('tbo.contract.unknown_key', 1, { op, key });
      }
      for (const [reason, count] of Object.entries(this.#rejected)) {
        this.#deps.metrics?.counter('tbo.static.item_rejected', count, { op, reason });
      }
      for (const [note, count] of Object.entries(this.#notes)) {
        this.#deps.metrics?.counter('tbo.static.normalized', count, { op, note });
      }
    });
    if (unknownKeys.length > 0) this.#log('warn', 'tbo.static.unknown_keys', { unknownKeys });
    if (this.#issues.length > 0) {
      this.#log('warn', 'tbo.static.anomalies', { issues: this.#issues });
    }
    this.#log('debug', 'tbo.static.mapped', {
      itemsReceived: this.received,
      itemsMapped: this.mapped,
    });
    return {
      received: this.received,
      mapped: this.mapped,
      rejected: { ...this.#rejected },
      notes: { ...this.#notes },
      unknownKeys,
    };
  }

  #issue(issue: string): void {
    if (this.#issues.length < MAX_ISSUE_REFS) this.#issues.push(issue);
  }

  #log(level: 'debug' | 'warn', message: string, meta: Record<string, unknown>): void {
    const logger = this.#deps.logger;
    if (logger === undefined) return;
    this.#safely(() =>
      logger[level](
        message,
        pickTboLogMeta({ provider: TBO_HOTELS_PROVIDER_CODE, op: this.#op, ...meta }),
      ),
    );
  }

  #safely(run: () => void): void {
    try {
      run();
    } catch {
      // Se descarta a propósito: no hay a dónde reportar un fallo del propio canal de reporte.
    }
  }
}
