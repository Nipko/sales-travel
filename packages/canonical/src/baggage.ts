import { z } from '@sales-travel/validation';

/** Una franquicia: cuántas piezas y, si el proveedor lo da en kilos, cuánto pesa cada una. */
export const BaggageAllowanceSchema = z.object({
  qty: z.number().int().nonnegative(),
  weightKg: z.number().optional(),
});
export type BaggageAllowance = z.infer<typeof BaggageAllowanceSchema>;

/**
 * Equipaje, con las tres piezas OPCIONALES por separado. Lo usan `Offer.baggage` (la oferta
 * entera) e `Itinerary.baggage` (un trayecto).
 *
 * `undefined` significa «el proveedor no lo informó» y `0` significa «no incluye». Quien pinte
 * esto TIENE que distinguirlos. Ver `Offer.baggage`.
 */
export const BaggageSchema = z.object({
  personalItem: z.number().int().nonnegative().optional(),
  carryOn: BaggageAllowanceSchema.optional(),
  checked: BaggageAllowanceSchema.optional(),
});
export type Baggage = z.infer<typeof BaggageSchema>;
