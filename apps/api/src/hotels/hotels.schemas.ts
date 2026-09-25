import { HotelProviderCodeSchema } from '@sales-travel/canonical';
import { CountryCodeSchema, CurrencyCodeSchema, z } from '@sales-travel/validation';

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
 */
const saleCurrency = z.string().trim().toUpperCase().pipe(CurrencyCodeSchema);

/**
 * Nacionalidad del huésped principal, ISO 3166-1 alfa-2. No es el país del punto de venta
 * (`countryCode`) y nunca se deduce de él.
 */
const guestNationality = z.string().trim().toUpperCase().pipe(CountryCodeSchema);

// ───────────────────────── Búsqueda ─────────────────────────

export const HotelSuggestQuerySchema = z.object({
  q: z.string().min(1).max(120),
  locale: z.string().min(2).max(12).optional(),
});

export const HotelAvailabilityInputSchema = z
  .object({
    checkinDate: isoDate,
    checkoutDate: isoDate,
    currency: saleCurrency.optional(),
    // Uno de los dos: lista explícita de hoteles, o destino (city_id) que el API resuelve
    // a IDs vía el catálogo de inventario de cada proveedor.
    hotelIds: z.array(z.string().min(1)).max(100).optional(),
    destinationId: z.coerce.number().int().positive().optional(),
    rooms,
    guestNationality: guestNationality.optional(),
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
  guestNationality: guestNationality.optional(),
  countryCode: z.string().length(2).optional(),
  language: lang.optional(),
  refundableOnly: z.boolean().optional(),
});

// ───────────────────────── Reserva ─────────────────────────

export const PrebookSchema = z.object({
  choiceId: z.string().min(1),
  lang: z.enum(['pt', 'en', 'es']).optional(),
  include: z.array(z.enum(['EXCHANGE_POLICIES', 'IMPORTANT_DATA', 'HINTS'])).optional(),
});

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
export type PaymentOptionsInput = z.infer<typeof PaymentOptionsQuerySchema>;
export type CancelBody = z.infer<typeof CancelBodySchema>;
export type RecoveryBody = z.infer<typeof RecoveryBodySchema>;
