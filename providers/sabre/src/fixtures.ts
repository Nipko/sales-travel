import { randomUUID } from 'node:crypto';
import {
  OfferSchema,
  type FareBreakdownEntry,
  type Itinerary,
  type Money,
  type Offer,
  type Segment,
} from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { SABRE_ATPCO_OFFER_TTL_SECONDS, SABRE_PROVIDER_NAME } from './shop/response.mapper';

/**
 * Ofertas sintéticas del modo mock (docs/sabre/11 §6.3 paso 5).
 *
 * Existen para que CI, dev y las demos corran sin credenciales de Sabre. El riesgo que traen es
 * el que ordena todo este archivo: una oferta mock tiene la MISMA forma canónica que una real, y
 * un tenant sin credenciales cae en modo mock en silencio (`isMockMode`). Si además tuviera
 * aspecto de real, un vendedor podría pasarle a un cliente un precio inventado sin enterarse.
 *
 * De ahí las tres marcas deliberadas de abajo —transportista `ZZ`, escala `ZZZ`, `offerRef` con
 * prefijo y `provider.raw.mock = true`—: son la diferencia entre "dato de prueba" y "mentira".
 */

/**
 * Transportista de las ofertas mock. `ZZ` no es una aerolínea con la que se pueda volar: ninguna
 * aerolínea real puede aparecer como emisora de un precio que nos hemos inventado nosotros.
 */
export const SABRE_MOCK_CARRIER = 'ZZ';

/** Punto de conexión de la variante con escala, por la misma razón que {@link SABRE_MOCK_CARRIER}. */
export const SABRE_MOCK_CONNECTION = 'ZZZ';

/** Prefijo del `provider.offerRef`. Reservar contra Sabre con esto falla, que es lo correcto. */
export const SABRE_MOCK_OFFER_REF_PREFIX = 'SABRE-MOCK';

/**
 * Marca en `provider.raw`. Es el punto donde `apps/api` puede decidir, sin conocer este paquete,
 * que una oferta no se cotiza a un cliente final.
 */
export const SABRE_MOCK_RAW_FLAG = 'mock';

export interface SabreMockDeps {
  /** Inyectable para que los tests fijen `fetchedAt`/`expiresAt`. */
  readonly now?: () => number;
  /** Inyectable para que los tests comparen `Offer.id`. */
  readonly uuid?: () => string;
  /** TTL de la política propia. Default {@link SABRE_ATPCO_OFFER_TTL_SECONDS}. */
  readonly offerTtlSeconds?: number;
}

interface MockVariant {
  readonly key: string;
  readonly cabin: Segment['cabin'];
  readonly bookingClass: string;
  readonly fareFamily: string;
  /** Tarifa base por adulto en unidades menores de la moneda pedida. */
  readonly adultBaseMinor: number;
  readonly departureHourUtc: number;
  /** Duración de cada tramo del itinerario, en minutos. Dos entradas = una escala. */
  readonly legMinutes: readonly number[];
  /** Espera en la escala. Se ignora si el itinerario es directo. */
  readonly layoverMinutes: number;
  readonly changeable: boolean;
  readonly refundable: boolean;
}

/**
 * Tres variantes con la misma pinta que devuelve BFM: la barata con escala, la directa de
 * economy y la directa de business. Sirven para que la UI de búsqueda tenga algo que ordenar y
 * filtrar sin credenciales.
 */
const MOCK_VARIANTS: readonly MockVariant[] = [
  {
    key: 'onestop-economy',
    cabin: 'economy',
    bookingClass: 'L',
    fareFamily: 'MOCK BASIC',
    adultBaseMinor: 24_900,
    departureHourUtc: 6,
    legMinutes: [95, 145],
    layoverMinutes: 75,
    changeable: false,
    refundable: false,
  },
  {
    key: 'direct-economy',
    cabin: 'economy',
    bookingClass: 'V',
    fareFamily: 'MOCK FLEX',
    adultBaseMinor: 33_500,
    departureHourUtc: 9,
    legMinutes: [215],
    layoverMinutes: 0,
    changeable: true,
    refundable: false,
  },
  {
    key: 'direct-business',
    cabin: 'business',
    bookingClass: 'J',
    fareFamily: 'MOCK BUSINESS',
    adultBaseMinor: 118_400,
    departureHourUtc: 17,
    legMinutes: [210],
    layoverMinutes: 0,
    changeable: true,
    refundable: true,
  },
];

