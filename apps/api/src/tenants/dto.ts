import { z } from '@sales-travel/validation';
import { ASSIGNABLE_ROLES } from '../auth/roles.js';
import { ADMIN_PASSWORD_RETIRED_MESSAGE } from './onboarding.errors.js';
import { CREATABLE_TENANT_TYPES } from './tenant-admin.policy.js';

/**
 * Los roles que se asignan por API: los de `ASSIGNABLE_ROLES` (auth/roles.ts), la fuente única.
 * Ni `superadmin` ni `platform_admin` (retirado, D7 B) pasan este borde. La usan changeRole y
 * las invitaciones.
 */
export const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES, {
  errorMap: () => ({ message: `rol no asignable: usa uno de ${ASSIGNABLE_ROLES.join(', ')}` }),
});

export const ChangeRoleSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: AssignableRoleSchema,
});
export type ChangeRoleDto = z.infer<typeof ChangeRoleSchema>;

export const InviteUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  tenantId: z.string().uuid(),
  role: AssignableRoleSchema,
});
export type InviteUserDto = z.infer<typeof InviteUserSchema>;

export const AcceptInvitationSchema = z.object({
  token: z.string().min(10).max(512),
  name: z.string().min(1).max(120),
  password: z.string().min(12).max(128),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>;

export const SetMembershipStatusSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  status: z.enum(['active', 'suspended']),
});
export type SetMembershipStatusDto = z.infer<typeof SetMembershipStatusSchema>;

/**
 * Quitar a una persona de un nodo (POST /admin/memberships/remove, USR-11): baja blanda, la
 * membership queda como `removed`. Ids en minúsculas, como los devuelve Postgres: si no, el chequeo
 * de "uno mismo" no lo veía.
 */
export const RemoveMembershipSchema = z
  .object({
    userId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    tenantId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
  })
  .strict();
export type RemoveMembershipDto = z.infer<typeof RemoveMembershipSchema>;

export const SetUserStatusSchema = z.object({
  // En minúsculas, como lo devuelve Postgres: si no, el chequeo de "tu propio usuario" no lo veía.
  userId: z
    .string()
    .uuid()
    .transform((v) => v.toLowerCase()),
  status: z.enum(['active', 'suspended']),
});
export type SetUserStatusDto = z.infer<typeof SetUserStatusSchema>;

/** Dónde va el directorio: la última fila de la página anterior, en el orden (created_at, id). */
export interface PlatformUsersCursor {
  /** ISO 8601 en UTC con microsegundos, como lo guarda Postgres: con milisegundos saltaba filas. */
  readonly createdAt: string;
  readonly id: string;
}

const CURSOR_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;
const CURSOR_ID = z.string().uuid();

/**
 * ¿Es un instante que existe? `Date.parse` acepta "2026-02-30" o "24:00" corriéndolos al día
 * siguiente, y Postgres los rechaza con un 500 al compararlos en el cursor. Los campos tienen que
 * volver iguales de un `Date` armado con ellos. También lo usa el cursor del historial (audit.schemas).
 */
export function realInstant(text: string): boolean {
  const match = CURSOR_INSTANT.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 1970
  ) {
    return false;
  }
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
}

/** El cursor opaco que viaja en `nextCursor`: base64url del JSON `{ createdAt, id }`. */
export function encodePlatformUsersCursor(cursor: PlatformUsersCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString(
    'base64url',
  );
}

/** El cursor leído, o `undefined` si no es uno que haya emitido el directorio. */
export function decodePlatformUsersCursor(raw: string): PlatformUsersCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { createdAt, id } = parsed as Record<string, unknown>;
  if (typeof createdAt !== 'string' || !realInstant(createdAt)) return undefined;
  const uuid = CURSOR_ID.safeParse(id);
  return uuid.success ? { createdAt, id: uuid.data.toLowerCase() } : undefined;
}

/** Un filtro de la URL que sólo se activa: `?locked=true`. Ausente es "no filtrar". */
const FlagSchema = z.literal('true', { errorMap: () => ({ message: 'sólo admite "true"' }) });

/** Personas por página del directorio si no se pide otro tamaño. */
export const PLATFORM_USERS_PAGE_SIZE = 50;

/**
 * Los roles por los que se filtra el directorio: los asignables y el superadmin. `platform_admin`
 * está retirado (D7 B) y no se ofrece.
 */
export const DIRECTORY_ROLES = [...ASSIGNABLE_ROLES, 'superadmin'] as const;

/**
 * El texto de una búsqueda de las listas de la plataforma. El NUL no entra en un texto de Postgres:
 * sin el `refine`, la búsqueda respondía 500.
 */
