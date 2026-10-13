import { z } from '@sales-travel/validation';
import { MoneySchema } from './money';

/**
 * Catálogo de servicios adicionales de una reserva YA HECHA: maletas, comidas, salas VIP y los
 * cargos que la aerolínea exige cobrar aparte.
 *
 * Es una foto del momento de la consulta, no una promesa: el precio y la disponibilidad se vuelven
 * a comprobar al agregar, y lo que cambió entre medias se rechaza en vez de cobrarse distinto.
 *
 * Ningún campo lleva identificadores del proveedor salvo `serviceOfferItemId`, que es opaco: sólo
 * lo interpreta el ACL que lo escribió. `serviceCode` es el código ATPCO/IATA del servicio (el
 * mismo en cualquier GDS), no un id de Sabre.
 */

/**
 * Para agrupar en pantalla. Vocabulario NUESTRO y cerrado: cada ACL lo deduce de códigos de la
 * industria (grupo ATPCO, motivo de emisión del EMD), nunca del nombre comercial.
 *
 * `FEE` son cargos financieros que la aerolínea exige (p. ej. cargo por emisión): se muestran
 * aparte para que nadie los ofrezca como un servicio que el pasajero eligió.
 */
export const AncillaryCategorySchema = z.enum(['BAGGAGE', 'MEAL', 'LOUNGE', 'PET', 'FEE', 'OTHER']);
export type AncillaryCategory = z.infer<typeof AncillaryCategorySchema>;

/**
 * Lo que cuesta el servicio a UN pasajero.
 *
 * Son tres casos y no dos, como en el mapa de asientos:
 *
 * - `PRICED`: el proveedor dio el precio. `amountMinor: 0` es sin cargo.
 * - `INCLUDED`: el proveedor lo declara sin cargo y por eso no trae desglose de precio.
 * - `NOT_INFORMED`: debía traer precio y el que trajo no se puede leer. **No se vende**: tratarlo
 *   como gratis regala un servicio que la aerolínea cobra al emitir.
 */
export const AncillaryChargeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PRICED'), price: MoneySchema }).strict(),
  z.object({ type: z.literal('INCLUDED') }).strict(),
  z.object({ type: z.literal('NOT_INFORMED') }).strict(),
]);
export type AncillaryCharge = z.infer<typeof AncillaryChargeSchema>;

export const AncillaryPassengerOfferSchema = z
  .object({
    /**
     * Índice base cero del pasajero en la orden: el mismo orden con el que se reservó (adultos,
     * niños, infantes) y el que recibe `addAncillaries`.
     */
    passengerIndex: z.number().int().nonnegative(),
    charge: AncillaryChargeSchema,
  })
  .strict();
export type AncillaryPassengerOffer = z.infer<typeof AncillaryPassengerOfferSchema>;

/**
 * Por qué un servicio se muestra pero no se puede agregar desde la plataforma.
 *
 * - `DISPLAY_ONLY`: el proveedor lo marca sólo para mostrar.
 * - `CONTACT_AIRLINE`: se compra hablando con la aerolínea.
 * - `NO_BOOKING_REQUIRED`: no hay nada que reservar (ya viene con la tarifa).
 * - `REQUIRES_DETAILS`: exige datos del pasajero (texto libre o estructurado) que esta versión no
 *   recoge; agregarlo sin ellos falla.
 * - `PRICE_NOT_INFORMED`: al menos un pasajero tiene precio ilegible.
 * - `UNSUPPORTED`: forma que el ACL todavía no sabe agregar (p. ej. un paquete de servicios).
 */
export const AncillaryNotSellableReasonSchema = z.enum([
  'DISPLAY_ONLY',
  'CONTACT_AIRLINE',
  'NO_BOOKING_REQUIRED',
  'REQUIRES_DETAILS',
  'PRICE_NOT_INFORMED',
  'UNSUPPORTED',
]);
export type AncillaryNotSellableReason = z.infer<typeof AncillaryNotSellableReasonSchema>;

export const AncillaryWeightSchema = z
  .object({
    value: z.number().int().positive(),
    unit: z.enum(['KG', 'LB']),
  })
  .strict();
export type AncillaryWeight = z.infer<typeof AncillaryWeightSchema>;

