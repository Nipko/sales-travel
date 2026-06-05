import { z } from '@sales-travel/validation';
import { HotelStaySchema } from './hotel';
import { ItinerarySchema } from './itinerary';
import { MoneySchema } from './money';
import { PaxTypeSchema } from './pax';
import { CabinClassSchema } from './segment';

/**
 * Tipo de producto que puede vivir en una Offer.
 * Para Ola 1 manejamos flight/hotel/assistance. El resto reservado para olas siguientes.
 */
export const OfferProductTypeSchema = z.enum([
  'flight',
  'hotel',
  'assistance',
  'activity',
  'transfer',
  'car',
  'package',
]);
export type OfferProductType = z.infer<typeof OfferProductTypeSchema>;

/**
 * Identifica al proveedor que originó la Offer (Amadeus, Travelport, HotelDo, etc).
 * El nombre canónico se asigna en cada ACL en `providers/<name>/`.
 */
export const ProviderRefSchema = z.object({
  name: z.string().min(2).max(40),
  offerRef: z.string().min(1).max(255),
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

/** Desglose de precio por pax type (ADT/CHD/INF). */
export const FareBreakdownEntrySchema = z.object({
  paxType: PaxTypeSchema,
  paxCount: z.number().int().min(1),
  basePerPax: MoneySchema,
  taxesPerPax: MoneySchema,
});
export type FareBreakdownEntry = z.infer<typeof FareBreakdownEntrySchema>;

/**
 * Una Offer es **inmutable** y tiene TTL. Representa el precio y disponibilidad
 * que un proveedor garantiza por un tiempo acotado. Para reservar se debe usar
 * `providerRef` antes de que `expiresAt` venza, o re-cotizar.
 *
 * Multi-product: una Offer puede combinar vuelo + hotel (paquete) o ser de un
 * solo producto. `products` declara qué hay adentro.
 */
export const OfferSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  products: z.array(OfferProductTypeSchema).min(1),
  provider: ProviderRefSchema,

  total: MoneySchema,
  baseFare: MoneySchema,
  taxes: MoneySchema,
  fees: MoneySchema.optional(),
  fareBreakdown: z.array(FareBreakdownEntrySchema).optional(),

  // Pricing waterfall del consolidador. OPCIONAL: lo adjunta la capa de búsqueda tras
  // aplicar la cascada de markups. `total`/`provider` siguen siendo el NETO del proveedor
  // (lo que se reserva); `pricing.finalMinor` es el precio de venta al cliente.
  pricing: z
    .object({
      netMinor: z.number().int(),
      finalMinor: z.number().int(),
      totalMarkupMinor: z.number().int(),
      currency: z.string(),
      breakdown: z.array(
        z.object({
          tenantId: z.string(),
          tenantName: z.string(),
          level: z.number().int(),
          ruleType: z.string(),
          addedMinor: z.number().int(),
        }),
      ),
    })
    .optional(),

  itineraries: z.array(ItinerarySchema).optional(),
  accommodations: z.array(HotelStaySchema).optional(),

  fareFamily: z
    .object({
      name: z.string(),
      cabin: CabinClassSchema,
    })
    .optional(),

  baggage: z
    .object({
      personalItem: z.number().int().nonnegative(),
      carryOn: z.object({ qty: z.number().int().nonnegative(), weightKg: z.number().optional() }),
      checked: z.object({ qty: z.number().int().nonnegative(), weightKg: z.number().optional() }),
    })
    .optional(),

  policies: z
    .object({
      changeable: z.boolean(),
      refundable: z.boolean(),
    })
    .optional(),

  fetchedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});
export type Offer = z.infer<typeof OfferSchema>;
