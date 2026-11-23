import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha esperada YYYY-MM-DD');
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'moneda ISO-4217 de tres letras')
  .transform((s) => s.toUpperCase());
const language = z.enum(['es', 'pt', 'en']);

/**
 * Participantes por edad: adultos y la edad de cada menor (0–17). La edad, no la categoría,
 * decide si es niño o bebé: cada modalidad tiene sus propios rangos.
 */
export const ParticipantsSchema = z
  .object({
    adults: z.number().int().min(1).max(9),
    childrenAges: z.array(z.number().int().min(0).max(17)).max(8).default([]),
  })
  .refine((p) => p.adults + p.childrenAges.length <= 10, {
    message: 'Máximo 10 participantes por reserva.',
    path: ['childrenAges'],
  });

export const ActivitySearchQuerySchema = z.object({
  /** Código IATA de la ciudad (`ORL`, `SAO`, `BOG`). */
  destination: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'código IATA de la ciudad, p. ej. ORL')
    .transform((s) => s.toUpperCase()),
  language: language.optional(),
});
export type ActivitySearchQuery = z.infer<typeof ActivitySearchQuerySchema>;

export const ActivityIdParamSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,120}$/, 'id de actividad inválido');

export const ModalitiesQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    language: language.optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Indica las dos fechas (desde y hasta) o ninguna.',
    path: ['to'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'La fecha final no puede ser anterior a la inicial.',
    path: ['to'],
  });
export type ModalitiesQueryInput = z.infer<typeof ModalitiesQuerySchema>;

export const AvailabilityBodySchema = z
  .object({
    activityId: ActivityIdParamSchema,
    modalityId: z.string().min(1).max(120),
    date: isoDate,
    participants: ParticipantsSchema,
    schedule: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'horario HH:mm')
      .optional(),
    additional: z.string().min(1).max(120).optional(),
    /** Moneda en la que se quiere el precio; por defecto la de la agencia o la local. */
    currency: currency.optional(),
    language: language.optional(),
  })
  .strict();
export type AvailabilityBody = z.infer<typeof AvailabilityBodySchema>;

export const ShoppingBodySchema = z
  .object({
    park: z.enum(['DY_ORL', 'UN_ORL', 'SW_ORL', 'BG_ORL']),
    from: isoDate,
    to: isoDate.optional(),
    participants: ParticipantsSchema,
    modalities: z.array(z.string().min(1).max(120)).max(20).optional(),
    currency: currency.optional(),
    language: language.optional(),
  })
  .strict()
  .refine((b) => b.to === undefined || b.to >= b.from, {
    message: 'La fecha final no puede ser anterior a la inicial.',
    path: ['to'],
  });
export type ShoppingBody = z.infer<typeof ShoppingBodySchema>;

export const PrebookBodySchema = z
  .object({
    choiceId: z.string().min(1).max(4000),
    language: language.optional(),
  })
  .strict();
export type PrebookBody = z.infer<typeof PrebookBodySchema>;

const personName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  // Letras (con tildes, ñ, ç: ISO-8859-1), espacios, guiones y apóstrofos.
  .regex(/^[\p{L}' -]+$/u, 'sólo letras, espacios, guiones y apóstrofos');

export const TravelerSchema = z
  .object({
    firstName: personName,
    lastName: personName,
    birthDate: isoDate,
    nationality: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional(),
    gender: z.enum(['MALE', 'FEMALE']).optional(),
    identification: z
      .object({
        type: z.enum(['LOCAL', 'PASSPORT']),
        number: z.string().trim().min(3).max(30),
        issueCountry: z
          .string()
          .regex(/^[A-Za-z]{2}$/)
          .optional(),
      })
      .optional(),
  })
  .strict();

/**
 * Reserva. Lleva lo que el vendedor VIO (`offer`): moneda y neto con el que se cotizó, para guardar
 * la orden con el precio de venta de la cascada. El neto no se le manda a Despegar: Despegar cobra
 * lo del prebook.
 */
export const BookBodySchema = z
  .object({
    prebookId: z.string().min(1).max(4000),
    offer: z
      .object({
        choiceId: z.string().min(1).max(4000),
        activityId: z.string().min(1).max(120),
        modalityId: z.string().max(120).optional(),
        name: z.string().min(1).max(300),
        modalityName: z.string().max(300).optional(),
        category: z.enum(['ticket', 'tour']),
        date: isoDate,
        startAt: z.string().max(40).optional(),
        currency,
        netMinor: z.number().int().min(0),
      })
      .strict(),
    contact: z
      .object({
        email: z.string().email().max(200),
        phone: z
          .object({
            countryCode: z.string().regex(/^\d{1,4}$/),
            areaCode: z
              .string()
              .regex(/^\d{0,5}$/)
              .optional(),
            number: z.string().regex(/^\d{4,15}$/),
          })
          .optional(),
      })
      .strict(),
    travelers: z.array(TravelerSchema).min(1).max(10),
  })
  .strict()
  .superRefine((b, ctx) => {
    // Despegar pide el documento para los tickets (`identification` «Required for TICKET»).
    if (b.offer.category === 'ticket') {
      b.travelers.forEach((t, i) => {
        if (!t.identification) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Los tickets piden el documento de cada participante.',
            path: ['travelers', i, 'identification'],
          });
        }
      });
    }
  });
export type BookBody = z.infer<typeof BookBodySchema>;

export const ReservationIdParamSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,60}$/, 'código de reserva inválido');

export const CancelBodySchema = z
  .object({
    reason: z
      .enum([
        'FAMILY_OR_WORK_PROBLEM',
        'TRAVEL_ANOTHER_DESTINATION',
        'NATURAL_DISASTER',
        'WRONG_PURCHASE_DATA',
        'ILLNESS',
        'DEATH',
        'DUPLICATE_RESERVATION',
        'OTHER',
      ])
      .default('OTHER'),
  })
  .strict();
export type CancelBody = z.infer<typeof CancelBodySchema>;
