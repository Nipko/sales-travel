import type { CabinClass } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { z } from 'zod';
import { SabreConfigError } from '../errors';
import type { SabreConfig } from '../config';

/**
 * Constructor de `OTA_AirLowFareSearchRQ` para `POST /v5/offers/shop` (Bargain Finder Max).
 *
 * Se construye sobre **v5** y no sobre v4 porque v5 es la única versión con
 * `POS.MultiSourceControl` —multi-PCC nativo, que es exactamente el modelo consolidador—
 * (VERIFICADO-SPEC: `bargain-finder-max-v5.yml:5010-5011`, definición en `:5037`; `grep -c
 * MultiSourceControl` da 0 en v4 y en v3), con penalidades NDC estructuradas y con tres ejemplos
 * de respuesta oficiales que sirven de fixture al mapper. Ver docs/sabre/02 §3.4 y docs/sabre/11 §6.1.
 *
 * Los nombres de propiedad de este archivo son los del contrato OTA (`PascalCase` y
 * `TPA_Extensions` con guion bajo). No se camelizan: son la representación del cable, y
 * renombrarlas rompería el request. El vocabulario canónico vive del otro lado del ACL.
 */

/** Ruta del servicio. La versión del path y el campo `Version` tienen que coincidir (`v5.yml:55`). */
export const SABRE_SHOP_PATH = '/v5/offers/shop';

/**
 * `Version` DEBE coincidir con la versión de la URL (VERIFICADO-SPEC `bargain-finder-max-v5.yml:55`).
 * La colección de Sabre manda `"4"` o `"1"` contra `/v5` en los 13 requests que tiene; no se copia
 * ese patrón, se copia el de los tres ejemplos oficiales, que mandan `"5"` (docs/sabre/02 §3.5).
 */
export const SABRE_BFM_VERSION = '5';

/**
 * Constantes documentadas del `RequestorID`, ya no inferidas:
 * `Type` = "A Sabre internal configuration type, which equals 1" (`v5.yml:59`);
 * `ID` = "A unique ID assigned by the creating system (e.g. 1 = Sabre)" (`v5.yml:58`);
 * `CompanyName.Code` = "TN for Travel Agency, AS for Airline Solutions" (`v5.yml:57`).
 */
export const SABRE_REQUESTOR_ID_TYPE = '1';
export const SABRE_REQUESTOR_ID = '1';
export const SABRE_COMPANY_CODE_TRAVEL_AGENCY = 'TN';

/**
 * Códigos de tipo de pasajero.
 *
 * `CNN` —no `CHD`— es el PTC de niño en Sabre (VERIFICADO: `Workflows / 18` de la colección;
 * VERIFICADO-SPEC: el ejemplo 2 oficial usa la variante por edad `C06`, `v5.yml:607`). Mandar
 * `CHD` significa no recibir tarifa de niño. `INF` sí existe y lo usa el ejemplo 3 oficial
 * (`v5.yml:1439`). Ver docs/sabre/02 §5.5.
 */
export const SABRE_PTC = {
  adults: 'ADT',
  children: 'CNN',
  infants: 'INF',
} as const satisfies Record<keyof FlightSearchCriteria['paxCount'], string>;

export type SabrePtc = (typeof SABRE_PTC)[keyof typeof SABRE_PTC];

/**
 * Enum cerrado de cabina de Sabre (`v5.yml:5653`): seis cabinas frente a nuestras cuatro.
 * `premium_economy` es `S`, **no** `W` —`W` no está en el enum—, y `business` es `C`, no `J`
 * (`J` es Premium Business, otra cabina). `providers/latam-ndc` tiene un `CABIN_MAP` distinto y
 * **no se copia**: cada ACL con su vocabulario. Ver docs/sabre/02 §6.2.
 */
export const SABRE_CABIN_BY_CANONICAL = {
  economy: 'Y',
  premium_economy: 'S',
  business: 'C',
  first: 'F',
} as const satisfies Record<CabinClass, string>;