/** Proporción de la tarifa de adulto por tipo de pasajero. */
const PAX_FARE_RATIO = { ADT: 1, CHD: 0.75, INF: 0.1 } as const;

/** Impuestos como fracción de la base. Cifra redonda a propósito: no imita a ningún mercado. */
const MOCK_TAX_RATE = 0.18;

/**
 * `Offer[]` sintético para los criterios dados.
 *
 * Las ofertas se validan contra `OfferSchema` antes de salir: si una fixture deja de encajar con
 * el modelo canónico, el fallo tiene que aparecer en el test que la construye y no tres capas más
 * arriba. El `ZodError` que lanza aquí es un error nuestro, no un borde externo, y no puede
 * arrastrar datos del proveedor porque la entrada son literales de este archivo.
 */
export function buildMockOffers(
  criteria: FlightSearchCriteria,
  tenantId: string,
  deps: SabreMockDeps = {},
): Offer[] {
  const nowMs = (deps.now ?? Date.now)();
  const uuid = deps.uuid ?? randomUUID;
  const ttlSeconds = deps.offerTtlSeconds ?? SABRE_ATPCO_OFFER_TTL_SECONDS;

  const fetchedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();

  return MOCK_VARIANTS.map((variant) =>
    buildMockOffer({ criteria, tenantId, variant, fetchedAt, expiresAt, uuid }),
  );
}

interface BuildOfferArgs {
  readonly criteria: FlightSearchCriteria;
  readonly tenantId: string;
  readonly variant: MockVariant;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly uuid: () => string;
}

function buildMockOffer(args: BuildOfferArgs): Offer {
  const { criteria, variant, uuid } = args;
  const currency = criteria.currency;

  const itineraries: Itinerary[] = [
    buildMockItinerary({
      origin: criteria.origin,
      destination: criteria.destination,
      date: criteria.departureDate,
      variant,
      flightNumberBase: 100,
    }),
  ];
  if (criteria.returnDate !== undefined) {
    itineraries.push(
      buildMockItinerary({
        origin: criteria.destination,
        destination: criteria.origin,
        date: criteria.returnDate,
        variant,
        flightNumberBase: 200,
      }),
    );
  }

  const legFactor = itineraries.length;
  const fareBreakdown = buildMockFareBreakdown(criteria, variant, legFactor, currency);

  const baseFare = sumBreakdown(fareBreakdown, currency, (entry) => entry.basePerPax.amountMinor);
  const taxes = sumBreakdown(fareBreakdown, currency, (entry) => entry.taxesPerPax.amountMinor);
  const total: Money = { amountMinor: baseFare.amountMinor + taxes.amountMinor, currency };

  const candidate: Offer = {
    id: uuid(),
    tenantId: args.tenantId,
    products: ['flight'],
    provider: {
      name: SABRE_PROVIDER_NAME,
      offerRef: `${SABRE_MOCK_OFFER_REF_PREFIX}-${variant.key}`,
      source: 'ATPCO',
      raw: {
        [SABRE_MOCK_RAW_FLAG]: true,
        variant: variant.key,
      },
    },
    total,
    baseFare,
    taxes,
    fareBreakdown,
    itineraries,
    fareFamily: { name: variant.fareFamily, cabin: variant.cabin },
    policies: { changeable: variant.changeable, refundable: variant.refundable },
    fetchedAt: args.fetchedAt,
    expiresAt: args.expiresAt,
    // Nunca `'provider'`: no hubo proveedor. Es la misma regla que el carril ATPCO real, donde el
    // TTL también es política nuestra (docs/sabre/11 §6.2 punto 2).
    expiresAtSource: 'platform-policy',
  };

  return OfferSchema.parse(candidate);
}

