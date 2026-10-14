import { z } from '@sales-travel/validation';
import { CalendarDate, Uuid } from '../admin-console/admin-overview.schemas.js';
import type { OrderStatus } from '../database/database.types.js';

/**
 * El borde de Plataforma → Reservas de la red (`GET /admin/orders`): qué se filtra y cómo se pagina.
 * Sin I/O.
 *
 * Los días son días calendario de Bogotá (PLATFORM_TIME_ZONE, como el Resumen): los convierte a
 * instantes Postgres, que conoce los cambios de hora de cada zona.
 */

export const ADMIN_ORDERS_PAGE = 50;
export const ADMIN_ORDERS_MAX_PAGE = 100;
/**
 * El texto más largo que se busca. Lo escribe una persona en la consola: el mensaje de 400 sale en
 * castellano, como los de los demás campos que se tipean.
 */
export const ADMIN_ORDERS_MAX_QUERY = 100;

export const ADMIN_ORDER_VERTICALS = ['flights', 'hotels', 'cars'] as const;
export type AdminOrderVertical = (typeof ADMIN_ORDER_VERTICALS)[number];

/** Todos los valores de OrderStatus (admin-orders.schemas.test.ts lo exige en el tipo). */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'ticketed',
  'cancelled',
  'failed',
] as const satisfies readonly OrderStatus[];

/**
 * Hasta dónde se pagina: `created_at` de la última fila en UTC con microsegundos, y su id para
 * desempatar. Postgres guarda microsegundos y `Date` sólo milisegundos: con un `Date` dos reservas
 * del mismo milisegundo se saltarían o se repetirían entre páginas.
 */
export interface AdminOrdersCursor {
  readonly at: string;
  readonly id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeAdminOrdersCursor(cursor: AdminOrdersCursor): string {
  return Buffer.from(JSON.stringify({ at: cursor.at, id: cursor.id }), 'utf8').toString(
    'base64url',
  );
}

/** El cursor que armó {@link encodeAdminOrdersCursor}, o `undefined` si no lo es. */
export function decodeAdminOrdersCursor(raw: string): AdminOrdersCursor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { at, id } = value as { at?: unknown; id?: unknown };
  if (typeof at !== 'string' || !CURSOR_AT.test(at)) return undefined;
  if (typeof id !== 'string' || !UUID.test(id)) return undefined;
  return { at, id };
}

/** `pending,confirmed` → `['pending', 'confirmed']`, sin repetir. Un estado que no existe, 400. */
const StatusList = z
  .string()
  .max(100)
  .transform((raw) => raw.split(',').map((s) => s.trim()))
  .pipe(
    z
      .array(
        z.enum(ORDER_STATUSES, {
          errorMap: () => ({
            message: `cada estado es uno de ${ORDER_STATUSES.join(', ')}, separados por comas`,
          }),
        }),
      )
      .min(1),
  )
  .transform((statuses) => [...new Set(statuses)]);

const INVALID_CURSOR = 'el cursor no es válido: vuelve a cargar la lista desde el principio';

/**
 * Los filtros que comparten la lista y la exportación:
 *
 * - `tenantId` y `subtree`: el nodo y, por defecto, su red; `subtree=false`, sólo ese nodo. Sin
 *   `tenantId`, toda la red (y `subtree` no cambia nada).
 * - `vertical`, `provider`, `status` (lista separada por comas).
 * - `from` y `to`: días de creación, ambos incluidos.
 * - `q`: PNR o localizador, nuestra referencia de reserva, el número de orden, el correo EXACTO del
 *   cliente o el id. Ver admin_search_orders (0076).
 * - `attention=true`: sólo las que necesitan a una persona.
 */
const filterFields = {
  tenantId: Uuid.optional(),
  subtree: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  vertical: z.enum(ADMIN_ORDER_VERTICALS).optional(),
  provider: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/, { message: 'el proveedor es un código como latam-ndc' })
    .optional(),
  status: StatusList.optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  // Sin caracteres de control: un NUL llega a Postgres como 22021 y sería un 500, no un 400.
  q: z
    .string()
    .trim()
    .min(2, { message: 'escribe al menos 2 caracteres' })
    .max(ADMIN_ORDERS_MAX_QUERY, {
      message: `la búsqueda puede tener hasta ${ADMIN_ORDERS_MAX_QUERY} caracteres`,
    })
    .refine((v) => !/\p{Cc}/u.test(v), { message: 'la búsqueda tiene caracteres no válidos' })
    .optional(),
  attention: z
    .literal('true')
    .transform(() => true as const)
    .optional(),
};

