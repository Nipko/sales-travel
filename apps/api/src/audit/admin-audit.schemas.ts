import { z } from '@sales-travel/validation';
import {
  addDays,
  CalendarDate,
  periodDays,
  PLATFORM_TIME_ZONE,
  todayIn,
  Uuid,
  type OverviewPeriod,
} from '../admin-console/admin-overview.schemas.js';
import { AuditPeriodInvalidError } from './admin-audit.errors.js';
import { PLATFORM_AUDIT_CATEGORIES } from './audit-categories.js';
import { decodeAuditCursor, type AuditCursor } from './audit.schemas.js';

/**
 * El borde de Plataforma → Actividad (`GET /admin/audit` y `GET /admin/audit/export`): qué se filtra
 * y cómo se pagina. Sin I/O.
 *
 * Los días son días calendario de Bogotá (PLATFORM_TIME_ZONE, como el resto de la consola): los
 * convierte a instantes Postgres, que conoce los cambios de hora de cada zona.
 */

/** Sin fechas, los últimos 7 días contando hoy. */
export const AUDIT_DEFAULT_DAYS = 7;
/**
 * Un trimestre. Más largo, la lectura recorre demasiado del audit log para una pantalla; para mirar
 * más atrás se mira por partes. admin_audit_events (0078) lo vuelve a exigir, con un día de margen.
 */
export const AUDIT_MAX_DAYS = 92;

export const ADMIN_AUDIT_PAGE = 50;
export const ADMIN_AUDIT_MAX_PAGE = 200;
/** Lo más que exporta un CSV: la función devuelve uno más para saber si se cortó. */
export const ADMIN_AUDIT_EXPORT_MAX_ROWS = 5000;

const EVENT_TYPE = /^[A-Za-z0-9_.]{2,80}$/;
const AGGREGATE_TYPE = /^[a-z_]{2,40}$/;
export const AUDIT_AGGREGATE_ID_MAX = 100;

const INVALID_CURSOR = 'el cursor no es válido: vuelve a cargar la actividad desde el principio';

/** Los filtros que comparten la lista y la exportación. */
const filterFields = {
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  category: z
    .enum(PLATFORM_AUDIT_CATEGORIES, {
      errorMap: () => ({
        message: `categoría inválida: usa ${PLATFORM_AUDIT_CATEGORIES.join(', ')}`,
      }),
    })
    .optional(),
  /** Un tipo exacto (`auth.login.failed`, `OrderCreated`). */
  eventType: z
    .string()
    .regex(EVENT_TYPE, { message: 'el tipo de evento es un código como auth.login.failed' })
    .optional(),
  /** Quién lo hizo, por su correo exacto (sin distinguir mayúsculas). */
  actorEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, { message: 'el correo es demasiado largo' })
    .email({ message: 'escribe el correo completo de quien actuó' })
    .optional(),
  /** El nodo y todo lo que cuelga de él. Sin él, toda la plataforma. */
  tenantId: Uuid.optional(),
  /**
   * Además los eventos sin nodo (un ingreso fallido, el modo de la retención en cascada). Sin valor:
   * sí cuando se mira toda la plataforma, no cuando se mira un nodo.
   */
  includePlatform: z
    .enum(['true', 'false'], { errorMap: () => ({ message: 'includePlatform es true o false' }) })
    .transform((v) => v === 'true')
    .optional(),
  /** La entidad: `order`, `user`, `tenant`… */
  aggregateType: z
    .string()
    .regex(AGGREGATE_TYPE, { message: 'la entidad es un código como order o user' })
    .optional(),
  /** Su id, exacto. */
  aggregateId: z
    .string()
    .trim()
    .min(1, { message: 'escribe el id de la entidad' })
    .max(AUDIT_AGGREGATE_ID_MAX, {
      message: `el id de la entidad puede tener hasta ${AUDIT_AGGREGATE_ID_MAX} caracteres`,
    })
    // Sin caracteres de control: un NUL llega a Postgres como 22021 y sería un 500, no un 400.
    .refine((v) => !/\p{Cc}/u.test(v), {
      message: 'el id de la entidad tiene caracteres no válidos',
    })
    .optional(),
};

