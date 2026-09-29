import { HotelProviderCodeSchema, MoneySchema } from '@sales-travel/canonical';
import type { ProviderDestinationId } from '@sales-travel/domain';
import {
  CurrencyCodeSchema,
  LanguageCodeSchema,
  toIsoCountryAlpha2,
  z,
} from '@sales-travel/validation';
import { PROVIDER_DESTINATION_INVALID, isProviderDestinationId } from './hotel-destination.js';
import {
  HotelOfferReferenceSchema,
  type HotelOfferReference,
} from './hotel-search-context.store.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha esperada YYYY-MM-DD');
const lang = z.enum(['EN', 'ES', 'PT']);
const identificationType = z.enum(['LOCAL', 'PASSPORT']);

/**
 * Topes de ocupación del BORDE: lo máximo que la plataforma acepta de cualquier vendedor.
 *
 * Cada proveedor declara los suyos, más estrechos, en su `searchProfile.occupancy`; el que no
 * los cumple queda fuera de esa búsqueda con el motivo en `providers[]`, y los demás buscan
 * igual. Por eso estos no se achican al del proveedor más restrictivo: le quitarían a todos lo
 * que sólo uno no admite.
 */
export const PLATFORM_OCCUPANCY_LIMITS = {
  maxRooms: 8,
  maxAdultsPerRoom: 8,
  maxChildrenPerRoom: 6,
  maxChildAge: 17,
} as const;

export const RoomDistributionSchema = z.object({
  adults: z.number().int().min(1).max(PLATFORM_OCCUPANCY_LIMITS.maxAdultsPerRoom),
  childrenAges: z
    .array(z.number().int().min(0).max(PLATFORM_OCCUPANCY_LIMITS.maxChildAge))
    .max(PLATFORM_OCCUPANCY_LIMITS.maxChildrenPerRoom)
    .default([]),
});

const rooms = z.array(RoomDistributionSchema).min(1).max(PLATFORM_OCCUPANCY_LIMITS.maxRooms);

/**
 * Moneda de VENTA de la búsqueda: la puerta de moneda descarta las tarifas que no vengan en ella.
 * Se normaliza acá porque un `'cop'` que pasara tal cual haría descartar todas, que llegan en
 * mayúsculas.
 *
 * El esquema sólo exige un código ISO 4217. Cuáles puede elegir la agencia —la suya y USD
 * (D-TBO-15, selector de moneda)— depende del tenant, así que lo decide el servicio con
 * `resolveHotelSearchCurrency`, que responde 400 con la lista.
 */
const saleCurrency = z.string().trim().toUpperCase().pipe(CurrencyCodeSchema);

export const GUEST_NATIONALITY_INVALID =
  'No reconocemos la nacionalidad del pasajero principal: indicá el código ISO del país, de 2 o 3 letras (por ejemplo, CO o COL).';

/**
 * Nacionalidad del pasajero principal, que sale siempre en ISO 3166-1 alfa-2 (RF-06). No es el
 * país del punto de venta (`countryCode`) y nunca se deduce de él ni de la agencia.
 *
 * - Alfa-3 se convierte: es como la guarda el CRM (`'COL'` → `'CO'`), y así llega al prellenar la
 *   búsqueda con un cliente.
 * - Vacía cuenta como ausente: es lo que manda un formulario con el campo sin completar, y la
 *   ausencia ya tiene su camino (el proveedor que la necesita queda fuera con el motivo).
 * - Cualquier otra cosa se rechaza con un mensaje que se la pide al vendedor. No se adivina ni se
 *   descarta callada: un texto libre del CRM mandado "parecido" es una tarifa de otra nacionalidad.
 */
const guestNationality = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .transform((value, ctx) => {
      const code = toIsoCountryAlpha2(value);
      if (code === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: GUEST_NATIONALITY_INVALID });
        return z.NEVER;
      }
      return code;
    })
    .optional(),
);

// ───────────────────────── Búsqueda ─────────────────────────

/** `city_id` del autocompletado de la plataforma, como siempre: un entero positivo, o su texto. */
const PlatformDestinationIdSchema = z.coerce.number().int().positive();

/**
 * Destino de la búsqueda (docs/tbo/05 §8.5): el `city_id` de la plataforma o, si trae `:`, una
 * ciudad del catálogo local de un proveedor (`tbo-hotels:150184`), que se valida con su forma.
 *
 * Se elige el esquema por la forma y no con `z.union`: cuando fallan las dos ramas, la unión
 * responde un único `Invalid input`, y un destino numérico inválido tiene que seguir respondiendo
 * lo que respondía.
 */
