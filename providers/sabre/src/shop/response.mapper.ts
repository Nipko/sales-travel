import {
  ItinerarySchema,
  Money,
  OfferSchema,
  PaxTypeSchema,
  SegmentSchema,
  type CabinClass,
  type FareBreakdownEntry,
  type FareComponent,
  type Itinerary,
  type Offer,
  type ProviderRawValue,
  type Segment,
} from '@sales-travel/canonical';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Mapper de `groupedItineraryResponse` (Bargain Finder Max v5) al modelo canónico — **rama ATPCO**.
 *
 * Las rutas de campo de este archivo están verificadas contra
 * `docs/sabre/evidence/specs/bargain-finder-max-v5.yml` y contra sus **tres ejemplos de respuesta
 * oficiales** (`:139-591`, `:678-1355`, `:1466-2308`), extraídos tal cual a `src/__fixtures__/`.
 * El mapa de campos completo está en docs/sabre/02 §7.
 *
 * ## Rama NDC: NO está aquí, y es deliberado
 *
 * BFM devuelve dos carriles en la misma respuesta. El de NDC se distingue por
 * `pricingInformation.distributionModel === 'NDC'` (`v5.yml:8813-8821`) y por el objeto
 * `pricingInformation.offer` (`:8835-8837`, _"NDC Offer related data"_). **Ese carril se descarta
 * aquí con un warning explícito**, no se mapea con las reglas de ATPCO: no existe ni un solo
 * ejemplo oficial de respuesta NDC y la cadena de identificadores reservables
 * (`offerId` → `offerItemId` → `passengerId`) no está verificada contra nada. Mapearlo "por
 * parecido" produciría ofertas que se muestran y no se pueden reservar.
 *
 * El punto de extensión es {@link mapPricingInformation}: cuando la Fase 0 entregue
 * `shop/v5-ndc-roundtrip-200.json`, la rama NDC entra ahí y {@link resolveOfferExpiry} ya sabe
 * leer su `timeToLive` real. Ver docs/sabre/11 §6.2 y §6.3 punto 6.
 */

/**
 * TTL de la oferta ATPCO. **Es política nuestra, no dato del proveedor.**
 *
 * `Offer.timeToLive` es requerido en el esquema de Sabre (`v5.yml:8226-8232`) pero el objeto
 * `offer` que lo contiene es OPCIONAL en `PricingInformationType` (`:8835-8837`, sin lista
 * `required` en `:8794`) y **no viene en contenido ATPCO**: los tres ejemplos oficiales son ATPCO
 * puro y no traen `offer`, `timeToLive`, `distributionModel` ni `source` ni una sola vez.
 *
 * 90 s es el TTL de la caché de búsqueda de la plataforma (`apps/api/src/search/search.service.ts`,
 * `SEARCH_CACHE_TTL_SECONDS`). Decir "vence a las 14:32" cuando lo que ocurre es "dejamos de
 * fiarnos a las 14:32" es prometer en una cotización por WhatsApp algo que la aerolínea no ha
 * prometido; por eso viaja junto a `expiresAtSource: 'platform-policy'` (docs/sabre/11 §6.2 punto 2).
 */
export const SABRE_ATPCO_OFFER_TTL_SECONDS = 90;

/** Nombre del proveedor en `ProviderRef.name`. Debe coincidir con el slug del ACL. */
export const SABRE_PROVIDER_NAME = 'sabre';

/**
 * Carril supuesto cuando la respuesta no lo declara. `distributionModel` y `offer.source` son
 * ambos marcadores de NDC; su ausencia simultánea sólo ocurre en contenido ATPCO.
 */
export const SABRE_DEFAULT_CONTENT_SOURCE = 'ATPCO';

/**
 * Cabinas de Sabre → cabinas canónicas. El enum de respuesta no está cerrado en el contrato, así
 * que un código desconocido no se adivina: se descarta la oferta con warning.
 * `Y→economy`, `S→premium_economy`, `C`/`J→business`, `F`/`P→first` (docs/sabre/02 §7.2).
 */
const CABIN_BY_SABRE_CODE: Readonly<Record<string, CabinClass>> = {
  Y: 'economy',
  W: 'economy',
  S: 'premium_economy',
  C: 'business',
  J: 'business',
  F: 'first',
  P: 'first',
};

/**
 * `passengerType` es `[A-Z][A-Z0-9]{2}` **sin enum** (`v5.yml:8400`): el vocabulario ATPCO es
 * abierto. Esta tabla es regla NUESTRA para encajar en `PaxTypeSchema`, no algo que el contrato
 * declare, y por eso un código fuera de ella **no se fuerza a ADT**: se descarta la línea del
 * desglose con warning. Etiquetar mal un pax type falsea el precio por pasajero.
 */
const CHILD_BY_AGE_PTC = /^C\d{2}$/;
const CHILD_PTC = new Set(['CNN', 'CHD', 'CLD']);
const INFANT_PTC = new Set(['INF', 'INS', 'INN']);

/** `HH:MM:SS` con offset obligatorio, que es lo que `SegmentSchema` exige. */
const TIME_WITH_OFFSET = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Tolerancia del invariante de precio: un céntimo. Ver {@link resolveBaseFare}. */
const MONEY_TOLERANCE_MAJOR = 0.01;

// ---------------------------------------------------------------------------
// Zod en el borde: la respuesta del proveedor es input externo (CLAUDE.md)
// ---------------------------------------------------------------------------

const SabreEndpointSchema = z.object({
  airport: z.string().optional(),
  time: z.string().optional(),
  /** Sólo en `Arrival` (`v5.yml:2524`): días entre la llegada y la salida del propio segmento. */
  dateAdjustment: z.number().int().optional(),
});

const SabreScheduleDescSchema = z.object({
  id: z.number().optional(),
  stopCount: z.number().int().optional(),
  elapsedTime: z.number().int().optional(),
  departure: SabreEndpointSchema.optional(),
  arrival: SabreEndpointSchema.optional(),
  carrier: z
    .object({
      marketing: z.string().optional(),
      marketingFlightNumber: z.number().optional(),
      operating: z.string().optional(),
      operatingFlightNumber: z.number().optional(),
      equipment: z.object({ code: z.string().optional() }).optional(),
    })
    .optional(),
});

const SabreLegDescSchema = z.object({
  id: z.number().optional(),
  elapsedTime: z.number().int().optional(),
  schedules: z
    .array(
      z.object({
        ref: z.number(),
        /** `v5.yml:9102`, default 0. Lo que empuja al día siguiente la escala de un vuelo nocturno. */
        departureDateAdjustment: z.number().int().optional(),
      }),
    )
    .optional(),
});

const SabreBaggageAllowanceDescSchema = z.object({
  id: z.number().optional(),
  pieceCount: z.number().int().optional(),
  weight: z.number().optional(),
  unit: z.string().optional(),
  description1: z.string().optional(),
});

const SabreFareComponentDescSchema = z.object({
  id: z.number().optional(),
  cabinCode: z.string().optional(),
  fareBasisCode: z.string().optional(),
  /**
   * La marca tarifaria, donde de verdad viaja en el contenido ATPCO (`FareComponentType.brand` →
   * `BrandType`, `v5.yml:2857`).
   *
   * `pricingInformation.brand` es un string plano que existe en el contrato y llega VACÍO en
   * estas respuestas. Mientras sólo leíamos ése, `conMarca` daba 0 en las 44 ofertas aunque el
   * propio Sabre declaraba `brandsOnAnyMarket: true` en las 44: las marcas estaban llegando y las
   * ignorábamos por mirar el sitio equivocado.
   */
  brand: z
    .object({
      brandName: z.string().optional(),
      code: z.string().optional(),
      programCode: z.string().optional(),
    })
    .optional(),
});

const SabreTotalFareSchema = z.object({
  totalPrice: z.number(),
  totalTaxAmount: z.number(),
  currency: z.string(),
  equivalentAmount: z.number().optional(),
  equivalentCurrency: z.string().optional(),
  bookingFeeAmount: z.number().optional(),
  creditCardFeeAmount: z.number().optional(),
  serviceFeeAmount: z.number().optional(),
  serviceFeeTax: z.number().optional(),
  airExtrasAmount: z.number().optional(),
});

