import { BadRequestException } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { IsoCurrencySchema } from './portfolios.schemas.js';

/**
 * El borde de la cola de depósitos informados de toda la red (Plataforma → Aprobaciones): qué se
 * filtra y cómo se pagina. Sin I/O.
 */

export const DEPOSIT_REPORT_QUEUE_PAGE = 50;
export const DEPOSIT_REPORT_QUEUE_MAX_PAGE = 100;

/**
 * Hasta dónde se pagina: el instante de la fila (`reported_at` en los pendientes, `resolved_at` en
 * los resueltos) en UTC con microsegundos, y su id para desempatar. Postgres guarda microsegundos y
 * `Date` sólo milisegundos: con un `Date` dos informes del mismo milisegundo se saltearían o se
 * repetirían entre páginas.
 */
export interface QueueCursor {
  readonly at: string;
  readonly id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

/** El cursor que armó {@link encodeQueueCursor}, o `undefined` si no lo es. */
export function decodeQueueCursor(raw: string): QueueCursor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [at, id] = value as unknown[];
  if (typeof at !== 'string' || !CURSOR_AT.test(at)) return undefined;
  if (typeof id !== 'string' || !CURSOR_ID.test(id)) return undefined;
  return { at, id };
}

const INVALID_CURSOR = 'el cursor no es válido: vuelve a cargar la lista desde el principio';

/** Un cursor que no armó esta API (o de otra versión). 400. */
export class InvalidQueueCursorError extends BadRequestException {
  readonly reason = 'DEPOSIT_REPORT_QUEUE_CURSOR_INVALID';

  constructor() {
    super('El cursor no es válido: vuelve a cargar la lista desde el principio.');
    this.name = 'InvalidQueueCursorError';
  }
}

const Uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/**
 * `GET /admin/deposit-reports`. Estricto: el BFF reconstruye la query parámetro por parámetro, así
 * que un campo de más es un error de programación y no un filtro que se ignora en silencio.
 *
 * - `status`: pendientes por defecto (la cola); aprobados o rechazados, el historial.
 * - `financedBy`: `platform` lo que financia Planetour (el dinero llegó a su cuenta); `network` lo que
 *   financia un consolidador o una agencia de la red. Sin él, todo.
 * - `tenantId`: el subárbol de ese nodo.
 * - `q`: la referencia del depósito, o el nombre o el slug del nodo.
 */
export const DepositReportQueueQuerySchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
    financedBy: z.enum(['platform', 'network']).optional(),
    currency: IsoCurrencySchema.optional(),
    tenantId: Uuid.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    cursor: z
      .string()
      .max(200)
      .refine((raw) => decodeQueueCursor(raw) !== undefined, { message: INVALID_CURSOR })
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(DEPOSIT_REPORT_QUEUE_MAX_PAGE)
      .default(DEPOSIT_REPORT_QUEUE_PAGE),
  })
  .strict();
export type DepositReportQueueQuery = z.infer<typeof DepositReportQueueQuerySchema>;
