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
 * Valor JSON arbitrario. Existe para tipar `ProviderRef.raw` sin recurrir a `any` y
 * garantizando que lo que se guarde ahí sobrevive un `JSON.stringify`: la Offer se cachea
 * en Redis y viaja por HTTP, así que un `Date` o una clase se corromperían en silencio.
 */
export type ProviderRawValue =
  | string
  | number
  | boolean
  | null
  | ProviderRawValue[]
  | { [key: string]: ProviderRawValue };

export const ProviderRawValueSchema: z.ZodType<ProviderRawValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ProviderRawValueSchema),
    z.record(ProviderRawValueSchema),
  ]),
);

/**
 * De dónde viene el contenido DENTRO del proveedor: no es el proveedor, es el carril por el
 * que llegó la tarifa.
 *
 * Se valida la FORMA (token en mayúsculas), no el vocabulario de un proveedor concreto: cada
 * ACL nombra sus propios carriles y LATAM hoy no declara ninguno. Cerrarlo como enum obligaría
 * a tocar el modelo canónico cada vez que entre un proveedor nuevo.
 */
export const ProviderContentSourceSchema = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-Z0-9_-]+$/, 'provider content source must be an uppercase token');
export type ProviderContentSource = z.infer<typeof ProviderContentSourceSchema>;

/**
 * Identifica al proveedor que originó la Offer (Amadeus, Travelport, HotelDo, etc).
 * El nombre canónico se asigna en cada ACL en `providers/<name>/`.
 */