const SearchTextSchema = z
  .string()
  .trim()
  .min(1, 'escribe algo para buscar')
  .max(100)
  .refine((v) => !v.includes('\u0000'), 'la búsqueda tiene un carácter inválido');

/** El `nextCursor` de la página anterior de una lista de la plataforma. */
const PageCursorSchema = z
  .string()
  .refine((raw) => decodePlatformUsersCursor(raw) !== undefined, 'cursor inválido');

/**
 * El directorio de usuarios de toda la plataforma (GET /admin/users, sólo superadmin). Todos los
 * filtros se combinan; `role` y `tenantId` juntos piden una membership con ese rol en el subárbol de
 * ese nodo. Parámetros de más son 400.
 *
 * Sin transformaciones que cambien el tipo (el cursor sigue en texto, los filtros en `'true'`):
 * ZodValidationPipe exige que la entrada y la salida del esquema coincidan.
 */
export const ListPlatformUsersQuerySchema = z
  .object({
    q: SearchTextSchema.optional(),
    status: z.enum(['active', 'suspended']).optional(),
    role: z
      .enum(DIRECTORY_ROLES, {
        errorMap: () => ({ message: `rol inválido: usa uno de ${DIRECTORY_ROLES.join(', ')}` }),
      })
      .optional(),
    /** El nodo, con todo su subárbol. */
    tenantId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase())
      .optional(),
    mfa: z.enum(['on', 'off']).optional(),
    locked: FlagSchema.optional(),
    neverLoggedIn: FlagSchema.optional(),
    /** El `nextCursor` de la página anterior. Lo lee el servicio (decodePlatformUsersCursor). */
    cursor: PageCursorSchema.optional(),
    /** Sin valor, {@link PLATFORM_USERS_PAGE_SIZE}. */
    limit: intInRange(1, 100).optional(),
  })
  .strict();
export type ListPlatformUsersQuery = z.infer<typeof ListPlatformUsersQuerySchema>;

/**
 * Qué invitaciones sin aceptar ni revocar lista la plataforma: las que todavía sirven (`pending`), las
 * vencidas (`expired`) o las dos (`all`).
 */
export const PLATFORM_INVITATION_STATES = ['pending', 'expired', 'all'] as const;
export type PlatformInvitationState = (typeof PLATFORM_INVITATION_STATES)[number];

/** Invitaciones por página de la lista de la plataforma si no se pide otro tamaño. */
export const PLATFORM_INVITATIONS_PAGE_SIZE = 50;

/**
 * Las invitaciones sin aceptar de toda la red (GET /admin/invitations, sólo superadmin). Sin `state`
 * son las pendientes: el servicio pone el valor por defecto, porque un `.default()` acá haría que la
 * entrada y la salida del esquema no coincidan (ZodValidationPipe). `q` busca en el correo; `tenantId`
 * acota al nodo con todo su subárbol. El cursor es el del directorio: `{ createdAt, id }` de la
 * última fila. Parámetros de más son 400.
 */
export const ListPlatformInvitationsQuerySchema = z
  .object({
    state: z
      .enum(PLATFORM_INVITATION_STATES, {
        errorMap: () => ({
          message: `estado inválido: usa uno de ${PLATFORM_INVITATION_STATES.join(', ')}`,
        }),
      })
      .optional(),
    q: SearchTextSchema.optional(),
    tenantId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase())
      .optional(),
    cursor: PageCursorSchema.optional(),
    /** Sin valor, {@link PLATFORM_INVITATIONS_PAGE_SIZE}. */
    limit: intInRange(1, 100).optional(),
  })
  .strict();
export type ListPlatformInvitationsQuery = z.infer<typeof ListPlatformInvitationsQuerySchema>;

/**
 * Qué arrastraría un cambio sobre una membership, antes de confirmarlo (GET
 * /admin/memberships/impact): suspenderla, quitarla del nodo (`removed`) o darle otro rol. Uno de los
 * dos: la pantalla pregunta por el cambio que está por confirmar.
 */
export const MembershipImpactQuerySchema = z
  .object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    status: z.enum(['active', 'suspended', 'removed']).optional(),
    role: AssignableRoleSchema.optional(),
  })
  .strict()
  .refine((q) => (q.status === undefined) !== (q.role === undefined), {
    message: 'indica status o role, uno solo',
  });
export type MembershipImpactQuery = z.infer<typeof MembershipImpactQuerySchema>;

/** El `id` de la ruta. En minúsculas, como lo devuelve Postgres y como queda en la auditoría. */
export const TenantIdParamSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/** Otro uuid de la ruta (`:userId`, `:sessionId`), con el mismo criterio. */
export const UuidParamSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/**
 * Un entero en rango. El formulario del panel puede mandarlo como texto ("5"): se acepta si son sólo
 * dígitos; "5.5", "5 puestos" o "" no.
 */