const DestinationIdSchema = z.unknown().transform((value, ctx): number | ProviderDestinationId => {
  if (typeof value === 'string' && value.includes(':')) {
    const trimmed = value.trim();
    if (isProviderDestinationId(trimmed)) return trimmed;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: PROVIDER_DESTINATION_INVALID });
    return z.NEVER;
  }
  const parsed = PlatformDestinationIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue(issue);
  return z.NEVER;
});

export const HotelSuggestQuerySchema = z.object({
  q: z.string().min(1).max(120),
  locale: z.string().min(2).max(12).optional(),
});

export const HotelAvailabilityInputSchema = z
  .object({
    checkinDate: isoDate,
    checkoutDate: isoDate,
    currency: saleCurrency.optional(),
    // Uno de los dos: lista explícita de hoteles, o destino (city_id de la plataforma, o ciudad
    // del catálogo local de un proveedor) que el API resuelve a IDs vía el catálogo de inventario.
    hotelIds: z.array(z.string().min(1)).max(100).optional(),
    destinationId: DestinationIdSchema.optional(),
    rooms,
    guestNationality,
    countryCode: z.string().length(2).optional(),
    language: lang.optional(),
    refundableOnly: z.boolean().optional(),
  })
  .refine((v) => (v.hotelIds && v.hotelIds.length > 0) || v.destinationId != null, {
    message: 'Indicá un destino o al menos un ID de hotel.',
    path: ['destinationId'],
  });

export const HotelDetailInputSchema = z.object({
  hotelId: z.string().min(1),
  /** De qué proveedor es el hotel. Ausente: el del espacio de ids de la plataforma. */
  provider: HotelProviderCodeSchema.optional(),
  checkinDate: isoDate,
  checkoutDate: isoDate,
  currency: saleCurrency.optional(),
  rooms,
  roompackId: z.string().min(1).optional(),
  guestNationality,
  countryCode: z.string().length(2).optional(),
  language: lang.optional(),
  refundableOnly: z.boolean().optional(),
});

// ───────────────────────── Contenido ─────────────────────────

/**
 * `GET /hotels/content/:providerCode/:hotelId` (PR-3.6). El id va en la ruta y, para el proveedor
 * que se consulta en el momento, en su request: se acota a lo que un código de hotel necesita.
 */
export const HotelContentParamsSchema = z
  .object({
    providerCode: HotelProviderCodeSchema,
    hotelId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, 'código de hotel inválido'),
  })
  .strict();

/**
 * Idioma del contenido, en minúsculas como `hotel_content.lang`; se acepta `ES` como lo manda el
 * resto de `/hotels`. Sin idioma, español: es el del panel.
 */
export const HotelContentQuerySchema = z.object({
  lang: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    LanguageCodeSchema.default('es'),
  ),
});

// ───────────────────────── Reserva ─────────────────────────

/** PreBook de Despegar por `choiceId`: su flujo de siempre, sin contexto ni órdenes (D-TBO-08 A). */
export const PrebookSchema = z.object({
  choiceId: z.string().min(1),
  lang: z.enum(['pt', 'en', 'es']).optional(),
  include: z.array(z.enum(['EXCHANGE_POLICIES', 'IMPORTANT_DATA', 'HINTS'])).optional(),
});

/**
 * PreBook neutral de una tarifa buscada: `{ providerCode, offerRef, searchId }` y nada más
 * (RF-08 CA-4). Ocupación, fechas, nacionalidad e importe salen del contexto del servidor; lo que
 * venga de más se descarta al parsear.
 */
export const HotelPrebookInputSchema = HotelOfferReferenceSchema;

/**
 * Un cuerpo inválido que nombra algún campo del neutral y no `choiceId`: su 400 lista los campos
 * del neutral. Todo lo demás, incluido `{}`, responde como respondía el PreBook de Despegar.
 */
function looksLikeNeutralHotelPrebook(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || 'choiceId' in value) return false;
  return 'providerCode' in value || 'offerRef' in value || 'searchId' in value;
}