export type SabreCabinCode = (typeof SABRE_CABIN_BY_CANONICAL)[CabinClass];

/**
 * `PreferLevel` de cabina tiene un enum de un solo valor: `[Preferred]` (`v5.yml:5667-5673`).
 * `Unacceptable` pertenece a otros schemas (p.ej. `AirportPref`) y mandarlo aquí sería salirse de
 * un enum cerrado. Prefiere, no fuerza: la cabina pedida se vuelve a verificar en el mapper.
 */
export const SABRE_CABIN_PREFER_LEVEL = 'Preferred';

/** Tiers de volumen de `IntelliSellTransaction.RequestType.Name` (`v5.yml:5537`). */
export const SABRE_ITINERARY_TIERS = ['50ITINS', '100ITINS', '200ITINS'] as const;
export type SabreItineraryTier = (typeof SABRE_ITINERARY_TIERS)[number];

/**
 * `50ITINS` es lo que usan los tres ejemplos oficiales y lo que recomienda docs/sabre/02 §8.3.
 * Es un **tier contratado**: pedir uno al que la agencia no está suscrita no devuelve error, sino
 * cero resultados, indistinguible de "no hay vuelos" (`v5.yml:5537`). Por eso es configurable por
 * cuenta de proveedor y no una constante escondida.
 */
export const SABRE_DEFAULT_ITINERARY_TIER: SabreItineraryTier = '50ITINS';

/**
 * Cuántos itinerarios cabe pedir en cada tier. El nombre del tier ES el tope contratado.
 */
export const SABRE_TIER_CAPACITY: Record<SabreItineraryTier, number> = {
  '50ITINS': 50,
  '100ITINS': 100,
  '200ITINS': 200,
};

/**
 * `NumTrips.Number`: cuántos itinerarios devolver. Default del contrato 9, mínimo 1
 * (`v5.yml:7393`), sin máximo declarado — el techo real lo pone el tier.
 *
 * Ya NO es una constante: se deriva del tier salvo que la cuenta pida otra cosa. Estaba fijo en
 * 20 con el tier en `50ITINS`, o sea pidiendo menos de la mitad de lo contratado. En una ruta
 * doméstica corta eso no se nota como "faltan opciones" sino como "faltan AEROLÍNEAS": BFM
 * devuelve los 20 mejores itinerarios y en BOG-MDE los baratos son permutaciones de ida y
 * vuelta del mismo vuelo de la misma low cost, así que los 20 huecos se agotan antes de llegar
 * al primer vuelo de la segunda aerolínea. El vendedor lo lee como "acá sólo vuela JetSMART".
 */
export function defaultNumTripsFor(tier: SabreItineraryTier): number {
  return SABRE_TIER_CAPACITY[tier];
}

/**
 * Cuántas marcas tarifarias adicionales pedir por itinerario, además de la más barata.
 *
 * BFM hace una búsqueda de tarifa MÍNIMA por defecto y devuelve una sola tarifa por vuelo:
 *
 * > "By default, the system does a low fare search, so only the lowest fare is presented."
 * > — `bargain-finder-max-v5.yml:7282` (`NDCIndicators.MaxNumberOfUpsells`)
 *
 * Por eso la pantalla mostraba «Ver tarifa» en singular en todos los resultados: no es que la
 * aerolínea no tenga Light/Plus/Top, es que no se estaban pidiendo. El vendedor B2B vive de esa
 * diferencia —la marca con equipaje deja más margen y es la que quiere el cliente con maleta—,
 * así que una lista de sólo-la-más-barata le esconde justo el producto que vende.
 *
 * 3 y no más: cada upsell multiplica el tamaño de la respuesta por itinerario y las aerolíneas
 * de la región publican típicamente tres o cuatro marcas por cabina. El tope real lo pone
 * igualmente el carrier, que sólo devuelve las que tenga.
 */
export const SABRE_DEFAULT_UPSELL_LIMIT = 3;

