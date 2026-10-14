import { z } from '@sales-travel/validation';
import { realInstant } from '../tenants/dto.js';

/**
 * Los bordes de lectura del audit log: la Actividad de la red (`GET /tenants/network/audit`) y el
 * historial de una persona (`GET /tenants/:id/members/:userId/audit`, `GET /admin/users/:userId/
 * audit`). Parámetros de más son 400.
 *
 * Sin transformaciones que cambien el tipo (el cursor sigue en texto): ZodValidationPipe exige que
 * la entrada y la salida del esquema coincidan. Los valores por defecto los pone el servicio.
 */

/**
 * Los filtros de la Actividad de la red. Qué eventos entran en cada uno lo decide
 * AuditService (por el prefijo de `event_type`); la web lo espeja en lib/audit-format.
 */
export const AUDIT_CATEGORIES = ['users', 'credentials', 'pricing', 'network'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Eventos por página de la Actividad de la red si no se pide otro tamaño, y el tope. */
export const NETWORK_AUDIT_PAGE_SIZE = 50;
export const NETWORK_AUDIT_MAX_PAGE = 200;
/** Lo mismo para el historial de una persona (la función de 0065 corta en 100 + 1). */
export const USER_AUDIT_PAGE_SIZE = 30;
export const USER_AUDIT_MAX_PAGE = 100;

/**
 * Dónde sigue una página: el último evento de la anterior, en el orden (occurred_at, id). Con el
 * instante solo no alcanza: los eventos de una misma transacción comparten `now()` y un corte por
 * tiempo saltaba (o repetía) los del borde.
 */
export interface AuditCursor {
  /** ISO 8601 en UTC con microsegundos, como lo guarda Postgres: con milisegundos saltaba filas. */
  readonly occurredAt: string;
  readonly id: string;
}

const CURSOR_ID = z.string().uuid();

/** El cursor opaco que viaja en `nextBefore`: base64url del JSON `{ occurredAt, id }`. */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify({ occurredAt: cursor.occurredAt, id: cursor.id })).toString(
    'base64url',
  );
}

/** El cursor leído, o `undefined` si no es uno que haya emitido el historial. */
export function decodeAuditCursor(raw: string): AuditCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { occurredAt, id } = parsed as Record<string, unknown>;
  if (typeof occurredAt !== 'string' || !realInstant(occurredAt)) return undefined;
  const uuid = CURSOR_ID.safeParse(id);
  return uuid.success ? { occurredAt, id: uuid.data.toLowerCase() } : undefined;
}

/**
 * Un entero en rango. La URL lo trae como texto ("50"): se acepta si son sólo dígitos; "5.5", "50
 * eventos" o "" no.
 */
function pageSize(max: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
    z
      .number({ invalid_type_error: `un número entero entre 1 y ${max}` })
      .int(`un número entero entre 1 y ${max}`)
      .min(1, `entre 1 y ${max}`)
      .max(max, `entre 1 y ${max}`),
  );
}

/** El `nextBefore` de la página anterior. Lo lee el servicio (decodeAuditCursor). */
const BeforeSchema = z
  .string()
  .refine((raw) => decodeAuditCursor(raw) !== undefined, 'cursor inválido');

const LowerUuidSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/** `GET /tenants/network/audit`: la Actividad de la red bajo `tenantId`, con filtros opcionales. */
export const NetworkAuditQuerySchema = z
  .object({
    tenantId: LowerUuidSchema,
    /** Sin valor, {@link NETWORK_AUDIT_PAGE_SIZE}. */
    limit: pageSize(NETWORK_AUDIT_MAX_PAGE).optional(),
    before: BeforeSchema.optional(),
    category: z
      .enum(AUDIT_CATEGORIES, {
        errorMap: () => ({ message: `categoría inválida: usa ${AUDIT_CATEGORIES.join(', ')}` }),
      })
      .optional(),
    /** Sólo lo que hizo esta persona. */
    actorUserId: LowerUuidSchema.optional(),
  })
  .strict();
export type NetworkAuditQuery = z.infer<typeof NetworkAuditQuerySchema>;

/** El historial de una persona, desde Equipo o desde Plataforma → Usuarios. */
export const UserAuditQuerySchema = z
  .object({
    before: BeforeSchema.optional(),
    /** Sin valor, {@link USER_AUDIT_PAGE_SIZE}. */
    limit: pageSize(USER_AUDIT_MAX_PAGE).optional(),
  })
  .strict();
export type UserAuditQuery = z.infer<typeof UserAuditQuerySchema>;
