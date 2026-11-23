import { CurrencyCodeSchema, z } from '@sales-travel/validation';
import { MoneySchema } from './money';

/**
 * Contrato NEUTRAL de la vertical de actividades (tickets y tours): lo que cualquier ACL de
 * actividades produce y lo que el API y la web consumen. Hoy lo produce Despegar/HotelDO
 * (`providers/despegar-activities`); sus DTOs no salen de ese paquete.
 *
 * Regla de lectura: un campo opcional ausente significa "el proveedor no lo informó", nunca
 * "no aplica".
 */

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha esperada: YYYY-MM-DD');

/** `ticket`: entrada a un parque (Orlando). `tour`: cualquier otra actividad con horario. */
export const ActivityCategorySchema = z.enum(['ticket', 'tour']);
export type ActivityCategory = z.infer<typeof ActivityCategorySchema>;

/** Un resultado de la búsqueda por destino: alcanza para listar y abrir las modalidades. */
export const ActivitySummarySchema = z.object({
  id: z.string().min(1),
  category: ActivityCategorySchema,
  name: z.string(),
});
export type ActivitySummary = z.infer<typeof ActivitySummarySchema>;

export const AgeRangeSchema = z.object({
  minAge: z.number().int().nonnegative(),
  maxAge: z.number().int().nonnegative(),
});
export type AgeRange = z.infer<typeof AgeRangeSchema>;

export const ActivityAdditionalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** Precio por moneda (USD siempre y la moneda local, si la hay). */
  prices: z.array(MoneySchema),
});
export type ActivityAdditional = z.infer<typeof ActivityAdditionalSchema>;

export const ActivityModalitySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string().optional(),
  /** Fechas con cupo y, si es un tour, sus horarios (`HH:mm`). */
  availableDates: z.array(z.object({ date: IsoDateSchema, hours: z.array(z.string()) })),
  /** Precio de referencia por persona. El final sale de la disponibilidad de una fecha. */
  referencePrices: z.array(MoneySchema),
  maxCapacity: z.number().int().positive().optional(),
  ageRanges: z.object({
    adult: AgeRangeSchema.optional(),
    child: AgeRangeSchema.optional(),
    infant: AgeRangeSchema.optional(),
  }),
  additionals: z.array(ActivityAdditionalSchema),
});
export type ActivityModality = z.infer<typeof ActivityModalitySchema>;

export const ActivityDurationSchema = z.object({
  /** Unidad tal como la informa el proveedor, en minúsculas (`day`, `hour`, `minute`…). */
  unit: z.string(),
  value: z.number().nonnegative(),
});
export type ActivityDuration = z.infer<typeof ActivityDurationSchema>;

/** La ficha de una actividad con sus modalidades. */
export const ActivityDetailSchema = z.object({
  id: z.string().min(1),
  category: ActivityCategorySchema,
  name: z.string(),
  description: z.string().optional(),
  duration: ActivityDurationSchema.optional(),
  images: z.array(z.string().url()),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
  modalities: z.array(ActivityModalitySchema),
});
export type ActivityDetail = z.infer<typeof ActivityDetailSchema>;

/**
 * Un precio en una moneda. Despegar da uno en USD y otro en la moneda local del país de venta:
 * la plataforma no convierte, elige el de la moneda pedida.
 */
export const ActivityPriceSchema = z.object({
  currency: CurrencyCodeSchema,
  /** Neto: lo que se le paga al proveedor. */
  net: MoneySchema,
  tax: MoneySchema,
  /** Neto + impuestos. Es la base de la cascada de markup. */
  gross: MoneySchema,
  /** Comisión de agencia que el proveedor ya incluye, si la informa. */
  agencyCommission: MoneySchema.optional(),
});
export type ActivityPrice = z.infer<typeof ActivityPriceSchema>;

/** Un tramo de penalidad: desde `from` (y hasta `to`, si no es el último) se pierde `percentage`. */
export const ActivityCancellationTierSchema = z.object({
  /** ISO 8601: fecha (`YYYY-MM-DD`) o instante, tal como lo informó el proveedor. */
  from: z.string(),
  to: z.string().optional(),
  /** 0 = gratis, 100 = sin reembolso. */
  percentage: z.number().min(0).max(100),
  label: z.string().optional(),
  penalties: z.array(MoneySchema),
});
export type ActivityCancellationTier = z.infer<typeof ActivityCancellationTierSchema>;

export const ActivityCancellationSchema = z.object({
  refundable: z.boolean(),
  title: z.string().optional(),
  tiers: z.array(ActivityCancellationTierSchema),
  conditions: z.array(z.string()),
});
export type ActivityCancellation = z.infer<typeof ActivityCancellationSchema>;

/** Participantes por edad. Una actividad no hereda la ocupación del hotel de un paquete. */
export const ActivityParticipantsSchema = z.object({
  adults: z.number().int().min(1),
  /** Edades de todos los menores (niños y bebés), 0–17. */
  childrenAges: z.array(z.number().int().min(0).max(17)),
});
export type ActivityParticipants = z.infer<typeof ActivityParticipantsSchema>;

export const TicketValiditySchema = z.object({
  useDate: IsoDateSchema.optional(),
  /** Instante ISO 8601 hasta el que vale la entrada. */
  expirationDate: z.string().optional(),
});
export type TicketValidity = z.infer<typeof TicketValiditySchema>;

/** Una tarifa reservable: una actividad, una modalidad, una fecha y unos participantes. */
export const ActivityOfferSchema = z.object({
  /** Token opaco para reservar (prebook). */
  choiceId: z.string().min(1),
  activityId: z.string(),
  modalityId: z.string().optional(),
  category: ActivityCategorySchema,
  name: z.string(),
  modalityName: z.string().optional(),
  date: IsoDateSchema,
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  destination: z.string().optional(),
  participants: ActivityParticipantsSchema,
  /** Cómo clasificó el proveedor a cada participante. */
  ageLimits: z.object({
    adultMaxAge: z.number().optional(),
    childMaxAge: z.number().optional(),
    infantMaxAge: z.number().optional(),
  }),
  prices: z.array(ActivityPriceSchema).min(1),
  cancellation: ActivityCancellationSchema,
  ticketValidity: TicketValiditySchema.optional(),
  highlights: z.array(z.string()),
  additionals: z.array(z.object({ title: z.string(), description: z.string().optional() })),
});
export type ActivityOffer = z.infer<typeof ActivityOfferSchema>;