/**
 * Interruptores de fuente. `NDC` y `ATPCO` van habilitados **a la vez**: son propiedades
 * independientes del mismo objeto, sin `oneOf` ni `maxProperties` que lo impidan (`v5.yml:6237`),
 * y BFM consulta ambas fuentes en UNA sola llamada — sumar Sabre al fan-out cuesta 1 request, no 3.
 * `LCC` queda fuera de alcance en Ola 1 (docs/sabre/02 §4.1 y §4.2).
 */
export const SABRE_DATA_SOURCES = {
  NDC: 'Enable',
  ATPCO: 'Enable',
  LCC: 'Disable',
} as const;

/**
 * `Baggage.RequestType: "C"` = franquicia **y cargos**, no sólo franquicia (`v5.yml:5885`, enum
 * `A|C|N`). Sin este bloque la respuesta no trae `baggageChargeDescs` y `Offer.baggage` queda
 * vacío: se pierde justo el diferencial contra el comparador de precio pelado (docs/sabre/02 §7.4).
 */
export const SABRE_BAGGAGE_REQUEST = {
  RequestType: 'C',
  Description: true,
  CarryOnInfo: true,
} as const;

/**
 * `VoluntaryChanges` es el interruptor de `penaltiesInfo` en la respuesta: sin él no hay
 * penalidades que mapear a `Offer.policies`, sólo el booleano `passengerInfo.nonRefundable`
 * (docs/sabre/02 §7.4; ejemplo 3 oficial `v5.yml:1427`). `Penalty` admite como máximo 2 entradas
 * (`v5.yml:7796`) y aquí se usan las dos: reembolso y cambio.
 */
export const SABRE_VOLUNTARY_CHANGES = {
  Match: 'All',
  Penalty: [{ Type: 'Refund' }, { Type: 'Exchange' }],
} as const;

/** Formato del contrato: `YYYY-MM-DDTHH:MM:SS`. `FlightSearchCriteria` sólo tiene fecha. */
const SABRE_MIDNIGHT_SUFFIX = 'T00:00:00';

export interface SabreRequestorId {
  Type: string;
  ID: string;
  CompanyName: { Code: string };
}

export interface SabrePosSource {
  PseudoCityCode: string;
  RequestorID: SabreRequestorId;
}

export interface SabrePos {
  MultiSourceControl?: { MaximumNumberOfPCCs: number };
  Source: SabrePosSource[];
}

export interface SabreOriginDestinationInformation {
  RPH: string;
  DepartureDateTime: string;
  OriginLocation: { LocationCode: string };
  DestinationLocation: { LocationCode: string };
}

export interface SabreCabinPref {
  Cabin: SabreCabinCode;
  PreferLevel: typeof SABRE_CABIN_PREFER_LEVEL;
}

/**
 * Marcas tarifarias del lado ATPCO (`v5.yml:6702`).
 *
 * Ojo con la forma: acá los valores van DESNUDOS (`MultipleBrandedFares: true`), mientras que
 * el equivalente NDC los envuelve en `{ Value: … }`. No es simetría rota nuestra, es el
 * contrato; mezclarlas produce un 400 que no dice cuál de las dos estaba mal.
 */
export interface SabreBrandedFareIndicators {
  MultipleBrandedFares: boolean;
  UpsellLimit: number;
}

/** `NDCIndicators` (`v5.yml:7342` y `:7353`): aquí SÍ van envueltos en `Value`. */
export interface SabreNdcIndicators {
  MultipleBrandedFares: { Value: boolean };
  MaxNumberOfUpsells: { Value: number };
}

export interface SabreTravelPreferences {
  CabinPref?: SabreCabinPref[];
  Baggage: typeof SABRE_BAGGAGE_REQUEST;
  TPA_Extensions: {
    DataSources: typeof SABRE_DATA_SOURCES;
    PreferNDCSourceOnTie: { Value: boolean };
    NumTrips: { Number: number };
    /** Ausente cuando no se piden upsells: un bloque vacío no es lo mismo que no pedirlo. */
    FlexibleFares?: { FareParameters: [{ BrandedFareIndicators: SabreBrandedFareIndicators }] };
    NDCIndicators?: SabreNdcIndicators;
  };
}