export const AncillaryOfferSchema = z
  .object({
    /** Opaco. Es lo que `addAncillaries` recibe de vuelta; fija el precio que se vio. */
    serviceOfferItemId: z.string().min(1).max(255),
    category: AncillaryCategorySchema,
    /** Nombre comercial que da la aerolínea. Texto para mostrar, nunca para decidir. */
    name: z.string().min(1).max(160),
    /** Código ATPCO del servicio (sub code): `0C3`, `0B5`… */
    serviceCode: z.string().regex(/^[0-9A-Z]{3}$/, 'service code must be an ATPCO sub code'),
    airlineCode: z.string().regex(/^[A-Z0-9]{2}$/, 'airline code must be two IATA characters'),
    /** Índices sobre `AncillaryCatalog.segments`: los tramos que cubre una sola compra. */
    segmentRefs: z.array(z.number().int().nonnegative()).min(1),
    /** Una entrada por pasajero que lo puede comprar, con su precio. */
    passengers: z.array(AncillaryPassengerOfferSchema).min(1),
    /** Unidades que incluye una compra (p. ej. dos maletas). */
    quantity: z.number().int().positive(),
    weights: z.array(AncillaryWeightSchema),
    /** Ausente = el proveedor no lo dijo. */
    refundable: z.boolean().optional(),
    sellable: z.boolean(),
    notSellableReason: AncillaryNotSellableReasonSchema.optional(),
  })
  .strict()
  .superRefine((offer, ctx) => {
    if (offer.sellable === (offer.notSellableReason !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a sellable offer has no reason and a non-sellable one has exactly one',
        path: ['notSellableReason'],
      });
    }
    const notInformed = offer.passengers.some((entry) => entry.charge.type === 'NOT_INFORMED');
    if (offer.sellable && notInformed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an offer with an unreadable price cannot be sellable',
        path: ['passengers'],
      });
    }
    if (offer.notSellableReason === 'PRICE_NOT_INFORMED' && !notInformed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PRICE_NOT_INFORMED needs at least one passenger without a readable price',
        path: ['notSellableReason'],
      });
    }
    const indexes = offer.passengers.map((entry) => entry.passengerIndex);
    if (new Set(indexes).size !== indexes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'one entry per passenger',
        path: ['passengers'],
      });
    }
    if (new Set(offer.segmentRefs).size !== offer.segmentRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'segment refs must be unique',
        path: ['segmentRefs'],
      });
    }
  });
export type AncillaryOffer = z.infer<typeof AncillaryOfferSchema>;

/**
 * Un tramo de la reserva tal como lo devuelve el proveedor al pedir el catálogo. La hora es LOCAL
 * del aeropuerto y sin zona, que es como la da el GDS: no se le inventa un desfase.
 */
export const AncillarySegmentSchema = z
  .object({
    origin: z.string().regex(/^[A-Z]{3}$/),
    destination: z.string().regex(/^[A-Z]{3}$/),
    departureAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/),
    carrier: z.string().regex(/^[A-Z0-9]{2}$/),
    flightNumber: z.string().regex(/^\d{1,4}[A-Z]?$/),
  })
  .strict();
export type AncillarySegment = z.infer<typeof AncillarySegmentSchema>;

/**
 * Lo que se le puede ofrecer al pasajero de una reserva.
 *
 * Un catálogo vacío es una respuesta válida —la aerolínea no publica servicios para esa reserva— y
 * lleva un aviso, para que nadie lo confunda con «ya tiene todo».
 */
export const AncillaryCatalogSchema = z
  .object({
    segments: z.array(AncillarySegmentSchema).min(1),
    offers: z.array(AncillaryOfferSchema),
    warnings: z.array(z.string().min(1).max(80)),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    catalog.offers.forEach((offer, index) => {
      if (ids.has(offer.serviceOfferItemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'serviceOfferItemId must be unique in the catalog',
          path: ['offers', index, 'serviceOfferItemId'],
        });
      }
      ids.add(offer.serviceOfferItemId);
      if (offer.segmentRefs.some((ref) => ref >= catalog.segments.length)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'segment ref out of range',
          path: ['offers', index, 'segmentRefs'],
        });
      }
    });
  });
export type AncillaryCatalog = z.infer<typeof AncillaryCatalogSchema>;