interface BuildItineraryArgs {
  readonly origin: string;
  readonly destination: string;
  readonly date: string;
  readonly variant: MockVariant;
  readonly flightNumberBase: number;
}

function buildMockItinerary(args: BuildItineraryArgs): Itinerary {
  const { variant, flightNumberBase } = args;
  const legs = variant.legMinutes;
  const stopovers = legs.length - 1;

  const segments: Segment[] = [];
  let cursorMs = Date.parse(`${args.date}T00:00:00.000Z`) + variant.departureHourUtc * 3_600_000;

  for (let i = 0; i < legs.length; i += 1) {
    const durationMinutes = legs[i];
    if (durationMinutes === undefined) continue;

    const origin = i === 0 ? args.origin : SABRE_MOCK_CONNECTION;
    const destination = i === legs.length - 1 ? args.destination : SABRE_MOCK_CONNECTION;
    const departureAt = new Date(cursorMs).toISOString();
    cursorMs += durationMinutes * 60_000;
    const arrivalAt = new Date(cursorMs).toISOString();
    cursorMs += variant.layoverMinutes * 60_000;

    segments.push({
      carrier: SABRE_MOCK_CARRIER,
      flightNumber: String(flightNumberBase + i),
      origin,
      destination,
      departureAt,
      arrivalAt,
      durationMinutes,
      cabin: variant.cabin,
      bookingClass: variant.bookingClass,
    });
  }

  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) {
    throw new Error('variante mock sin tramos: legMinutes no puede estar vacío');
  }

  const totalDurationMinutes = Math.round(
    (Date.parse(last.arrivalAt) - Date.parse(first.departureAt)) / 60_000,
  );

  return { segments, totalDurationMinutes, stops: stopovers };
}

/**
 * Desglose por tipo de pasajero. Se construye ANTES que los totales y los totales se derivan de
 * él, para que `Σ paxCount × (base + tax) === total` sea cierto por construcción y no por
 * casualidad: es el mismo invariante que el mapper real verifica en runtime (docs/sabre/11 §6.4).
 */
function buildMockFareBreakdown(
  criteria: FlightSearchCriteria,
  variant: MockVariant,
  legFactor: number,
  currency: string,
): FareBreakdownEntry[] {
  const counts: readonly (readonly [FareBreakdownEntry['paxType'], number])[] = [
    ['ADT', criteria.paxCount.adults],
    ['CHD', criteria.paxCount.children],
    ['INF', criteria.paxCount.infants],
  ];

  const entries: FareBreakdownEntry[] = [];
  for (const [paxType, paxCount] of counts) {
    if (paxCount <= 0) continue;
    const basePerPax = Math.round(variant.adultBaseMinor * PAX_FARE_RATIO[paxType] * legFactor);
    const taxesPerPax = Math.round(basePerPax * MOCK_TAX_RATE);
    entries.push({
      paxType,
      paxCount,
      basePerPax: { amountMinor: basePerPax, currency },
      taxesPerPax: { amountMinor: taxesPerPax, currency },
    });
  }
  return entries;
}

function sumBreakdown(
  entries: readonly FareBreakdownEntry[],
  currency: string,
  pick: (entry: FareBreakdownEntry) => number,
): Money {
  let amountMinor = 0;
  for (const entry of entries) amountMinor += pick(entry) * entry.paxCount;
  return { amountMinor, currency };
}

/** `true` si la oferta salió de este archivo. Lo usa quien no puede preguntarle al adapter. */
export function isSabreMockOffer(offer: Offer): boolean {
  return offer.provider.raw?.[SABRE_MOCK_RAW_FLAG] === true;
}