export interface SabrePassengerTypeQuantity {
  Code: SabrePtc;
  Quantity: number;
  TPA_Extensions: { VoluntaryChanges: typeof SABRE_VOLUNTARY_CHANGES };
}

export interface SabreTravelerInfoSummary {
  AirTravelerAvail: [{ PassengerTypeQuantity: SabrePassengerTypeQuantity[] }];
  PriceRequestInformation: { CurrencyCode: string };
}

export interface SabreShopTpaExtensions {
  IntelliSellTransaction: {
    RequestType: { Name: SabreItineraryTier };
    MultipleSourcePerItinerary: { Value: true };
  };
}

export interface SabreAirLowFareSearchRq {
  Version: typeof SABRE_BFM_VERSION;
  POS: SabrePos;
  OriginDestinationInformation: SabreOriginDestinationInformation[];
  TravelPreferences: SabreTravelPreferences;
  TravelerInfoSummary: SabreTravelerInfoSummary;
  TPA_Extensions: SabreShopTpaExtensions;
}

/** Raíz única del body (`v5.yml:2661`, `required: [OriginDestinationInformation, POS, TravelerInfoSummary, Version]`). */
export interface SabreShopRequest {
  OTA_AirLowFareSearchRQ: SabreAirLowFareSearchRq;
}

/**
 * Palancas que NO son criterio de búsqueda del vendedor sino configuración comercial de la cuenta
 * de proveedor. Llegan como opciones porque hoy no viven en `SabreConfig` (docs/sabre/02 §8.1).
 */
export const SabreShopOptionsSchema = z.object({
  itineraryTier: z.enum(SABRE_ITINERARY_TIERS).default(SABRE_DEFAULT_ITINERARY_TIER),
  /** Omitido = la capacidad del tier. Ver {@link defaultNumTripsFor}. */
  numTrips: z.number().int().min(1).optional(),
  /** `POS.MultiSourceControl.MaximumNumberOfPCCs` (`v5.yml:5037`), sólo si Global Shopping está activo. */
  maxPccs: z.number().int().min(1).optional(),
  /** Desempate documentado cuando ATPCO y NDC devuelven el mismo viaje al mismo precio (`v5.yml:7423`). */
  preferNdcSourceOnTie: z.boolean().default(true),
  /**
   * Pedir las marcas tarifarias por encima de la más barata. Ver {@link SABRE_DEFAULT_UPSELL_LIMIT}.
   *
   * **APAGADO por defecto, y no por preferencia: por un incidente.** Se soltó en `true` sin poder
   * probarlo contra un PCC real y la cuenta de producción empezó a devolver un fallo de NEGOCIO
   * dentro de un 200 (`kind: BUSINESS`) en TODAS las búsquedas — con `latam-ndc` ya descartado por
   * la moneda, eso dejó `POST /search/flights` en 502 y el buscador entero muerto (2026-08-27).
   *
   * `FlexibleFares` y `NDCIndicators` son funciones que el PCC tiene que tener habilitadas; un PCC
   * sin ellas no las ignora, rechaza la operación. Encenderlo por defecto para toda la red apuesta
   * la búsqueda —lo único que la plataforma no puede permitirse perder— a una capacidad comercial
   * que varía por cuenta.
   *
   * Se enciende POR CUENTA (`config.shopOptions.brandedUpsells`) cuando esa agencia lo tenga
   * verificado contra su PCC. El día que se sepa que la red entera lo soporta, este default se
   * cambia con un motivo escrito, no con un «debería andar».
   */
  brandedUpsells: z.boolean().default(false),
  upsellLimit: z.number().int().min(0).default(SABRE_DEFAULT_UPSELL_LIMIT),
});

export type SabreShopOptions = z.input<typeof SabreShopOptionsSchema>;

