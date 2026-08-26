import { z } from '@sales-travel/validation';

export const CabinClassSchema = z.enum(['economy', 'premium_economy', 'business', 'first']);
export type CabinClass = z.infer<typeof CabinClassSchema>;

export const IataAirportCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'IATA airport code must be 3 uppercase letters');

export const IataCarrierCodeSchema = z
  .string()
  .min(2)
  .max(3)
  .regex(/^[A-Z0-9]{2,3}$/, 'IATA carrier code must be 2-3 uppercase alphanumeric');

/** Código de aeropuerto IATA (LIM, GRU, MIA, etc.) */
export type IataAirportCode = z.infer<typeof IataAirportCodeSchema>;
export type IataCarrierCode = z.infer<typeof IataCarrierCodeSchema>;

/**
 * Un segmento aéreo es un vuelo continuo entre dos aeropuertos
 * sin escalas intermedias (un único número de vuelo).
 *
 * `departureAt` y `arrivalAt` son ISO 8601 con offset (ej. `2026-08-15T14:30:00-05:00`).
 * Usamos string en vez de Date porque viaja por la red y atraviesa zonas horarias.
 */
export const SegmentSchema = z.object({
  carrier: IataCarrierCodeSchema,
  flightNumber: z.string().regex(/^\d{1,4}[A-Z]?$/),
  origin: IataAirportCodeSchema,
  destination: IataAirportCodeSchema,
  departureAt: z.string().datetime({ offset: true }),
  arrivalAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().positive(),
  cabin: CabinClassSchema,
  bookingClass: z
    .string()
    .length(1)
    .regex(/^[A-Z]$/),
  aircraft: z.string().min(1).max(10).optional(),
  operatingCarrier: IataCarrierCodeSchema.optional(),

  /**
   * Número de vuelo del operador real cuando difiere del comercializado (codeshare).
   * Sin él, el mismo avión vendido por dos aerolíneas no colisiona en el dedupe: la clave
   * usa `operatingCarrier ?? carrier`, y sin número operado siguen siendo dos vuelos
   * distintos. El dato ya viene de Sabre (`bargain-finder-max-v5.yml:2952`) y hoy se tira.
   */
  operatingFlightNumber: z
    .string()
    .regex(/^\d{1,4}[A-Z]?$/)
    .optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;