function intInRange(min: number, max: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
    z
      .number({ invalid_type_error: `un número entero entre ${min} y ${max}` })
      .int(`un número entero entre ${min} y ${max}`)
      .min(min, `entre ${min} y ${max}`)
      .max(max, `entre ${min} y ${max}`),
  );
}

/** Sesiones simultáneas de un nodo. Mismo rango que el CHECK de tenants.concurrent_seats (0055). */
export const ConcurrentSeatsSchema = intInRange(1, 10_000);
/** Minutos de inactividad de un nodo. Mismo rango que el CHECK de tenants.idle_timeout_minutes. */
export const IdleTimeoutMinutesSchema = intInRange(5, 480);

/**
 * Puestos e inactividad de un nodo (sólo superadmin). `null` = heredar del ancestro; un campo que no
 * viene no se toca. Al menos uno.
 */
export const UpdateSeatsSchema = z
  .object({
    concurrentSeats: ConcurrentSeatsSchema.nullable().optional(),
    idleTimeoutMinutes: IdleTimeoutMinutesSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.concurrentSeats !== undefined || v.idleTimeoutMinutes !== undefined, {
    message: 'indica qué cambiar: concurrentSeats o idleTimeoutMinutes (null = heredar)',
  });
export type UpdateSeatsDto = z.infer<typeof UpdateSeatsSchema>;

/**
 * Un campo opcional del formulario: vacío, sólo espacios o `null` es "no enviado". El panel manda
 * '' en los datos del admin inicial que no se llenan, y eso daba un 400 al crear una agencia sin
 * admin.
 */
function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    schema.optional(),
  );
}

const CreatableTenantTypeSchema = z.enum(CREATABLE_TENANT_TYPES, {
  errorMap: () => ({
    message: 'tipo inválido: consolidator, agency o subagency (la plataforma no se crea por API)',
  }),
});

/**
 * Alta de un nodo de la red. El tipo lo decide el padre (D4 A): el cliente sólo lo manda para
 * pedir un consolidador, y si manda otro tiene que coincidir con el derivado. Sin padre, el del
 * superadmin cuelga de la plataforma; el de cualquier otro admin se rechaza.
 *
 * El admin inicial sólo se invita (docs/platform/14): viaja su email y nada más. El nombre lo pone
 * él al aceptar (un `adminName` de un panel viejo se descarta sin error).
 */
export const CreateTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/),
  defaultCurrency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/),
  defaultLanguage: optionalField(z.enum(['es', 'pt', 'en'])),
  parentTenantId: optionalField(
    z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
  ),
  tenantType: optionalField(CreatableTenantTypeSchema),
  /** Sucursal de Planetour: sólo el superadmin, y sólo bajo la plataforma. */
  isBranch: optionalField(z.boolean()),
  adminEmail: optionalField(z.string().trim().email().toLowerCase()),
  /**
   * Retirado: se rechaza con motivo en vez de descartarse, para que un panel viejo no dé por
   * fijada una contraseña que nadie fijó. Vacío es "no enviado", como el resto del formulario.
   */
  adminPassword: optionalField(
    z.never({ errorMap: () => ({ message: ADMIN_PASSWORD_RETIRED_MESSAGE }) }),
  ),
  /** Puestos simultáneos propios. Sólo el superadmin (403 si no); sin valor, hereda. */
  concurrentSeats: optionalField(ConcurrentSeatsSchema),
  /** Minutos de inactividad propios. Sólo el superadmin (403 si no); sin valor, hereda. */
  idleTimeoutMinutes: optionalField(IdleTimeoutMinutesSchema),
});
export type CreateTenantDto = z.infer<typeof CreateTenantSchema>;

/**
 * Corrección de un nodo por el superadmin: estado, marca de sucursal y tipo. El tipo sólo cambia
 * dentro de D4 (lo valida la base con los hijos incluidos); la plataforma no se crea ni se toca
 * así. El padre no se cambia acá: eso es mover el nodo con su subárbol.
 */
export const UpdateTenantSchema = z
  .object({
    status: z.enum(['active', 'suspended']).optional(),
    isBranch: z.boolean().optional(),
    tenantType: CreatableTenantTypeSchema.optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.isBranch !== undefined || v.tenantType !== undefined, {
    message: 'indica qué cambiar: status, isBranch o tenantType',
  });
export type UpdateTenantDto = z.infer<typeof UpdateTenantSchema>;

/** Mover un nodo con su subárbol (D6 A). El nuevo padre es obligatorio: sólo la plataforma es raíz. */
export const MoveTenantSchema = z
  .object({
    parentTenantId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
  })
  .strict();
export type MoveTenantDto = z.infer<typeof MoveTenantSchema>;