/**
 * `FlightSearchCriteria` → `OTA_AirLowFareSearchRQ`.
 *
 * El PCC sale **siempre** de la config (BYOC: es el PCC de la agencia, resuelto por
 * `ProviderCredentialsService` con herencia consolidador→agencia). Ningún PCC literal vive en
 * este archivo.
 */
export function buildSabreShopRequest(
  criteria: FlightSearchCriteria,
  cfg: SabreConfig,
  options: SabreShopOptions = {},
): SabreShopRequest {
  const opts = parseShopOptions(options);
  const pseudoCityCode = requireHomePcc(cfg);

  return {
    OTA_AirLowFareSearchRQ: {
      Version: SABRE_BFM_VERSION,
      POS: buildPos(pseudoCityCode, opts.maxPccs),
      OriginDestinationInformation: buildOriginDestinations(criteria),
      TravelPreferences: buildTravelPreferences(criteria, opts),
      TravelerInfoSummary: buildTravelerInfoSummary(criteria),
      TPA_Extensions: {
        IntelliSellTransaction: {
          RequestType: { Name: opts.itineraryTier },
          // NO OMITIR. Sin esto Sabre poda en SU servidor la alternativa cross-source más cara
          // antes de que la veamos —"By default, the cheaper will stay" (`v5.yml:5473`)—, o sea
          // que omitirlo no es "usar el default": es pedirle a Sabre que nos oculte producto.
          // Es constante, no opción de configuración (docs/sabre/02 §4.2).
          MultipleSourcePerItinerary: { Value: true },
        },
      },
    },
  };
}

function parseShopOptions(
  options: SabreShopOptions,
): z.infer<typeof SabreShopOptionsSchema> & { numTrips: number } {
  const parsed = SabreShopOptionsSchema.safeParse(options);
  if (parsed.success) {
    const tier = parsed.data.itineraryTier;
    // Se ACOTA al tier, no se confía: pedir 200 con `50ITINS` no da error, da los 50 de siempre
    // —o cero—, y el número de más sólo sirve para que el log mienta sobre lo que se pidió.
    const numTrips = Math.min(
      parsed.data.numTrips ?? defaultNumTripsFor(tier),
      SABRE_TIER_CAPACITY[tier],
    );
    return { ...parsed.data, numTrips };
  }
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
  throw new SabreConfigError(`opciones de búsqueda de Sabre inválidas (${detail})`);
}

/**
 * Sin `homePcc` no hay request que mandar. En la práctica el adapter ni se construye sin él;
 * esto es la red de seguridad para que un `undefined` nunca llegue al cable convertido en la
 * cadena `"undefined"`. El mensaje nombra el campo, nunca su valor (RNF-07).
 */
function requireHomePcc(cfg: SabreConfig): string {
  const pcc = cfg.homePcc;
  if (typeof pcc !== 'string' || pcc.length === 0) {
    throw new SabreConfigError('falta homePcc: no se puede construir POS.Source.PseudoCityCode');
  }
  return pcc;
}

function buildPos(pseudoCityCode: string, maxPccs: number | undefined): SabrePos {
  const source: SabrePosSource = {
    PseudoCityCode: pseudoCityCode,
    RequestorID: {
      Type: SABRE_REQUESTOR_ID_TYPE,
      ID: SABRE_REQUESTOR_ID,
      CompanyName: { Code: SABRE_COMPANY_CODE_TRAVEL_AGENCY },
    },
  };
  // `MaximumNumberOfPCCs` se omite salvo que se configure: mandar 1 por defecto recortaría a la
  // cuenta que sí tenga PCC alternos configurados en Global Shopping (`v5.yml:5037`).
  if (maxPccs === undefined) return { Source: [source] };
  return { MultiSourceControl: { MaximumNumberOfPCCs: maxPccs }, Source: [source] };
}

/**
 * Un elemento por tramo, `minItems: 1, maxItems: 10` (`v5.yml:2681`). El `RPH` va base-1 y
 * consistente por higiene; la correlación real tramo-pedido ↔ itinerario-devuelto la hace
 * `itineraries[].originDestinationInformationRef` en la respuesta (`v5.yml:4197`), no el `RPH`.
 */