/**
 * El cuerpo de `POST /hotels/prebook`: el neutral o el de Despegar, distinguidos por su forma.
 * El de Despegar no tiene un campo que lo nombre —la web lo manda así desde antes— y el código de
 * proveedor del neutral es abierto, así que no hay discriminante literal que Zod pueda usar. El
 * neutral va primero: exige sus tres campos, y un cuerpo con sólo `choiceId` no lo cumple. No es
 * `z.union` por lo mismo que el Book: cuando fallan las dos ramas, la unión responde un único
 * `(general): Invalid input` y el 400 de Despegar dejaba de nombrar `choiceId` (D-TBO-08 A).
 */
export const HotelPrebookBodySchema = z.unknown().transform((value, ctx) => {
  const neutral = HotelPrebookInputSchema.safeParse(value);
  if (neutral.success) return neutral.data;
  const despegar = PrebookSchema.safeParse(value);
  if (despegar.success) return despegar.data;
  const issues = looksLikeNeutralHotelPrebook(value) ? neutral.error.issues : despegar.error.issues;
  for (const issue of issues) ctx.addIssue(issue);
  return z.NEVER;
});
export type HotelPrebookBody = z.infer<typeof HotelPrebookBodySchema>;

/** El cuerpo es el neutral: se enruta por proveedor con el contexto de la búsqueda. */
export function isNeutralHotelPrebook(body: HotelPrebookBody): body is HotelOfferReference {
  return 'providerCode' in body;
}

export const PaymentOptionsQuerySchema = z.object({
  prebookId: z.string().min(1),
  inputPoints: z.coerce.number().int().min(0).optional(),
  includeHints: z.coerce.boolean().optional(),
});

const BookIdentificationSchema = z.object({
  type: identificationType,
  number: z.string().min(1),
  issueCountry: z.string().length(2).optional(),
});

const BookTravelerSchema = z.object({
  referenceId: z.string().min(1),
  firstName: z.string().min(1).max(28),
  lastName: z.string().min(1).max(29),
  gender: z.enum(['MALE', 'FEMALE']).optional(),
  nationality: z.string().length(2).optional(),
  birthDate: isoDate.optional(),
  identification: BookIdentificationSchema.optional(),
});

const BookPhoneSchema = z.object({
  countryCode: z.string().min(1),
  areaCode: z.string().optional(),
  number: z.string().min(1),
  type: z.enum(['HOME', 'MOBILE', 'WORK']).optional(),
});

const BookContactSchema = z.object({
  email: z.string().email(),
  phones: z.array(BookPhoneSchema).optional(),
});

const BookPaymentUnitSchema = z.object({
  planId: z.string().min(1),
  // Token de la tokenización hosted (PCI SAQ-A). Nunca PAN/CVV.
  secureToken: z.string().min(1),
  type: z.string().optional(),
  invoiceReference: z.number().int().optional(),
  cardHolderIdentification: z
    .object({ type: identificationType, number: z.string().min(1) })
    .optional(),
});

const BookInvoiceSchema = z.object({
  reference: z.number().int(),
  fiscalName: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fiscalStatus: z.string().min(1),
  fiscalIdentification: z.object({
    type: z.string().min(1),
    number: z.string().min(1),
    issueCountry: z.string().length(2).optional(),
    expirationDate: z.string().optional(),
  }),
  fiscalAddress: z.object({
    street: z.string().min(1),
    number: z.string().min(1),
    apartment: z.string().optional(),
    floor: z.string().optional(),
    neighborhood: z.string().optional(),
    cityId: z.string().min(1),
    zipCode: z.string().min(1),
  }),
});

/**
 * Un huésped del Book neutral. Los topes son los del borde; los del proveedor (TBO: ASCII, de 2 a
 * 40 caracteres, sin dígitos) los aplica su validación contra la ocupación, que responde con el
 * motivo (RF-18). El título es obligatorio para quien lo exige y se elige, no se deriva del género.
 */
const HotelBookGuestSchema = z
  .object({
    paxType: z.enum(['ADT', 'CHD']),
    title: z.enum(['Mr', 'Mrs', 'Ms']).optional(),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
  })
  .strict();

/** El contacto del HUÉSPED: queda en la orden y no viaja al proveedor (D-TBO-23 A). */
const HotelBookContactSchema = z
  .object({
    email: z.string().trim().max(254).email(),
    phone: z
      .object({
        countryCode: z.string().regex(/^\+?\d{1,3}$/),
        areaCode: z
          .string()
          .regex(/^\d{1,6}$/)
          .optional(),
        number: z.string().regex(/^[\d\s().-]{4,20}$/),
      })
      .strict(),
  })
  .strict();

