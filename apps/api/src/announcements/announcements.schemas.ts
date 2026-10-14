import { z } from '@sales-travel/validation';

/**
 * Lo que entra al publicar o corregir un anuncio de la plataforma (0079). Texto plano: el panel lo
 * pinta como texto, sin HTML ni enlaces automáticos, y acá se le quitan los caracteres de control y
 * los invisibles antes de medirlo. Los topes son los de las columnas, contados en puntos de código
 * como `varchar` (un emoji es uno, no dos).
 */

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const ANNOUNCEMENT_TITLE_MIN = 3;
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 600;

/** Un anuncio dura como mucho esto: el CHECK `system_announcements_window` de 0079. */
export const ANNOUNCEMENT_MAX_WINDOW_DAYS = 31;
export const ANNOUNCEMENT_MAX_WINDOW_MS = ANNOUNCEMENT_MAX_WINDOW_DAYS * 86_400_000;

/** Controles C0 (el salto de línea se trata aparte) y C1: no se ven y cortan donde no hay que cortar. */
// eslint-disable-next-line no-control-regex -- la clase existe justamente para quitarlos.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * Invisibles que no son controles: espacio de ancho cero, marcas y controles de dirección (con ellos
 * un texto se lee al revés de como se escribió) y la marca de orden de bytes. Quedan los que unen
 * emojis o letras (U+200C, U+200D).
 */
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Medio par UTF-16 sin su otra mitad: Postgres no lo guarda en UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** El título: una línea, sin controles ni invisibles, sin espacios de más. */
export function cleanAnnouncementTitle(value: string): string {
  return value
    .replace(LONE_SURROGATE, '')
    .replace(INVISIBLE, '')
    .replace(/\r\n?|\n/g, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * El mensaje: conserva los saltos de línea (como mucho una línea en blanco seguida), quita el resto
 * de los controles y los invisibles. Un tabulador pasa a espacio.
 */
export function cleanAnnouncementBody(value: string): string {
  return value
    .replace(LONE_SURROGATE, '')
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(/[ \u00A0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

const TitleSchema = z
  .string()
  .transform(cleanAnnouncementTitle)
  .refine((v) => codePoints(v) >= ANNOUNCEMENT_TITLE_MIN, {
    message: `El título tiene que tener al menos ${ANNOUNCEMENT_TITLE_MIN} caracteres.`,
  })
  .refine((v) => codePoints(v) <= ANNOUNCEMENT_TITLE_MAX, {
    message: `El título no puede superar los ${ANNOUNCEMENT_TITLE_MAX} caracteres.`,
  });

const BodySchema = z
  .string()
  .transform(cleanAnnouncementBody)
  .refine((v) => codePoints(v) <= ANNOUNCEMENT_BODY_MAX, {
    message: `El mensaje no puede superar los ${ANNOUNCEMENT_BODY_MAX} caracteres.`,
  });

/** En minúsculas, como lo devuelve Postgres: el mismo nodo en mayúsculas sería otro en la auditoría. */
const TenantIdSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

const AudienceSchema = z
  .object({
    /** `null` = toda la red; si no, ese nodo y todo lo que cuelga de él. */
    rootTenantId: TenantIdSchema.nullable(),
    adminsOnly: z.boolean(),
  })
  .strict();

const InstantSchema = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));

export type AnnouncementAudience = z.infer<typeof AudienceSchema>;

/**
 * Que la vigencia sea un período y no pase de {@link ANNOUNCEMENT_MAX_WINDOW_DAYS} días. `undefined` si
 * está bien; si no, el mensaje para el panel.
 */
export function announcementWindowError(startsAt: Date, endsAt: Date): string | undefined {
  if (endsAt.getTime() <= startsAt.getTime()) {
    return 'El anuncio tiene que terminar después de empezar.';
  }
  if (endsAt.getTime() - startsAt.getTime() > ANNOUNCEMENT_MAX_WINDOW_MS) {
    return `Un anuncio dura como mucho ${ANNOUNCEMENT_MAX_WINDOW_DAYS} días.`;
  }
  return undefined;
}

/**
 * Publicar un anuncio. `startsAt` opcional (ahora, si no viene); `endsAt` obligatorio y, como mucho,
 * {@link ANNOUNCEMENT_MAX_WINDOW_DAYS} días después del comienzo. Con `startsAt` se revisa acá; sin
 * él, el servicio lo revisa contra la hora de la base.
 */
export const CreateAnnouncementSchema = z
  .object({
    severity: z.enum(ANNOUNCEMENT_SEVERITIES),
    title: TitleSchema,
    body: BodySchema.optional().default(''),
    audience: AudienceSchema,
    startsAt: InstantSchema.optional(),
    endsAt: InstantSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.startsAt === undefined) return;
    const error = announcementWindowError(v.startsAt, v.endsAt);
    if (error !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: error });
  });

export type CreateAnnouncementDto = z.infer<typeof CreateAnnouncementSchema>;

/**
 * Corregir un anuncio: los mismos campos, cualquiera de ellos, al menos uno. La vigencia se revisa en
 * el servicio, con lo que ya tiene el anuncio.
 */
export const UpdateAnnouncementSchema = z
  .object({
    severity: z.enum(ANNOUNCEMENT_SEVERITIES).optional(),
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    audience: AudienceSchema.optional(),
    startsAt: InstantSchema.optional(),
    endsAt: InstantSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'No hay nada que cambiar.',
  });

export type UpdateAnnouncementDto = z.infer<typeof UpdateAnnouncementSchema>;

/** El id de un anuncio en la ruta, en minúsculas. */
export const AnnouncementIdParamSchema = TenantIdSchema;