export const ProviderRefSchema = z.object({
  name: z.string().min(2).max(40),
  offerRef: z.string().min(1).max(255),

  /** Carril de contenido dentro del proveedor. Sabre: 'ATPCO' | 'NDC' | 'LCC'. */
  source: ProviderContentSourceSchema.optional(),

  /**
   * Identificadores CRUDOS del proveedor, OPACOS para el dominio: los que hay que reenviar de
   * un paso de venta al siguiente (en Sabre la cadena offerId -> offerItemId -> passengerId).
   *
   * Es un objeto y no un string concatenado porque en el peor caso admitido por el contrato de
   * Sabre la codificación con pipes estilo LATAM da 526 caracteres —más del doble de los 255 de
   * `offerRef`— y porque el contenido ATPCO/LCC no trae id reservable en absoluto: hay que
   * transportar el itinerario entero (`FlightDetails.flights` admite 16 vuelos). Ver
   * `docs/sabre/08-seams-integracion-repo.md` §5.4.
   *
   * Reglas: sólo el ACL que las escribió interpreta estas llaves —nunca `packages/domain` ni
   * `apps/`—, y nunca llevan secretos, PAN ni PII: esto viaja al navegador dentro de la Offer.
   */
  raw: z.record(ProviderRawValueSchema).optional(),
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
 * Identidad comercial de una marca tarifaria.
 *
 * `code`/`programCode` son identificadores del proveedor; `name` es la etiqueta que se muestra.
 * Se mantienen separados porque un mismo nombre ("LIGHT", "FLEX") puede repetirse entre
 * aerolíneas y programas, y porque Flight Check identifica algunos programas con un entero.
 */
export const FareBrandSchema = z.object({
  code: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(160).optional(),
  programCode: z.string().min(1).max(80).optional(),
  programId: z.number().int().nonnegative().optional(),
});
export type FareBrand = z.infer<typeof FareBrandSchema>;

/**
 * Tarifa aplicada a uno o más segmentos de la oferta.
 *
 * Round-trip no implica una única familia: Sabre puede devolver una marca distinta por
 * componente/trayecto. `segmentRefs` usa índices sobre todos los segmentos de `itineraries`,
 * aplanados en orden, para conservar esa asociación sin introducir IDs de un proveedor en el
 * dominio canónico.
 */
export const FareComponentSchema = z.object({
  brand: FareBrandSchema.optional(),
  fareBasisCode: z.string().min(1).max(120).optional(),
  bookingClasses: z.array(z.string().min(1).max(20)).min(1).optional(),
  segmentRefs: z.array(z.number().int().nonnegative()).min(1),
  origin: z.string().length(3).optional(),
  destination: z.string().length(3).optional(),
  cabin: CabinClassSchema.optional(),
});
export type FareComponent = z.infer<typeof FareComponentSchema>;

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

  // Pricing waterfall del consolidador, ACOTADO al tenant que consulta. OPCIONAL: lo
  // adjunta la capa de búsqueda tras aplicar la cascada de markups. `total`/`provider`
  // siguen siendo el NETO del proveedor (lo que se reserva).
  //
  // Deliberadamente NO lleva el neto ni el desglose paso a paso: ambos le revelarían a
  // una agencia cuánto gana el consolidador sobre ella. El desglose completo sólo se
  // expone en /pricing/waterfall, que un consolidador consulta sobre su propia red.
  pricing: z
    .object({
      /** Costo para este tenant: neto del proveedor + markup de su red por encima. */
      costMinor: z.number().int(),
      /** Precio de venta al cliente final. */
      finalMinor: z.number().int(),
      /** Margen propio del tenant. No incluye el de sus ancestros. */
      ownMarkupMinor: z.number().int(),
      currency: z.string(),
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

  /**
   * Fuente de verdad para familias por tramo/componente. `fareFamily` se conserva como etiqueta
   * derivada por compatibilidad y sólo debe interpretarse como global cuando todas coinciden.
   */
  fareComponents: z.array(FareComponentSchema).min(1).optional(),

  /**
   * Equipaje, con las tres piezas OPCIONALES por separado.
   *
   * La distinción que sostiene esta forma —y la razón de que fueran obligatorias y ya no lo
   * sean— es **«no lo sabemos» contra «no lo incluye»**. Son cosas distintas y sólo una es una
   * promesa comercial.
   *
   * Con las tres obligatorias, un proveedor que informa la franquicia FACTURADA y no la de mano
   * —el carril ATPCO de Sabre, que es el 100% de sus ofertas— sólo podía elegir entre mentir
   * (`carryOn: 0`, o sea «este billete no lleva equipaje de mano», falso en casi cualquier
   * tarifa) o callarse. Se callaba: 50 de 50 ofertas llegaban con el equipaje descartado y el
   * vendedor sin el dato que decide la venta.
   *
   * Ahora `undefined` significa «el proveedor no lo informó» y `0` significa «no incluye». Quien
   * pinte esto TIENE que distinguirlos: el PDF de la cotización va al cliente final, y ahí un
   * «No incluye» sobre algo que no sabemos es una promesa por escrito que no se puede sostener.
   */
  baggage: z
    .object({
      personalItem: z.number().int().nonnegative().optional(),
      carryOn: z
        .object({ qty: z.number().int().nonnegative(), weightKg: z.number().optional() })
        .optional(),
      checked: z
        .object({ qty: z.number().int().nonnegative(), weightKg: z.number().optional() })
        .optional(),
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

  /**
   * Quién decide `expiresAt`. No es cosmético: es la diferencia entre "esta oferta vence a las
   * 14:32 según la aerolínea" y "nosotros dejamos de fiarnos de ella a las 14:32".
   *
   * Hace falta porque las ofertas ATPCO de Sabre NO traen TTL: `Offer.timeToLive` es requerido
   * en el esquema, pero el objeto `offer` que lo contiene es OPCIONAL y no aparece en el
   * contenido ATPCO (`bargain-finder-max-v5.yml:8794/:8835-8837`; los tres ejemplos oficiales
   * son ATPCO puro y no lo traen). Su `expiresAt` es política NUESTRA —el TTL de caché de
   * búsqueda— y presentarla como dato del proveedor en una cotización por WhatsApp es prometer
   * lo que no se puede cumplir.
   *
   * Ausente = no declarado. Quien lo lea no puede afirmar procedencia; sólo `'provider'` la
   * autoriza. Ver `docs/sabre/11-plan-implementacion.md` §6.2 punto 2.
   */
  expiresAtSource: z.enum(['provider', 'platform-policy']).optional(),
});
export type Offer = z.infer<typeof OfferSchema>;