const SabrePassengerTotalFareSchema = z.object({
  totalFare: z.number(),
  totalTaxAmount: z.number(),
  currency: z.string(),
  equivalentAmount: z.number().optional(),
  equivalentCurrency: z.string().optional(),
});

const SabrePenaltiesInfoSchema = z.object({
  penalties: z
    .array(
      z.object({
        type: z.string().optional(),
        applicability: z.string().optional(),
        changeable: z.boolean().optional(),
        refundable: z.boolean().optional(),
      }),
    )
    .optional(),
});

const SabrePassengerInfoSchema = z.object({
  passengerType: z.string().optional(),
  /** CANTIDAD, no ordinal (docs/sabre/02 §7.2). */
  passengerNumber: z.number().int().optional(),
  nonRefundable: z.boolean().optional(),
  fareComponents: z
    .array(
      z.object({
        ref: z.number().optional(),
        beginAirport: z.string().optional(),
        endAirport: z.string().optional(),
        segments: z
          .array(
            z.object({
              segment: z
                .object({
                  bookingCode: z.string().optional(),
                  cabinCode: z.string().optional(),
                  seatsAvailable: z.number().int().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  passengerTotalFare: SabrePassengerTotalFareSchema.optional(),
  penaltiesInfo: SabrePenaltiesInfoSchema.optional(),
  baggageInformation: z
    .array(
      z.object({
        provisionType: z.string().optional(),
        allowance: z.object({ ref: z.number() }).optional(),
      }),
    )
    .optional(),
});

const SabrePricingInformationSchema = z.object({
  brand: z.string().optional(),
  /**
   * «Al menos una de las piernas de este itinerario TIENE marca» (`v5.yml:8805`).
   *
   * Es la única señal que separa dos diagnósticos que se ven idénticos desde fuera y exigen
   * acciones opuestas:
   *
   * - `false` en todo → el contenido no tiene marcas. Las aerolíneas de esa ruta no publican
   *   tarifas de marca a esa PCC, y no hay nada que habilitar.
   * - `true` con `brand` ausente → las marcas EXISTEN y no nos llegan. Eso sí es un alta
   *   comercial pendiente (el `MIP/PROCESS` que rechaza el upsell).
   *
   * Sin este campo, «no veo tipos de tarifa» sólo se podía atribuir por eliminación, y una
   * conversación con Sabre para habilitar algo que igual no existe cuesta semanas.
   */
  brandsOnAnyMarket: z.boolean().optional(),
  distributionModel: z.string().optional(),
  pricingSubsource: z.string().optional(),
  pseudoCityCode: z.string().optional(),
  cached: z
    .object({
      timeToLive: z.number().int().optional(),
      hoursSinceCreation: z.number().int().optional(),
    })
    .optional(),
  offer: z
    .object({
      offerId: z.string().optional(),
      source: z.string().optional(),
      timeToLive: z.number().int().optional(),
    })
    .optional(),
  penaltiesInfo: SabrePenaltiesInfoSchema.optional(),
  fare: z
    .object({
      totalFare: SabreTotalFareSchema.optional(),
      validatingCarrierCode: z.string().optional(),
      lastTicketDate: z.string().optional(),
      lastTicketTime: z.string().optional(),
      offerItemId: z.string().optional(),
      passengerInfoList: z
        .array(z.object({ passengerInfo: SabrePassengerInfoSchema.optional() }))
        .optional(),
    })
    .optional(),
});

const SabreItineraryGroupSchema = z.object({
  groupDescription: z
    .object({
      legDescriptions: z
        .array(
          z.object({
            departureDate: z.string(),
            departureLocation: z.string().optional(),
            arrivalLocation: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  itineraries: z
    .array(
      z.object({
        id: z.number().optional(),
        pricingSource: z.string().optional(),
        legs: z
          .array(z.object({ ref: z.number(), departureDate: z.string().optional() }))
          .optional(),
        pricingInformation: z.array(SabrePricingInformationSchema).optional(),
      }),
    )
    .optional(),
});

/**
 * Sobre de la respuesta. `required: [version, messages]` (`v5.yml:3806`).
 *
 * `version` se coacciona a string porque su único uso es diagnóstico y un `6.9` numérico no debe
 * tumbar una búsqueda entera. `messages[].text` **no se recoge**: es texto libre del proveedor y
 * este objeto acaba en logs (RNF-07).
 */
export const SabreGroupedItineraryResponseSchema = z.object({
  groupedItineraryResponse: z.object({
    version: z.union([z.string(), z.number()]).transform(String),
    messages: z.array(
      z.object({
        severity: z.string().optional(),
        type: z.string().optional(),
        code: z.string().optional(),
        numberOfOccurences: z.number().int().optional(),
      }),
    ),
    statistics: z
      .object({
        itineraryCount: z.number().int().optional(),
        legMissed: z.number().int().optional(),
        soldOut: z.number().int().optional(),
        numberOfPccsProcessed: z.number().int().optional(),
      })
      .optional(),
    scheduleDescs: z.array(SabreScheduleDescSchema).optional(),
    legDescs: z.array(SabreLegDescSchema).optional(),
    baggageAllowanceDescs: z.array(SabreBaggageAllowanceDescSchema).optional(),
    fareComponentDescs: z.array(SabreFareComponentDescSchema).optional(),
    itineraryGroups: z.array(SabreItineraryGroupSchema).optional(),
  }),
});

type SabreGroupedItineraryResponse = z.infer<typeof SabreGroupedItineraryResponseSchema>;
type SabrePricingInformation = z.infer<typeof SabrePricingInformationSchema>;
type SabrePassengerInfo = z.infer<typeof SabrePassengerInfoSchema>;
type SabreScheduleDesc = z.infer<typeof SabreScheduleDescSchema>;
type SabreLegDesc = z.infer<typeof SabreLegDescSchema>;
type SabreItineraryGroup = z.infer<typeof SabreItineraryGroupSchema>;
type SabreItineraryNode = NonNullable<SabreItineraryGroup['itineraries']>[number];

// ---------------------------------------------------------------------------
// Contrato de salida
// ---------------------------------------------------------------------------

/**
 * Códigos de warning. Son un enum y no texto libre porque el fan-out los agrega y la UI los
 * traduce: un `string` suelto no se puede contar ni alertar.
 */
export type SabreMapWarningCode =
  | 'ndc-content-skipped'
  | 'pax-base-fare-derived'
  | 'offer-base-fare-derived'
  | 'pax-type-unmapped'
  | 'pax-count-missing'
  | 'leg-count-mismatch'
  | 'leg-ref-unresolved'
  | 'schedule-ref-unresolved'
  | 'departure-date-conflict'
  | 'missing-utc-offset'
  | 'segment-invalid'
  | 'itinerary-invalid'
  | 'offer-invalid'
  | 'priced-segment-missing'
  | 'baggage-not-mapped'
  | 'currency-mismatch'
  | 'provider-message'
  | 'provider-degraded';

/** Un problema de mapeo. Sin texto libre del proveedor y sin PII: esto se loguea. */
export interface SabreMapWarning {
  readonly code: SabreMapWarningCode;
  /** Ruta dentro de la respuesta, con índices. Ej. `itineraryGroups[0].itineraries[2]`. */
  readonly path: string;
  /** Dato acotado y no sensible (un código de cabina, un PTC, un delta numérico). */
  readonly detail?: string;
}

export interface SabreShopMapResult {
  readonly offers: Offer[];
  readonly warnings: readonly SabreMapWarning[];
  /** `true` si Sabre declaró degradación: mensaje no-`Info`, `legMissed` o `soldOut`. */
  readonly degraded: boolean;
  readonly statistics?: {
    readonly itineraryCount?: number;
    readonly legMissed?: number;
    readonly soldOut?: number;
    readonly numberOfPccsProcessed?: number;
  };
}

export interface SabreShopMapContext {
  /** Tenant dueño de la búsqueda. UUID: `OfferSchema.tenantId` lo exige. */
  readonly tenantId: string;
  /** ISO 8601 con offset. Default: ahora. Se inyecta para que los tests sean deterministas. */
  readonly fetchedAt?: string;
  /** TTL de política propia para el contenido ATPCO. Default {@link SABRE_ATPCO_OFFER_TTL_SECONDS}. */
  readonly offerTtlSeconds?: number;
  /**
   * Moneda PEDIDA en la búsqueda (la del tenant, la misma que viajó en
   * `PriceRequestInformation.CurrencyCode`). Las ofertas que vuelvan en otra se descartan con
   * warning `currency-mismatch`.
   *
   * Por qué descartar y no convertir: convertir exige una tasa, y no tenemos ninguna que sea
   * del proveedor ni contratada — una tasa inventada convierte un precio real en uno que nadie
   * puede cobrar. Es la línea de docs/sabre/02 §11 riesgo 12: *"nunca convertir nosotros el
   * precio de venta"*.
   *
   * OPCIONAL, y sin ella NO se filtra nada: no hay moneda de referencia contra la que comparar.
   * Si viene un valor que no es ISO-4217 de tres letras tampoco se filtra, por lo mismo. Quien
   * quiera la defensa tiene que pasar la moneda ya validada (en la plataforma la valida
   * `FlightSearchCriteriaSchema` en el borde HTTP).
   */
  readonly currency?: string;
}

/**
 * La respuesta no encaja con el contrato de BFM v5. Es distinto de `SabreApiError`: no hubo fallo
 * del proveedor, hubo un sobre que no podemos leer. El mensaje lleva **rutas y códigos de issue de
 * Zod, nunca valores** — un payload de Sabre puede arrastrar nombres de pasajero.
 */
export class SabreShopMappingError extends Error {
  constructor(readonly issuePaths: readonly string[]) {
    super(`respuesta de Sabre fuera de contrato (${issuePaths.join(', ') || '<root>'})`);
    this.name = 'SabreShopMappingError';
  }
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export function mapSabreShopResponse(raw: unknown, ctx: SabreShopMapContext): SabreShopMapResult {
  const parsed = SabreGroupedItineraryResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreShopMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }

  const warnings: SabreMapWarning[] = [];
  const body = parsed.data.groupedItineraryResponse;
  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();
  const ttlSeconds = ctx.offerTtlSeconds ?? SABRE_ATPCO_OFFER_TTL_SECONDS;
  const expectedCurrency = normalizeCurrency(ctx.currency);

  const degraded = collectDegradation(body, warnings);
  const dicts: Dictionaries = {
    schedules: indexById(body.scheduleDescs),
    legs: indexById(body.legDescs),
    baggage: indexById(body.baggageAllowanceDescs),
    fareComponents: indexById(body.fareComponentDescs),
  };

  const offers: Offer[] = [];
  const groups = body.itineraryGroups ?? [];
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    if (!group) continue;
    const itineraries = group.itineraries ?? [];
    for (let n = 0; n < itineraries.length; n += 1) {
      const itinerary = itineraries[n];
      if (!itinerary) continue;
      const pricings = itinerary.pricingInformation ?? [];
      for (let p = 0; p < pricings.length; p += 1) {
        const pricing = pricings[p];
        if (!pricing) continue;
        const path = `itineraryGroups[${g}].itineraries[${n}].pricingInformation[${p}]`;
        const offer = mapPricingInformation({
          pricing,
          itinerary,
          group,
          dicts,
          ctx: { tenantId: ctx.tenantId },
          fetchedAt,
          ttlSeconds,
          path,
          warnings,
        });
        if (!offer) continue;
        if (!hasExpectedCurrency(offer, expectedCurrency, warnings, path)) continue;
        offers.push(offer);
      }
    }
  }

  const statistics = body.statistics;
  return statistics === undefined
    ? { offers, warnings, degraded }
    : { offers, warnings, degraded, statistics };
}

/**
 * ¿La oferta está en la moneda que se pidió?
 *
 * Sabre cotiza en la moneda que dicte el punto de venta salvo que se le pida otra, y
 * `PriceRequestInformation.CurrencyCode` —que sí se manda (ver `request.builder.ts`)— gana sobre
 * el PCC **como preferencia declarada en el contrato**, no como garantía observada: los tres
 * ejemplos oficiales de respuesta vuelven en USD. Un PCC de certificación puede devolver
 * cualquier moneda, así que la petición no puede ser la única defensa.
 *
 * Descartar y no marcar: una oferta que el vendedor no puede cotizar en la moneda de su agencia
 * no es producto, y dejarla en la lista rompe además el orden por precio —`BRL 1.286` se lee como
 * más barato que `COP 859.100`— para todas las demás. Se descarta con warning, que es lo que
 * hace visible el descuadre en vez de esconderlo.
 *
 * `expected === null` (nadie declaró moneda) ⇒ pasa todo: sin referencia no hay nada que afirmar.
 */
function hasExpectedCurrency(
  offer: Offer,
  expected: string | null,
  warnings: SabreMapWarning[],
  path: string,
): boolean {
  if (expected === null) return true;
  const devuelta = offer.total.currency;
  if (devuelta === expected) return true;
  // Sólo códigos de moneda: no es PII y es lo único que hace accionable el warning (RNF-07).
  warnings.push({ code: 'currency-mismatch', path, detail: `${expected}!=${devuelta}` });
  return false;
}

// ---------------------------------------------------------------------------
// Diccionarios de la raíz
// ---------------------------------------------------------------------------

interface Dictionaries {
  readonly schedules: ReadonlyMap<number, SabreScheduleDesc>;
  readonly legs: ReadonlyMap<number, SabreLegDesc>;
  readonly baggage: ReadonlyMap<number, z.infer<typeof SabreBaggageAllowanceDescSchema>>;
  readonly fareComponents: ReadonlyMap<number, z.infer<typeof SabreFareComponentDescSchema>>;
}

function indexById<T extends { id?: number | undefined }>(
  items: readonly T[] | undefined,
): ReadonlyMap<number, T> {
  const map = new Map<number, T>();
  for (const item of items ?? []) {
    if (typeof item.id === 'number') map.set(item.id, item);
  }
  return map;
}

/**
 * `messages` es obligatorio y un `severity` distinto de `Info` es degradación parcial que hay que
 * propagar, no ignorar; `statistics.legMissed`/`soldOut` son el "te devolví menos de lo que había"
 * explícito de Sabre (docs/sabre/02 §7.5). Los `severity: 'Error'` ya los convierte en
 * `SabreApiError` el cliente HTTP (`classifySabreEnvelope`): aquí sólo se anota.
 */
function collectDegradation(
  body: SabreGroupedItineraryResponse['groupedItineraryResponse'],
  warnings: SabreMapWarning[],
): boolean {
  let degraded = false;
  for (let i = 0; i < body.messages.length; i += 1) {
    const message = body.messages[i];
    const severity = message?.severity;
    if (severity === undefined || severity.toLowerCase() === 'info') continue;
    degraded = true;
    warnings.push({
      code: 'provider-message',
      path: `messages[${i}]`,
      detail: `${severity}/${message?.type ?? '?'}/${message?.code ?? '?'}`,
    });
  }
  const stats = body.statistics;
  const legMissed = stats?.legMissed ?? 0;
  const soldOut = stats?.soldOut ?? 0;
  if (legMissed > 0 || soldOut > 0) {
    degraded = true;
    warnings.push({
      code: 'provider-degraded',
      path: 'statistics',
      detail: `legMissed=${legMissed} soldOut=${soldOut}`,
    });
  }
  return degraded;
}

// ---------------------------------------------------------------------------
// Una `pricingInformation` = una Offer
// ---------------------------------------------------------------------------

interface MapPricingArgs {
  readonly pricing: SabrePricingInformation;
  readonly itinerary: SabreItineraryNode;
  readonly group: SabreItineraryGroup;
  readonly dicts: Dictionaries;
  readonly ctx: { readonly tenantId: string };
  readonly fetchedAt: string;
  readonly ttlSeconds: number;
  readonly path: string;
  readonly warnings: SabreMapWarning[];
}

/**
 * Punto de extensión de la rama NDC. Hoy descarta el contenido NDC; cuando exista el fixture de la
 * Fase 0, la bifurcación entra justo aquí y el resto del archivo (fechas, diccionarios, invariante
 * de precio) se reutiliza tal cual.
 */
function mapPricingInformation(args: MapPricingArgs): Offer | null {
  const { pricing, itinerary, group, dicts, path, warnings } = args;

  if (isNdcContent(pricing)) {
    warnings.push({
      code: 'ndc-content-skipped',
      path,
      detail: pricing.distributionModel ?? pricing.offer?.source ?? 'offer-present',
    });
    return null;
  }

  const totalFare = pricing.fare?.totalFare;
  if (!totalFare) {
    warnings.push({ code: 'offer-invalid', path, detail: 'fare.totalFare ausente' });
    return null;
  }

  const currency = normalizeCurrency(totalFare.currency);
  if (!currency) {
    warnings.push({ code: 'offer-invalid', path, detail: 'currency inválida' });
    return null;
  }

  const total = Money.fromMajor(totalFare.totalPrice, currency);
  const taxes = Money.fromMajor(totalFare.totalTaxAmount, currency);
  const baseFare = resolveBaseFare({
    declaredAmount: totalFare.equivalentAmount,
    declaredCurrency: totalFare.equivalentCurrency,
    total: totalFare.totalPrice,
    taxAmount: totalFare.totalTaxAmount,
    currency,
    path: `${path}.fare.totalFare`,
    warningCode: 'offer-base-fare-derived',
    warnings,
  });

  const passengers = collectPassengerInfos(pricing);
  const itineraries = buildItineraries({
    itinerary,
    group,
    dicts,
    pricedSegments: buildPricedSegments(passengers[0], dicts),
    path,
    warnings,
  });
  if (!itineraries) return null;

  const fareBreakdown = buildFareBreakdown(passengers, path, warnings);
  const expiry = resolveOfferExpiry(pricing, args.fetchedAt, args.ttlSeconds);
  const fees = resolveFees(totalFare, currency);
  const policies = resolvePolicies(pricing, passengers);
  const fareComponents = resolveFareComponents(passengers, dicts);
  const fareFamily = resolveFareFamily(pricing, itineraries, fareComponents, passengers, dicts);

  // La franquicia FACTURADA, que es la única que el carril ATPCO informa.
  //
  // Antes esto sólo emitía un warning y se descartaba: `Offer.baggage` exigía `personalItem` y
  // `carryOn`, y rellenarlos con cero para cumplir la forma habría afirmado que el billete no
  // lleva equipaje de mano —falso en casi cualquier tarifa—. Ahora los tres son opcionales, así
  // que se publica lo que se sabe y se calla lo que no: `carryOn` y `personalItem` quedan
  // AUSENTES, que significa «el proveedor no lo informó», no «no incluye».
  //
  // El warning se mantiene, con el código honesto: la franquicia de mano sigue sin mapearse y
  // completarla exige decodificar `utaDescs`/`baggageChargeDescs` (docs/sabre/02 §7.4).
  const checked = resolveCheckedBaggage(passengers, dicts);
  if (checked !== null) {
    warnings.push({ code: 'baggage-not-mapped', path, detail: 'sólo franquicia facturada' });
  }

  const candidate = {
    id: randomUUID(),
    tenantId: args.ctx.tenantId,
    products: ['flight'],
    provider: {
      name: SABRE_PROVIDER_NAME,
      offerRef: buildOfferRef(pricing, itinerary, path),
      source: normalizeContentSource(pricing),
      raw: buildProviderRaw(pricing, itinerary, itineraries, passengers, fareComponents, dicts),
    },
    total,
    baseFare,
    taxes,
    ...(fees === null ? {} : { fees }),
    ...(fareBreakdown.length === 0 ? {} : { fareBreakdown }),
    itineraries,
    ...(fareFamily === null ? {} : { fareFamily }),
    ...(fareComponents.length === 0 ? {} : { fareComponents }),
    ...(checked === null ? {} : { baggage: { checked } }),
    ...(policies === null ? {} : { policies }),
    fetchedAt: args.fetchedAt,
    expiresAt: expiry.expiresAt,
    expiresAtSource: expiry.expiresAtSource,
  };

  const validated = OfferSchema.safeParse(candidate);
  if (!validated.success) {
    warnings.push({
      code: 'offer-invalid',
      path,
      detail: validated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
        .join(','),
    });
    return null;
  }
  return validated.data;
}

/**
 * Contenido NDC. `distributionModel` (`v5.yml:8813-8821`) y `offer` (`:8835-8837`) son los dos
 * marcadores del carril; `API` son APIs de aerolínea alojadas y su pricing tiene la misma forma
 * que ATPCO, así que no se descarta.
 */
function isNdcContent(pricing: SabrePricingInformation): boolean {
  if (pricing.distributionModel?.toUpperCase() === 'NDC') return true;
  return pricing.offer?.source?.toUpperCase() === 'NDC';
}

function normalizeContentSource(pricing: SabrePricingInformation): string {
  const declared = pricing.offer?.source ?? pricing.distributionModel;
  if (declared === undefined) return SABRE_DEFAULT_CONTENT_SOURCE;
  const upper = declared.toUpperCase();
  return /^[A-Z0-9_-]{2,20}$/.test(upper) ? upper : SABRE_DEFAULT_CONTENT_SOURCE;
}

// ---------------------------------------------------------------------------
// Precio
// ---------------------------------------------------------------------------

interface ResolveBaseFareArgs {
  readonly declaredAmount: number | undefined;
  readonly declaredCurrency: string | undefined;
  readonly total: number;
  readonly taxAmount: number;
  readonly currency: string;
  readonly path: string;
  readonly warningCode: Extract<
    SabreMapWarningCode,
    'pax-base-fare-derived' | 'offer-base-fare-derived'
  >;
  readonly warnings: SabreMapWarning[];
}

/**
 * La base **no** es `baseFareAmount`.
 *
 * `baseFareAmount` viene en la moneda de PUBLICACIÓN de la tarifa (`PLN` en los ejemplos 1 y 2,
 * `USD` en el 3), distinta de la de `totalTaxAmount`: sumarlos hace saltar `Money.add` por
 * currency mismatch, y "arreglarlo" ignorando la moneda produce un precio en una unidad que no
 * existe. La base vendible es `equivalentAmount`/`equivalentCurrency` (docs/sabre/02 §7.2).
 *
 * Y encima el contrato se contradice a sí mismo: describe el `equivalentAmount` **por pax** como
 * _"includes taxes and additional charges"_ (`v5.yml:8565`) mientras los seis `passengerTotalFare`
 * de los ejemplos oficiales cumplen `equivalentAmount + totalTaxAmount = totalFare` exacto. Se
 * hace caso a los datos, no a la prosa, **pero se comprueba en runtime**: si el invariante no se
 * cumple, la descripción tenía razón para esa respuesta y la base se deriva restando. Callarlo
 * contaría los impuestos dos veces en el desglose por pasajero — un error de precio que no lanza
 * nada y que el cliente ve por pantalla.
 */
function resolveBaseFare(args: ResolveBaseFareArgs): Money {
  const { declaredAmount, declaredCurrency, total, taxAmount, currency } = args;
  const derived = roundMoneyMajor(total - taxAmount);
  const sameCurrency =
    declaredCurrency === undefined || normalizeCurrency(declaredCurrency) === currency;

  if (declaredAmount === undefined || !sameCurrency) {
    args.warnings.push({
      code: args.warningCode,
      path: args.path,
      detail: declaredAmount === undefined ? 'equivalentAmount ausente' : 'moneda distinta',
    });
    return Money.fromMajor(Math.max(derived, 0), currency);
  }

  const gap = roundMoneyMajor(Math.abs(declaredAmount + taxAmount - total));
  if (gap === 0) return Money.fromMajor(declaredAmount, currency);

  // Un céntimo de diferencia es deriva de coma flotante en una conversión de moneda, no la
  // contradicción del contrato (que se equivoca por el importe ENTERO de los impuestos). Se usa el
  // valor derivado —que hace cuadrar `base + impuestos = total` siempre— sin gastar un warning:
  // avisar de esto en cada oferta ahogaría el aviso que sí importa.
  if (gap > MONEY_TOLERANCE_MAJOR) {
    args.warnings.push({
      code: args.warningCode,
      path: args.path,
      detail: `base+tax=${roundMoneyMajor(declaredAmount + taxAmount)} total=${roundMoneyMajor(total)}`,
    });
  }
  return Money.fromMajor(Math.max(derived, 0), currency);
}

/**
 * `Offer.fees` sale sólo de los campos de fee del `totalFare`, que están todos en su `currency`
 * (`v5.yml:9714`, `:9727`, `:9749`; _"Returned only if non-zero value"_). Los `obFeeDescs` NO se
 * suman aquí: son OB fees **por pasajero** con su propio agregado a nivel de oferta
 * (`totalTtypeObFee`), y mezclar los dos niveles los cuenta dos veces.
 */
function resolveFees(
  totalFare: z.infer<typeof SabreTotalFareSchema>,
  currency: string,
): Money | null {
  const sum =
    (totalFare.bookingFeeAmount ?? 0) +
    (totalFare.creditCardFeeAmount ?? 0) +
    (totalFare.serviceFeeAmount ?? 0) +
    (totalFare.serviceFeeTax ?? 0) +
    (totalFare.airExtrasAmount ?? 0);
  if (sum <= 0) return null;
  return Money.fromMajor(sum, currency);
}

function collectPassengerInfos(pricing: SabrePricingInformation): SabrePassengerInfo[] {
  const list = pricing.fare?.passengerInfoList ?? [];
  const out: SabrePassengerInfo[] = [];
  for (const entry of list) {
    if (entry?.passengerInfo) out.push(entry.passengerInfo);
  }
  return out;
}

/**
 * `passengerNumber` es una CANTIDAD y **el mismo `passengerType` puede repetirse** dentro del mismo
 * `passengerInfoList`: el ejemplo 3 oficial trae `ADT ×2` y `ADT ×1` a 1089,46 cada uno, que dan el
 * `totalPrice` 3268,38 del itinerario. Indexar por `paxType` sobrescribiría uno de los dos y
 * dejaría un desglose que no suma el total.
 *
 * Se agrupa **sumando**, y la clave incluye el importe: `FareBreakdownEntry` no exige `paxType`
 * único, así que dos grupos de adultos a precios distintos siguen siendo dos entradas —fundirlos
 * obligaría a promediar, que es inventar dinero.
 */
function buildFareBreakdown(
  passengers: readonly SabrePassengerInfo[],
  path: string,
  warnings: SabreMapWarning[],
): FareBreakdownEntry[] {
  const grouped = new Map<string, FareBreakdownEntry>();

  for (let i = 0; i < passengers.length; i += 1) {
    const info = passengers[i];
    if (!info) continue;
    const entryPath = `${path}.fare.passengerInfoList[${i}]`;

    const paxType = canonicalPaxType(info.passengerType);
    if (paxType === null) {
      warnings.push({
        code: 'pax-type-unmapped',
        path: entryPath,
        detail: info.passengerType ?? 'ausente',
      });
      continue;
    }

    const fare = info.passengerTotalFare;
    if (!fare) continue;
    const currency = normalizeCurrency(fare.currency);
    if (!currency) continue;

    let paxCount = info.passengerNumber;
    if (paxCount === undefined || paxCount < 1) {
      warnings.push({ code: 'pax-count-missing', path: entryPath, detail: String(paxCount ?? '') });
      paxCount = 1;
    }

    const taxesPerPax = Money.fromMajor(fare.totalTaxAmount, currency);
    const basePerPax = resolveBaseFare({
      declaredAmount: fare.equivalentAmount,
      declaredCurrency: fare.equivalentCurrency,
      total: fare.totalFare,
      taxAmount: fare.totalTaxAmount,
      currency,
      path: `${entryPath}.passengerInfo.passengerTotalFare`,
      warningCode: 'pax-base-fare-derived',
      warnings,
    });

    const key = `${paxType}|${basePerPax.amountMinor}|${basePerPax.currency}|${taxesPerPax.amountMinor}|${taxesPerPax.currency}`;
    const existing = grouped.get(key);
    grouped.set(
      key,
      existing
        ? { ...existing, paxCount: existing.paxCount + paxCount }
        : { paxType, paxCount, basePerPax, taxesPerPax },
    );
  }

  return [...grouped.values()];
}

/** `null` = código ATPCO que no sabemos encajar. Nunca se fuerza a ADT. */
export function canonicalPaxType(code: string | undefined): 'ADT' | 'CHD' | 'INF' | null {
  if (code === undefined) return null;
  const upper = code.trim().toUpperCase();
  if (upper === 'ADT') return 'ADT';
  if (CHILD_PTC.has(upper) || CHILD_BY_AGE_PTC.test(upper)) return 'CHD';
  if (INFANT_PTC.has(upper)) return 'INF';
  const parsed = PaxTypeSchema.safeParse(upper);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

export interface SabreOfferExpiry {
  readonly expiresAt: string;
  readonly expiresAtSource: 'provider' | 'platform-policy';
}

/**
 * Sólo `offer.timeToLive` autoriza a decir `'provider'`. Sin él —el caso ATPCO— el vencimiento es
 * el TTL de nuestra caché de búsqueda y se etiqueta `'platform-policy'`. Jamás un TTL inventado
 * presentado como del proveedor (docs/sabre/11 §6.2 punto 2, §6.4).
 */
export function resolveOfferExpiry(
  pricing: { readonly offer?: { readonly timeToLive?: number | undefined } | undefined },
  fetchedAt: string,
  fallbackTtlSeconds: number,
): SabreOfferExpiry {
  const providerTtl = pricing.offer?.timeToLive;
  const base = new Date(fetchedAt).getTime();
  if (typeof providerTtl === 'number' && providerTtl > 0) {
    return {
      expiresAt: new Date(base + providerTtl * 1000).toISOString(),
      expiresAtSource: 'provider',
    };
  }
  return {
    expiresAt: new Date(base + fallbackTtlSeconds * 1000).toISOString(),
    expiresAtSource: 'platform-policy',
  };
}

// ---------------------------------------------------------------------------
// Itinerarios y segmentos
// ---------------------------------------------------------------------------

/** Cabina y clase de reserva de un segmento tarificado, en orden de itinerario. */
interface PricedSegment {
  readonly cabinCode: string | undefined;
  readonly bookingCode: string | undefined;
}

/**
 * Aplana `fareComponents[].segments[]` del PRIMER pasajero. La cabina y la clase de reserva viven
 * en el árbol de PRECIO, no en el de horario (docs/sabre/02 §7.2), y su orden es el del itinerario:
 * lo confirma `baggageInformation[].segments[].id`, que numera los mismos segmentos desde 0 a lo
 * largo de todos los tramos.
 */
function buildPricedSegments(
  passenger: SabrePassengerInfo | undefined,
  dicts: Dictionaries,
): readonly PricedSegment[] {
  const out: PricedSegment[] = [];
  for (const component of passenger?.fareComponents ?? []) {
    const desc = component.ref === undefined ? undefined : dicts.fareComponents.get(component.ref);
    for (const priced of component.segments ?? []) {
      out.push({
        cabinCode: priced.segment?.cabinCode ?? desc?.cabinCode,
        bookingCode: priced.segment?.bookingCode,
      });
    }
  }
  return out;
}

interface BuildItinerariesArgs {
  readonly itinerary: SabreItineraryNode;
  readonly group: SabreItineraryGroup;
  readonly dicts: Dictionaries;
  readonly pricedSegments: readonly PricedSegment[];
  readonly path: string;
  readonly warnings: SabreMapWarning[];
}

/**
 * Un `Itinerary` canónico = un `leg` de Sabre. Round-trip = 2 legs = 2 itineraries.
 *
 * **La fecha del tramo `i` sale de `groupDescription.legDescriptions[i]`, POR POSICIÓN.**
 * `legs[i].ref` apunta a `legDescs[]`, que es otro array con otros índices: en el ejemplo 1 oficial
 * `legs` es `[{ref:2},{ref:1}]` mientras `legDescriptions[0]` es la ida, así que indexar las fechas
 * por `ref` **invierte ida y vuelta** sin lanzar nada. `scheduleDescs` es un diccionario reutilizable
 * entre itinerarios y sus horas no traen fecha; los scripts de Postman que leen `scheduleDescs[0]`
 * y `[1]` a ciegas funcionan con un itinerario y son incorrectos con cincuenta (docs/sabre/02 §7.1 y §7.3).
 */
function buildItineraries(args: BuildItinerariesArgs): Itinerary[] | null {
  const { itinerary, group, dicts, pricedSegments, path, warnings } = args;
  const legRefs = itinerary.legs ?? [];
  const legDescriptions = group.groupDescription?.legDescriptions ?? [];

  if (legRefs.length === 0) {
    warnings.push({ code: 'itinerary-invalid', path, detail: 'legs vacío' });
    return null;
  }
  if (legDescriptions.length !== legRefs.length) {
    warnings.push({
      code: 'leg-count-mismatch',
      path,
      detail: `legs=${legRefs.length} legDescriptions=${legDescriptions.length}`,
    });
  }

  const out: Itinerary[] = [];
  let globalSegmentIndex = 0;

  for (let i = 0; i < legRefs.length; i += 1) {
    const legRef = legRefs[i];
    if (!legRef) return null;
    const legPath = `${path}.legs[${i}]`;

    const baseDate = resolveLegBaseDate(legDescriptions[i]?.departureDate, legRef.departureDate, {
      path: legPath,
      warnings,
    });
    if (baseDate === null) {
      warnings.push({ code: 'itinerary-invalid', path: legPath, detail: 'sin departureDate' });
      return null;
    }

    const leg = dicts.legs.get(legRef.ref);
    if (!leg) {
      warnings.push({ code: 'leg-ref-unresolved', path: legPath, detail: String(legRef.ref) });
      return null;
    }

    const schedules = leg.schedules ?? [];
    if (schedules.length === 0) {
      warnings.push({ code: 'itinerary-invalid', path: legPath, detail: 'schedules vacío' });
      return null;
    }

    const segments: Segment[] = [];
    let stopCountSum = 0;
    let elapsedSum = 0;

    for (let j = 0; j < schedules.length; j += 1) {
      const scheduleRef = schedules[j];
      if (!scheduleRef) return null;
      const schedule = dicts.schedules.get(scheduleRef.ref);
      if (!schedule) {
        warnings.push({
          code: 'schedule-ref-unresolved',
          path: `${legPath}.schedules[${j}]`,
          detail: String(scheduleRef.ref),
        });
        return null;
      }

      const priced = pricedSegments[globalSegmentIndex];
      if (!priced) {
        warnings.push({
          code: 'priced-segment-missing',
          path: `${legPath}.schedules[${j}]`,
          detail: `índice ${globalSegmentIndex}`,
        });
        return null;
      }

      const segment = buildSegment({
        schedule,
        priced,
        baseDate,
        departureDateAdjustment: scheduleRef.departureDateAdjustment ?? 0,
        path: `${legPath}.schedules[${j}]`,
        warnings,
      });
      if (!segment) return null;

      segments.push(segment);
      stopCountSum += schedule.stopCount ?? 0;
      elapsedSum += schedule.elapsedTime ?? 0;
      globalSegmentIndex += 1;
    }

    const totalDurationMinutes = leg.elapsedTime ?? elapsedSum;
    const candidate = {
      segments,
      totalDurationMinutes,
      // Conexiones MÁS escalas técnicas dentro de un mismo número de vuelo: contar sólo
      // `stopCount` se queda corto y contar sólo las conexiones ignora las escalas.
      stops: segments.length - 1 + stopCountSum,
    };
    const validated = ItinerarySchema.safeParse(candidate);
    if (!validated.success) {
      warnings.push({
        code: 'itinerary-invalid',
        path: legPath,
        detail: validated.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
          .join(','),
      });
      return null;
    }
    out.push(validated.data);
  }

  return out;
}

function resolveLegBaseDate(
  fromDescription: string | undefined,
  fromLeg: string | undefined,
  meta: { path: string; warnings: SabreMapWarning[] },
): string | null {
  // `LegDescriptionType.departureDate` es `'2024-04-26'` pero `LegIDType.departureDate` viene como
  // `'2024-05-26T00:00:00.000Z'` (`v5.yml:4250` vs `:4264`): hay que recortar antes de comparar.
  const primary = normalizeIsoDate(fromDescription);
  const secondary = normalizeIsoDate(fromLeg);
  if (primary !== null && secondary !== null && primary !== secondary) {
    meta.warnings.push({
      code: 'departure-date-conflict',
      path: meta.path,
      detail: `${primary} vs ${secondary}`,
    });
  }
  return primary ?? secondary;
}

interface BuildSegmentArgs {
  readonly schedule: SabreScheduleDesc;
  readonly priced: PricedSegment;
  readonly baseDate: string;
  readonly departureDateAdjustment: number;
  readonly path: string;
  readonly warnings: SabreMapWarning[];
}

function buildSegment(args: BuildSegmentArgs): Segment | null {
  const { schedule, priced, baseDate, path, warnings } = args;

  const departureTime = schedule.departure?.time;
  const arrivalTime = schedule.arrival?.time;
  if (departureTime === undefined || arrivalTime === undefined) {
    warnings.push({ code: 'segment-invalid', path, detail: 'sin hora' });
    return null;
  }
  // `.datetime({ offset: true })` es obligatorio en `SegmentSchema`. `Departure.time` documenta
  // `'12:40:00+04:00'` pero `Arrival.time` documenta `'01:05:00'` SIN offset (`v5.yml:3093` vs
  // `:2540`). Si llega sin offset haría falta resolver la zona horaria del aeropuerto —tabla IATA,
  // que este paquete todavía no tiene—; inventar `Z` pondría el vuelo en otra hora, así que se
  // descarta la oferta y se avisa (docs/sabre/02 §7.3).
  if (!TIME_WITH_OFFSET.test(departureTime) || !TIME_WITH_OFFSET.test(arrivalTime)) {
    warnings.push({ code: 'missing-utc-offset', path, detail: 'hora sin offset' });
    return null;
  }

  const departureDate = addDaysToIsoDate(baseDate, args.departureDateAdjustment);
  const arrivalDate = addDaysToIsoDate(departureDate, schedule.arrival?.dateAdjustment ?? 0);

  const cabin = priced.cabinCode === undefined ? undefined : CABIN_BY_SABRE_CODE[priced.cabinCode];
  if (cabin === undefined) {
    warnings.push({ code: 'segment-invalid', path, detail: `cabina ${priced.cabinCode ?? '?'}` });
    return null;
  }

  const carrier = schedule.carrier;
  const durationMinutes = schedule.elapsedTime;
  const candidate = {
    carrier: carrier?.marketing,
    flightNumber: flightNumberToString(carrier?.marketingFlightNumber),
    origin: schedule.departure?.airport,
    destination: schedule.arrival?.airport,
    departureAt: `${departureDate}T${departureTime}`,
    arrivalAt: `${arrivalDate}T${arrivalTime}`,
    durationMinutes,
    cabin,
    bookingClass: priced.bookingCode,
    ...(carrier?.equipment?.code === undefined ? {} : { aircraft: carrier.equipment.code }),
    ...(carrier?.operating === undefined ? {} : { operatingCarrier: carrier.operating }),
    ...(flightNumberToString(carrier?.operatingFlightNumber) === undefined
      ? {}
      : { operatingFlightNumber: flightNumberToString(carrier?.operatingFlightNumber) }),
  };

  const validated = SegmentSchema.safeParse(candidate);
  if (!validated.success) {
    warnings.push({
      code: 'segment-invalid',
      path,
      detail: validated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
        .join(','),
    });
    return null;
  }
  return validated.data;
}

/** `marketingFlightNumber` es `integer` en el contrato (`v5.yml:2943`), string en el nuestro. */
function flightNumberToString(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 0) return undefined;
  return String(value);
}

// ---------------------------------------------------------------------------
// Políticas, marca y referencias
// ---------------------------------------------------------------------------

/**
 * Refundabilidad y cambiabilidad tienen dos fuentes que pueden discrepar. Se prefiere
 * `penaltiesInfo` —que distingue `Before`/`After`— y se cae a `nonRefundable`, el booleano simple
 * que sí viene siempre (docs/sabre/02 §7.4).
 *
 * En los tres ejemplos oficiales `penaltiesInfo` cuelga de `passengerInfo` (`v5.yml:8410`), no de
 * `pricingInformation` (`:8842`, _"Applicable to NDC content"_): se leen las dos, en ese orden.
 */
function resolvePolicies(
  pricing: SabrePricingInformation,
  passengers: readonly SabrePassengerInfo[],
): { changeable: boolean; refundable: boolean } | null {
  const penalties =
    passengers.find((info) => (info.penaltiesInfo?.penalties ?? []).length > 0)?.penaltiesInfo
      ?.penalties ?? pricing.penaltiesInfo?.penalties;

  if (penalties && penalties.length > 0) {
    return {
      changeable: penaltyVerdict(penalties, 'Exchange', 'changeable') ?? false,
      refundable: penaltyVerdict(penalties, 'Refund', 'refundable') ?? false,
    };
  }

  const nonRefundable = passengers.find((info) => info.nonRefundable !== undefined)?.nonRefundable;
  if (nonRefundable === undefined) return null;
  // Sin penalidades sólo sabemos de reembolso. Afirmar `changeable: true` sería inventarlo.
  return { changeable: false, refundable: !nonRefundable };
}

function penaltyVerdict(
  penalties: ReadonlyArray<{ type?: string; applicability?: string } & Record<string, unknown>>,
  type: 'Exchange' | 'Refund',
  flag: 'changeable' | 'refundable',
): boolean | null {
  const ofType = penalties.filter((p) => p.type?.toLowerCase() === type.toLowerCase());
  if (ofType.length === 0) return null;
  // "Reembolsable antes de la salida pero no después" es un caso real: el booleano canónico sólo
  // puede expresar uno de los dos, y el que le importa al vendedor que está cotizando es `Before`.
  const before = ofType.find((p) => p.applicability?.toLowerCase() === 'before');
  const chosen = before ?? ofType[0];
  const value = chosen?.[flag];
  return typeof value === 'boolean' ? value : null;
}

/**
 * El nombre de la marca, de las DOS fuentes que el contrato define, en orden de preferencia.
 *
 * `pricingInformation.brand` primero porque es el campo directo; los `fareComponentDescs` después
 * porque es donde de verdad aparece en el contenido ATPCO. Mirar sólo el primero dejaba
 * `conMarca: 0` con `brandsOnAnyMarket: true` en las 44 ofertas — la marca llegaba y no la
 * leíamos.
 *
 * Del `BrandType` se prefiere `brandName` («Economy Flex») sobre `code` («XX»): lo que se le
 * enseña al vendedor tiene que poder leerse en voz alta a un cliente.
 */
function resolveBrandName(
  pricing: SabrePricingInformation,
  passengers: readonly SabrePassengerInfo[],
  dicts: Dictionaries,
): string | null {
  const directo = pricing.brand?.trim();
  if (directo !== undefined && directo.length > 0) return directo;

  for (const passenger of passengers) {
    for (const component of passenger.fareComponents ?? []) {
      if (component.ref === undefined) continue;
      const desc = dicts.fareComponents.get(component.ref);
      const nombre = desc?.brand?.brandName?.trim() ?? desc?.brand?.code?.trim();
      if (nombre !== undefined && nombre.length > 0) return nombre;
    }
  }
  return null;
}

/**
 * El CÓDIGO de la marca (`MAIN`, `MAINFL`, `I3`…), que es distinto de su nombre.
 *
 * Se publica en `provider.raw` porque no es producto —al vendedor se le enseña «MAIN CABIN
 * FLEXIBLE», no `MAINFL`— sino la llave para pedirle a Sabre **otra** marca del mismo vuelo:
 * `BrandFilters.Brand[{ Code, PreferLevel: 'Unacceptable' }]` excluye la que ya tenemos y
 * devuelve la siguiente. Verificado contra CERT: excluyendo `MAIN`, American pasó de
 * «MAIN CABIN» (no reembolsable) a «MAIN CABIN FLEXIBLE» (reembolsable, +14%).
 *
 * Sin el código no hay escalera: los nombres no sirven para filtrar.
 */
function resolveBrandCode(
  passengers: readonly SabrePassengerInfo[],
  dicts: Dictionaries,
): string | null {
  const codes = new Set<string>();
  for (const passenger of passengers) {
    for (const component of passenger.fareComponents ?? []) {
      if (component.ref === undefined) continue;
      const code = dicts.fareComponents.get(component.ref)?.brand?.code?.trim();
      if (code !== undefined && code.length > 0) codes.add(code);
    }
  }
  // El singular sólo es honesto cuando toda la oferta comparte la misma marca. Una combinación
  // ida/vuelta distinta viaja completa en `fareComponents` y no se aplana a la primera.
  return codes.size === 1 ? [...codes][0]! : null;
}

/**
 * Conserva la identidad tarifaria por componente y su asociación con los segmentos.
 *
 * Se usa el primer pasajero que trae componentes: las marcas y fare basis describen el producto
 * del itinerario, mientras los importes por PTC ya viven en `fareBreakdown`. Duplicar el mismo
 * componente por ADT/CHD haría que la UI mostrara familias repetidas.
 */
function resolveFareComponents(
  passengers: readonly SabrePassengerInfo[],
  dicts: Dictionaries,
): FareComponent[] {
  const passenger = passengers.find((item) => (item.fareComponents?.length ?? 0) > 0);
  if (passenger === undefined) return [];

  const out: FareComponent[] = [];
  let segmentIndex = 0;

  for (const component of passenger.fareComponents ?? []) {
    const desc = component.ref === undefined ? undefined : dicts.fareComponents.get(component.ref);
    const pricedSegments = component.segments ?? [];
    const segmentRefs = pricedSegments.map(() => segmentIndex++);
    if (segmentRefs.length === 0) continue;

    const bookingClasses = [
      ...new Set(
        pricedSegments
          .map((item) => item.segment?.bookingCode?.trim())
          .filter((value): value is string => value !== undefined && value.length > 0),
      ),
    ];
    const cabins = [
      ...new Set(
        pricedSegments
          .map((item) => item.segment?.cabinCode ?? desc?.cabinCode)
          .map((code) => (code === undefined ? undefined : CABIN_BY_SABRE_CODE[code]))
          .filter((value): value is CabinClass => value !== undefined),
      ),
    ];

    const brandName = desc?.brand?.brandName?.trim();
    const brandCode = desc?.brand?.code?.trim();
    const programCode = desc?.brand?.programCode?.trim();
    const hasBrand = [brandName, brandCode, programCode].some(
      (value) => value !== undefined && value.length > 0,
    );
    const fareBasisCode = desc?.fareBasisCode?.trim();
    const origin = normalizeAirport(component.beginAirport);
    const destination = normalizeAirport(component.endAirport);

    out.push({
      segmentRefs,
      ...(hasBrand
        ? {
            brand: {
              ...(brandCode === undefined || brandCode.length === 0 ? {} : { code: brandCode }),
              ...(brandName === undefined || brandName.length === 0 ? {} : { name: brandName }),
              ...(programCode === undefined || programCode.length === 0 ? {} : { programCode }),
            },
          }
        : {}),
      ...(fareBasisCode === undefined || fareBasisCode.length === 0 ? {} : { fareBasisCode }),
      ...(bookingClasses.length === 0 ? {} : { bookingClasses }),
      ...(origin === undefined ? {} : { origin }),
      ...(destination === undefined ? {} : { destination }),
      ...(cabins.length === 1 ? { cabin: cabins[0]! } : {}),
    });
  }

  return out;
}

function resolveFareFamily(
  pricing: SabrePricingInformation,
  itineraries: readonly Itinerary[],
  fareComponents: readonly FareComponent[],
  passengers: readonly SabrePassengerInfo[],
  dicts: Dictionaries,
): { name: string; cabin: CabinClass } | null {
  const directName = pricing.brand?.trim();
  const componentNames = new Set(
    fareComponents
      .map((component) => component.brand?.name ?? component.brand?.code)
      .filter((value): value is string => value !== undefined && value.length > 0),
  );
  // La propiedad singular se conserva sólo cuando no aplana una combinación de marcas. Incluso
  // si Sabre repite un `pricing.brand` global, los componentes son la fuente más específica.
  if (componentNames.size > 1) return null;
  const name =
    directName !== undefined && directName.length > 0
      ? directName
      : componentNames.size === 1
        ? [...componentNames][0]!
        : resolveBrandName(pricing, passengers, dicts);
  if (name === null) return null;
  const componentCabins = new Set(
    fareComponents
      .map((component) => component.cabin)
      .filter((value): value is CabinClass => value !== undefined),
  );
  const cabin =
    componentCabins.size === 1 ? [...componentCabins][0] : itineraries[0]?.segments[0]?.cabin;
  if (cabin === undefined) return null;
  return { name, cabin };
}

function normalizeAirport(value: string | undefined): string | undefined {
  const upper = value?.trim().toUpperCase();
  return upper !== undefined && /^[A-Z]{3}$/.test(upper) ? upper : undefined;
}

/**
 * El contenido ATPCO **no trae identificador reservable**: `offer.offerId` es del carril NDC. Este
 * `offerRef` es un asa hacia esta respuesta, no un token del proveedor; lo reservable viaja en
 * `raw.flights` (docs/sabre/08 §5.4).
 */
function buildOfferRef(
  pricing: SabrePricingInformation,
  itinerary: SabreItineraryNode,
  path: string,
): string {
  const providerId = pricing.offer?.offerId ?? pricing.fare?.offerItemId;
  if (providerId !== undefined && providerId.length > 0) return providerId.slice(0, 255);
  return `atpco:${itinerary.id ?? 'x'}:${path}`.slice(0, 255);
}

function buildProviderRaw(
  pricing: SabrePricingInformation,
  itinerary: SabreItineraryNode,
  itineraries: readonly Itinerary[],
  passengers: readonly SabrePassengerInfo[],
  fareComponents: readonly FareComponent[],
  dicts: Dictionaries,
): Record<string, ProviderRawValue> {
  const flights: ProviderRawValue[] = [];
  for (const leg of itineraries) {
    for (const segment of leg.segments) {
      flights.push({
        carrier: segment.carrier,
        flightNumber: segment.flightNumber,
        origin: segment.origin,
        destination: segment.destination,
        departureAt: segment.departureAt,
        bookingClass: segment.bookingClass,
      });
    }
  }

  const allowances: ProviderRawValue[] = [];
  for (const info of passengers) {
    for (const bag of info.baggageInformation ?? []) {
      if (bag.provisionType !== 'A' || bag.allowance === undefined) continue;
      const desc = dicts.baggage.get(bag.allowance.ref);
      if (!desc) continue;
      allowances.push({
        paxType: info.passengerType ?? null,
        pieceCount: desc.pieceCount ?? null,
        weight: desc.weight ?? null,
        unit: desc.unit ?? null,
      });
    }
  }

  const raw: Record<string, ProviderRawValue> = {
    itineraryId: itinerary.id ?? null,
    pricingSource: itinerary.pricingSource ?? null,
    pricingSubsource: pricing.pricingSubsource ?? null,
    distributionModel: pricing.distributionModel ?? null,
    // Qué PCC produjo la tarifa: es el hilo del modelo consolidador multi-PCC (`v5.yml:8853`).
    pseudoCityCode: pricing.pseudoCityCode ?? null,
    validatingCarrierCode: pricing.fare?.validatingCarrierCode ?? null,
    // Deadline de EMISIÓN, no TTL de la oferta: hasta cuándo se puede emitir una vez reservado.
    lastTicketDate: pricing.fare?.lastTicketDate ?? null,
    lastTicketTime: pricing.fare?.lastTicketTime ?? null,
    // Señal de que el precio no es en vivo (`v5.yml:2891`).
    cachedHoursSinceCreation: pricing.cached?.hoursSinceCreation ?? null,
    // Diagnóstico, no producto: dice si ESTE itinerario tiene marcas disponibles aunque no nos
    // hayan llegado. Ver `SabrePricingInformationSchema.brandsOnAnyMarket`.
    brandsOnAnyMarket: pricing.brandsOnAnyMarket ?? null,
    // La llave de la escalera de marcas. Ver `resolveBrandCode`.
    brandCode: resolveBrandCode(passengers, dicts),
    flights,
  };
  if (fareComponents.length > 0) {
    const rawFareComponents: ProviderRawValue[] = fareComponents.map((component) => ({
      segmentRefs: component.segmentRefs,
      ...(component.brand === undefined
        ? {}
        : {
            brand: {
              ...(component.brand.code === undefined ? {} : { code: component.brand.code }),
              ...(component.brand.name === undefined ? {} : { name: component.brand.name }),
              ...(component.brand.programCode === undefined
                ? {}
                : { programCode: component.brand.programCode }),
              ...(component.brand.programId === undefined
                ? {}
                : { programId: component.brand.programId }),
            },
          }),
      ...(component.fareBasisCode === undefined ? {} : { fareBasisCode: component.fareBasisCode }),
      ...(component.bookingClasses === undefined
        ? {}
        : { bookingClasses: component.bookingClasses }),
      ...(component.origin === undefined ? {} : { origin: component.origin }),
      ...(component.destination === undefined ? {} : { destination: component.destination }),
      ...(component.cabin === undefined ? {} : { cabin: component.cabin }),
    }));
    raw['fareComponents'] = rawFareComponents;
    raw['brandCodes'] = [
      ...new Set(
        fareComponents
          .map((component) => component.brand?.code)
          .filter((value): value is string => value !== undefined),
      ),
    ];
  }
  if (allowances.length > 0) raw['baggageAllowance'] = allowances;
  return raw;
}

/**
 * La franquicia facturada del ADULTO, o `null` si el proveedor no la informó.
 *
 * `provisionType: 'A'` es la franquicia incluida en la tarifa; el resto de tipos son cargos y
 * servicios, que no son «lo que llevás incluido».
 *
 * El peso sólo se publica cuando la unidad es kilos. `unit` también puede venir en libras, y
 * copiar el número a un campo llamado `weightKg` convertiría 50 lb en «50 kg» — el doble de lo
 * que la aerolínea permite, en un dato que el vendedor le lee al cliente.
 */
function resolveCheckedBaggage(
  passengers: readonly SabrePassengerInfo[],
  dicts: Dictionaries,
): { qty: number; weightKg?: number } | null {
  for (const info of passengers) {
    for (const bag of info.baggageInformation ?? []) {
      if (bag.provisionType !== 'A' || bag.allowance === undefined) continue;
      const desc = dicts.baggage.get(bag.allowance.ref);
      if (desc === undefined) continue;

      const kilos = (desc.unit ?? '').trim().toUpperCase().startsWith('K');
      // Una franquicia por PESO no declara piezas: `pieceCount` ausente con peso presente es
      // «una pieza de N kg», que es como la venden las aerolíneas de la región.
      const qty = desc.pieceCount ?? (desc.weight === undefined ? undefined : 1);
      if (qty === undefined) continue;

      return {
        qty,
        ...(kilos && desc.weight !== undefined ? { weightKg: desc.weight } : {}),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/**
 * Aritmética de días sobre `YYYY-MM-DD` en UTC. La fecha civil no lleva zona: hacerla pasar por
 * `new Date('2026-09-11')` local movería el día en medio planeta.
 */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  if (days === 0) return isoDate;
  const parts = isoDate.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function normalizeIsoDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const head = value.slice(0, 10);
  return ISO_DATE.test(head) ? head : null;
}

function normalizeCurrency(value: string | undefined): string | null {
  if (value === undefined) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

/** Los importes de Sabre son `number`: se redondea a 2 decimales antes de comparar invariantes. */
function roundMoneyMajor(value: number): number {
  return Math.round(value * 100) / 100;
}