/** `cursor` y `limit`: la página. Sólo de la lista. */
const pageFields = {
  cursor: z
    .string()
    .max(200, { message: INVALID_CURSOR })
    .transform((raw, ctx) => {
      const cursor = decodeAdminOrdersCursor(raw);
      if (cursor === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: INVALID_CURSOR });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_ORDERS_MAX_PAGE).default(ADMIN_ORDERS_PAGE),
};

function checkDates(query: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'la fecha "hasta" no puede ser anterior a "desde"',
    });
  }
}

/**
 * `GET /admin/orders`: los filtros ({@link filterFields}) y la página. Estricto: el BFF reconstruye la
 * query parámetro por parámetro, así que un campo de más es un error de programación y no un filtro
 * que se ignora en silencio.
 */
export const AdminOrdersQuerySchema = z
  .object({ ...filterFields, ...pageFields })
  .strict()
  .superRefine(checkDates);
export type AdminOrdersQuery = z.infer<typeof AdminOrdersQuerySchema>;

/** Las reservas que caben en una exportación. Con más, 422 EXPORT_TOO_LARGE. */
export const ADMIN_ORDERS_EXPORT_MAX_ROWS = 5000;

/**
 * `GET /admin/orders/export`: los MISMOS filtros que la lista, sin la página. Estricto: `cursor` o
 * `limit` son un 400, porque la exportación es la vista entera y no una página.
 */
export const AdminOrdersExportQuerySchema = z.object(filterFields).strict().superRefine(checkDates);
export type AdminOrdersExportQuery = z.infer<typeof AdminOrdersExportQuerySchema>;

/** Los filtros, sin la página: lo que lee admin_search_orders para la lista y la exportación. */
export type AdminOrdersFilters = AdminOrdersExportQuery;

// ───────────────────────────── Acciones de post-venta ─────────────────────────────

/** El motivo de una acción del superadmin: queda en la auditoría del nodo y de la plataforma. */
export const ADMIN_ORDER_ACTION_REASON_MIN = 5;
export const ADMIN_ORDER_ACTION_REASON_MAX = 500;

/** Un carácter de control que no es salto de línea ni tabulación (el motivo se escribe en un área). */
const CONTROL_CHARACTER = /(?![\n\r\t])\p{Cc}/u;

const REASON_REQUIRED = 'escribe el motivo: queda en la auditoría';

/** Sin cuerpo no hay motivo: el mismo mensaje que un motivo vacío. */
const BODY_REQUIRED = { required_error: REASON_REQUIRED, invalid_type_error: REASON_REQUIRED };

const ActionReason = z
  .string({ required_error: REASON_REQUIRED, invalid_type_error: REASON_REQUIRED })
  .trim()
  .min(ADMIN_ORDER_ACTION_REASON_MIN, {
    message: `el motivo tiene que tener al menos ${ADMIN_ORDER_ACTION_REASON_MIN} caracteres`,
  })
  .max(ADMIN_ORDER_ACTION_REASON_MAX, {
    message: `el motivo puede tener hasta ${ADMIN_ORDER_ACTION_REASON_MAX} caracteres`,
  })
  .refine((v) => !CONTROL_CHARACTER.test(v), {
    message: 'el motivo tiene caracteres no válidos',
  });

/**
 * El cuerpo de las acciones de post-venta (`POST /admin/orders/:id/send-confirmation`, `…/retrieve`,
 * `…/operations/:opId/retry`): sólo el motivo, obligatorio. Estricto: el BFF lo reconstruye.
 */
export const AdminOrderActionSchema = z.object({ reason: ActionReason }, BODY_REQUIRED).strict();
export type AdminOrderActionDto = z.infer<typeof AdminOrderActionSchema>;

const ORDER_NUMBER_REQUIRED = 'escribe el número de la orden para confirmar';

/**
 * `POST /admin/orders/:id/cancel`: el motivo y el número de la orden, que el superadmin escribe
 * para confirmar (FD-1 C). El API lo compara con el de la reserva: el pedido no depende de que la
 * pantalla lo haya comprobado.
 */
export const AdminOrderCancelSchema = z
  .object(
    {
      reason: ActionReason,
      orderNumber: z
        .number({
          required_error: ORDER_NUMBER_REQUIRED,
          invalid_type_error: ORDER_NUMBER_REQUIRED,
        })
        .int({ message: ORDER_NUMBER_REQUIRED })
        .positive({ message: ORDER_NUMBER_REQUIRED })
        .max(2_147_483_647, { message: ORDER_NUMBER_REQUIRED }),
    },
    BODY_REQUIRED,
  )
  .strict();
export type AdminOrderCancelDto = z.infer<typeof AdminOrderCancelSchema>;