/**
 * Book neutral de una tarifa revalidada (RF-20): la referencia del snapshot del PreBook, el precio
 * de venta que el vendedor aceptó, la confirmación de los cargos en el hotel, los huéspedes por
 * habitación en el orden de la búsqueda y el contacto del huésped. La tarifa, la ocupación y el
 * importe que llegan al proveedor salen del servidor; el navegador no los aporta.
 */
export const HotelBookInputSchema = z
  .object({
    providerCode: HotelProviderCodeSchema,
    prebookRef: z.string().uuid(),
    acceptedTotal: MoneySchema.strict(),
    atPropertyAcknowledged: z.boolean().optional(),
    rooms: z
      .array(z.object({ guests: z.array(HotelBookGuestSchema).min(1).max(16) }).strict())
      .min(1)
      .max(PLATFORM_OCCUPANCY_LIMITS.maxRooms),
    contact: HotelBookContactSchema,
  })
  .strict();
export type HotelBookInput = z.infer<typeof HotelBookInputSchema>;

export const BookSchema = z.object({
  prebookId: z.string().min(1),
  externalBookingReference: z.string().min(1),
  modality: z.string().optional(),
  contact: BookContactSchema,
  travelers: z.array(BookTravelerSchema).min(1),
  payment: z.object({
    optionType: z.string().min(1),
    units: z.array(BookPaymentUnitSchema).min(1),
    invoices: z.array(BookInvoiceSchema).optional(),
  }),
  context: z
    .object({ clientIp: z.string().optional(), userAgent: z.string().optional() })
    .optional(),
  disableSyncResult: z.boolean().optional(),
  testCase: z.literal('pricejump').optional(),
});

/** Sólo el neutral nombra `prebookRef`; el de Despegar reserva por `prebookId`. */
function looksLikeNeutralHotelBook(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'prebookRef' in value;
}

/**
 * El cuerpo de `POST /hotels/book`: el neutral, que reserva con órdenes (PR-4.6), o el de Despegar,
 * que sigue con su flujo de siempre (D-TBO-08 A). Se elige el esquema por la forma ANTES de
 * validar, y no con `z.union`: cuando fallan las dos ramas, la unión responde un único
 * `(general): Invalid input` y el 400 de Despegar dejaba de nombrar el campo que falta
 * (`externalBookingReference: Required`), como lo nombraba antes. El neutral es `.strict()`.
 */
export const HotelBookBodySchema = z.unknown().transform((value, ctx) => {
  const parsed = looksLikeNeutralHotelBook(value)
    ? HotelBookInputSchema.safeParse(value)
    : BookSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue(issue);
  return z.NEVER;
});
export type HotelBookBody = z.infer<typeof HotelBookBodySchema>;

/** El cuerpo es el neutral: reserva con orden detrás. */
export function isNeutralHotelBook(body: HotelBookBody): body is HotelBookInput {
  return 'prebookRef' in body && 'providerCode' in body;
}

export const CancelBodySchema = z.object({
  reason: z
    .enum([
      'FAMILY_OR_WORK_PROBLEM',
      'TRAVEL_ANOTHER_DESTINATION',
      'NATURAL_DISASTER',
      'WRONG_PURCHASE_DATA',
      'ILLNESS',
      'DEATH',
      'DUPLICATE_RESERVATION',
      'CHANGE_PROBLEM',
      'CREDIT_CARD_PROBLEM',
      'HOTEL_PROBLEM',
      'OTHER',
    ])
    .optional(),
});

export const RecoveryBodySchema = z.object({
  messageType: z.string().min(1),
  confirmations: z.array(z.object({ flavorId: z.string().min(1), confirm: z.boolean() })).min(1),
  testCase: z.literal('pricejump').optional(),
});

export type HotelSuggestQuery = z.infer<typeof HotelSuggestQuerySchema>;
export type HotelAvailabilityInput = z.infer<typeof HotelAvailabilityInputSchema>;
export type HotelDetailInput = z.infer<typeof HotelDetailInputSchema>;
export type HotelContentParams = z.infer<typeof HotelContentParamsSchema>;
export type HotelContentQuery = z.infer<typeof HotelContentQuerySchema>;
export type PaymentOptionsInput = z.infer<typeof PaymentOptionsQuerySchema>;
export type CancelBody = z.infer<typeof CancelBodySchema>;
export type RecoveryBody = z.infer<typeof RecoveryBodySchema>;