function buildOriginDestinations(
  criteria: FlightSearchCriteria,
): SabreOriginDestinationInformation[] {
  const outbound: SabreOriginDestinationInformation = {
    RPH: '1',
    DepartureDateTime: `${criteria.departureDate}${SABRE_MIDNIGHT_SUFFIX}`,
    OriginLocation: { LocationCode: criteria.origin },
    DestinationLocation: { LocationCode: criteria.destination },
  };
  if (criteria.returnDate === undefined) return [outbound];

  return [
    outbound,
    {
      RPH: '2',
      DepartureDateTime: `${criteria.returnDate}${SABRE_MIDNIGHT_SUFFIX}`,
      OriginLocation: { LocationCode: criteria.destination },
      DestinationLocation: { LocationCode: criteria.origin },
    },
  ];
}

function buildTravelPreferences(
  criteria: FlightSearchCriteria,
  opts: z.infer<typeof SabreShopOptionsSchema> & { numTrips: number },
): SabreTravelPreferences {
  const prefs: SabreTravelPreferences = {
    Baggage: SABRE_BAGGAGE_REQUEST,
    TPA_Extensions: {
      DataSources: SABRE_DATA_SOURCES,
      PreferNDCSourceOnTie: { Value: opts.preferNdcSourceOnTie },
      NumTrips: { Number: opts.numTrips },
    },
  };

  // Las DOS fuentes van habilitadas a la vez (`SABRE_DATA_SOURCES`), así que pedir el upsell en
  // una sola dejaría media respuesta con marcas y la otra media sin ellas — y el vendedor no
  // tiene forma de saber cuál mitad es cuál.
  if (opts.brandedUpsells && opts.upsellLimit > 0) {
    prefs.TPA_Extensions.FlexibleFares = {
      FareParameters: [
        { BrandedFareIndicators: { MultipleBrandedFares: true, UpsellLimit: opts.upsellLimit } },
      ],
    };
    prefs.TPA_Extensions.NDCIndicators = {
      MultipleBrandedFares: { Value: true },
      MaxNumberOfUpsells: { Value: opts.upsellLimit },
    };
  }
  // El bloque entero se omite si no hay cabina pedida: `CabinPref` sólo prefiere, y una entrada
  // vacía o inventada empeoraría el resultado en vez de dejarlo abierto.
  if (criteria.cabin !== undefined) {
    prefs.CabinPref = [
      { Cabin: SABRE_CABIN_BY_CANONICAL[criteria.cabin], PreferLevel: SABRE_CABIN_PREFER_LEVEL },
    ];
  }
  return prefs;
}

function buildTravelerInfoSummary(criteria: FlightSearchCriteria): SabreTravelerInfoSummary {
  const { adults, children, infants } = criteria.paxCount;
  const quantities: SabrePassengerTypeQuantity[] = [passengerType(SABRE_PTC.adults, adults)];
  if (children > 0) quantities.push(passengerType(SABRE_PTC.children, children));
  if (infants > 0) quantities.push(passengerType(SABRE_PTC.infants, infants));

  return {
    AirTravelerAvail: [{ PassengerTypeQuantity: quantities }],
    // Siempre presente (`v5.yml:7849`). Sin él Sabre cotiza en la moneda que dicte el PCC y el
    // buscador promete una moneda que el proveedor ignoró. Pedirla no garantiza tarifa local:
    // el catálogo lo sigue fijando el punto de venta, por eso el mapper vuelve a comparar la
    // moneda devuelta contra la pedida (docs/sabre/02 §6.2).
    PriceRequestInformation: { CurrencyCode: criteria.currency },
  };
}

function passengerType(code: SabrePtc, quantity: number): SabrePassengerTypeQuantity {
  return {
    Code: code,
    Quantity: quantity,
    TPA_Extensions: { VoluntaryChanges: SABRE_VOLUNTARY_CHANGES },
  };
}
