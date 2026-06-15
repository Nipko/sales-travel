import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha esperada YYYY-MM-DD');
const militaryHour = z.string().regex(/^\d{4}$/, 'hora HHMM ej 1000');
const paymentType = z.enum(['ppd', 'pod']);

// ───────────────────────── Búsqueda ─────────────────────────

export const CarSuggestQuerySchema = z.object({
  q: z.string().min(1).max(120),
  lang: z.string().min(2).max(5).optional(),
});

export const FindOfficesQuerySchema = z
  .object({
    distance: z.coerce.number().positive(),
    source: z.string().length(2).optional(),
    companyCode: z.string().min(1).optional(),
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
    cityCode: z.string().min(1).optional(),
  })
  .refine((v) => (v.lat != null && v.lng != null) || v.cityCode != null, {
    message: 'Indicá coordenadas (lat y lng) o un cityCode.',
    path: ['cityCode'],
  });

export const RatesQuerySchema = z.object({
  // country = país destino (requerido; NO defaultea a source/origen para no devolver el catálogo equivocado).
  country: z.string().length(2),
  // source = país origen; opcional, el adapter usa el sourceCountry de la cuenta BYOC si se omite.
  source: z.string().length(2).optional(),
  language: z.string().min(2).max(5).optional(),
});

const carSearchObject = z.object({
  pickUpLocation: z.string().min(1),
  dropOffLocation: z.string().min(1),
  pickUpDate: isoDate,
  dropOffDate: isoDate,
  pickUpHour: militaryHour,
  dropOffHour: militaryHour,
  rateType: z.string().min(1).default('best'),
  source: z.string().length(2).optional(),
  country: z.string().length(2),
  paymentType: paymentType.optional(),
  companyCode: z.string().min(1).optional(),
  cdCode: z.string().min(1).optional(),
  pcCode: z.string().min(1).optional(),
  language: z.string().min(2).max(5).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  latDropOff: z.coerce.number().optional(),
  lngDropOff: z.coerce.number().optional(),
});

/**
 * Búsqueda por ciudad: AgentCars exige coordenadas cuando la ubicación es genérica.
 * pickUpLocation="City" requiere lat/lng; dropOffLocation="City2" requiere latDropOff/lngDropOff.
 */
function cityCoordsOk(v: {
  pickUpLocation: string;
  dropOffLocation: string;
  lat?: number | undefined;
  lng?: number | undefined;
  latDropOff?: number | undefined;
  lngDropOff?: number | undefined;
}): boolean {
  if (v.pickUpLocation === 'City' && (v.lat == null || v.lng == null)) return false;
  if (v.dropOffLocation === 'City2' && (v.latDropOff == null || v.lngDropOff == null)) return false;
  return true;
}

const cityCoordsRefinement = {
  message:
    'Búsqueda por ciudad: enviá lat/lng cuando pickUpLocation="City" y latDropOff/lngDropOff cuando dropOffLocation="City2".',
  path: ['lat'] as (string | number)[],
};

export const CarSearchInputSchema = carSearchObject.refine(cityCoordsOk, cityCoordsRefinement);

export const CarSelectionInputSchema = carSearchObject
  .extend({
    companyCode: z.string().min(1),
    sippCode: z.string().min(1),
    ccrc: z.string().min(1).optional(),
    coupon: z.string().min(1).optional(),
    tp: z.string().min(1).optional(),
  })
  .refine(cityCoordsOk, cityCoordsRefinement);

export const RateDetailQuerySchema = z.object({
  uniqid: z.string().min(1),
  paymentType,
  rateType: z.string().min(1),
});

// ───────────────────────── Reserva ─────────────────────────

export const ConfirmInputSchema = z.object({
  uniqid: z.string().min(1),
  paymentType,
  rateType: z.string().min(1),
  companyCode: z.string().min(1),
  sippCode: z.string().min(1),
  pickUpLocation: z.string().min(1),
  dropOffLocation: z.string().min(1),
  pickUpDate: isoDate,
  dropOffDate: isoDate,
  pickUpHour: militaryHour,
  dropOffHour: militaryHour,
  pickUpAddress: z.string().min(1).default('NA'),
  dropOffAddress: z.string().min(1).default('NA'),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  age: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  email: z.string().email(),
  realBase: z.coerce.number().nonnegative(),
  realTax: z.coerce.number().nonnegative(),
  total: z.coerce.number().nonnegative(),
  // Normalizado a mayúsculas para cumplir el contrato canónico (CurrencyCodeSchema: /^[A-Z]{3}$/).
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase()),
  ccrc: z.string().min(1).optional(),
  cdCode: z.string().min(1).optional(),
  pcCode: z.string().min(1).optional(),
  flightNumber: z.string().min(1).optional(),
  membershipNumber: z.string().min(1).optional(),
  language: z.string().min(2).max(5).optional(),
  frequentFlyer: z.object({ number: z.string().min(1), carrier: z.string().min(1) }).optional(),
  extras: z
    .object({
      childBoosterSeat: z.boolean().optional(),
      childToddlerSeat: z.boolean().optional(),
      gps: z.boolean().optional(),
      skyracks: z.boolean().optional(),
    })
    .optional(),
  onHold: z.boolean().optional(),
});

export const MyReservationBodySchema = z.object({
  lastName: z.string().min(1),
  confirmationCode: z.string().min(1),
  language: z.string().min(2).max(5).optional(),
});

export const CancelBodySchema = z.object({
  lastName: z.string().min(1),
  confirmationCode: z.string().min(1),
});

export const ReleaseBodySchema = z.object({
  lastName: z.string().min(1),
  referenceCode: z.string().min(1),
});

export const DailyReportQuerySchema = z.object({
  date: isoDate.optional(),
  language: z.string().min(2).max(5).optional(),
});

export type CarSuggestQuery = z.infer<typeof CarSuggestQuerySchema>;
export type FindOfficesInput = z.infer<typeof FindOfficesQuerySchema>;
export type RatesInput = z.infer<typeof RatesQuerySchema>;
export type CarSearchInput = z.infer<typeof CarSearchInputSchema>;
export type CarSelectionInput = z.infer<typeof CarSelectionInputSchema>;
export type RateDetailInput = z.infer<typeof RateDetailQuerySchema>;
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>;
export type MyReservationBody = z.infer<typeof MyReservationBodySchema>;
export type CancelBody = z.infer<typeof CancelBodySchema>;
export type ReleaseBody = z.infer<typeof ReleaseBodySchema>;
export type DailyReportInput = z.infer<typeof DailyReportQuerySchema>;
