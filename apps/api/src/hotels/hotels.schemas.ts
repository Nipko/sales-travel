import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha esperada YYYY-MM-DD');
const lang = z.enum(['EN', 'ES', 'PT']);
const identificationType = z.enum(['LOCAL', 'PASSPORT']);

export const RoomDistributionSchema = z.object({
  adults: z.number().int().min(1).max(8),
  childrenAges: z.array(z.number().int().min(0).max(17)).max(6).default([]),
});

// ───────────────────────── Búsqueda ─────────────────────────

export const HotelSuggestQuerySchema = z.object({
  q: z.string().min(1).max(120),
  locale: z.string().min(2).max(12).optional(),
});

export const HotelAvailabilityInputSchema = z.object({
  checkinDate: isoDate,
  checkoutDate: isoDate,
  currency: z.string().length(3).optional(),
  hotelIds: z.array(z.string().min(1)).min(1).max(100),
  rooms: z.array(RoomDistributionSchema).min(1).max(8),
  countryCode: z.string().length(2).optional(),
  language: lang.optional(),
  ttl: z.number().int().positive().optional(),
  refundableOnly: z.boolean().optional(),
});

export const HotelDetailInputSchema = z.object({
  hotelId: z.string().min(1),
  checkinDate: isoDate,
  checkoutDate: isoDate,
  currency: z.string().length(3).optional(),
  rooms: z.array(RoomDistributionSchema).min(1).max(8),
  roompackId: z.string().min(1).optional(),
  countryCode: z.string().length(2).optional(),
  language: lang.optional(),
  ttl: z.number().int().positive().optional(),
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