/** El período, si vienen los dos extremos: al derecho y de hasta {@link AUDIT_MAX_DAYS} días. */
function checkPeriod(query: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (query.from === undefined || query.to === undefined) return;
  if (query.from > query.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'la fecha "hasta" no puede ser anterior a "desde"',
    });
    return;
  }
  if (periodDays({ from: query.from, to: query.to }) > AUDIT_MAX_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['from'],
      message: `el período puede tener hasta ${AUDIT_MAX_DAYS} días`,
    });
  }
}

/**
 * `GET /admin/audit`. Estricto: el BFF reconstruye la query parámetro por parámetro, así que un campo
 * de más es un error de programación y no un filtro que se ignora en silencio.
 *
 * - `from` y `to`: días de Bogotá, ambos incluidos; sin ellos, los últimos {@link AUDIT_DEFAULT_DAYS}
 *   días; hasta {@link AUDIT_MAX_DAYS}.
 * - `category`, `eventType`, `actorEmail`, `tenantId`, `includePlatform`, `aggregateType`,
 *   `aggregateId`: ver arriba.
 * - `cursor` y `limit`: la página.
 */
export const AdminAuditQuerySchema = z
  .object({
    ...filterFields,
    cursor: z
      .string()
      .max(200, { message: INVALID_CURSOR })
      .transform((raw, ctx): AuditCursor => {
        const cursor = decodeAuditCursor(raw);
        if (cursor === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: INVALID_CURSOR });
          return z.NEVER;
        }
        return cursor;
      })
      .optional(),
    limit: z.coerce
      .number({ invalid_type_error: `un número entero entre 1 y ${ADMIN_AUDIT_MAX_PAGE}` })
      .int(`un número entero entre 1 y ${ADMIN_AUDIT_MAX_PAGE}`)
      .min(1, `entre 1 y ${ADMIN_AUDIT_MAX_PAGE}`)
      .max(ADMIN_AUDIT_MAX_PAGE, `entre 1 y ${ADMIN_AUDIT_MAX_PAGE}`)
      .default(ADMIN_AUDIT_PAGE),
  })
  .strict()
  .superRefine(checkPeriod);
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;

/**
 * `GET /admin/audit/export`: los mismos filtros, sin página. Exporta hasta
 * {@link ADMIN_AUDIT_EXPORT_MAX_ROWS} eventos, los más nuevos.
 */
export const AdminAuditExportQuerySchema = z.object(filterFields).strict().superRefine(checkPeriod);
export type AdminAuditExportQuery = z.infer<typeof AdminAuditExportQuerySchema>;

/** Los filtros, sin la página. */
export type AdminAuditFilters = AdminAuditExportQuery;

/**
 * El período que se lee: el que pidieron, completado. Sin `to`, hasta hoy; sin `from`, los
 * {@link AUDIT_DEFAULT_DAYS} días que terminan en `to`. Al revés o de más de
 * {@link AUDIT_MAX_DAYS} días, 400.
 */
export function resolveAuditPeriod(
  query: Pick<AdminAuditFilters, 'from' | 'to'>,
  now: Date,
): OverviewPeriod {
  const to = query.to ?? todayIn(PLATFORM_TIME_ZONE, now);
  const from = query.from ?? addDays(to, -(AUDIT_DEFAULT_DAYS - 1));
  if (from > to) {
    throw new AuditPeriodInvalidError(
      'El período empieza después de terminar: revisa las fechas "desde" y "hasta".',
    );
  }
  if (periodDays({ from, to }) > AUDIT_MAX_DAYS) {
    throw new AuditPeriodInvalidError(
      `El período puede tener hasta ${AUDIT_MAX_DAYS} días: acórtalo o míralo por partes.`,
    );
  }
  return { from, to };
}

/** El nombre del archivo exportado: `actividad-2026-10-07-a-2026-10-13.csv`. */
export function auditExportFilename(period: OverviewPeriod): string {
  return `actividad-${period.from}-a-${period.to}.csv`;
}
