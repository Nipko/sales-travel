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
 * Qué se le pide a Sabre en materia de marcas tarifarias.
 *
 * BFM hace búsqueda de tarifa MÍNIMA por defecto y devuelve UNA tarifa sin marca por vuelo:
 *
 * > "By default, the system does a low fare search, so only the lowest fare is presented."
 * > — `bargain-finder-max-v5.yml:7282`
 *
 * Hay dos peticiones distintas, y confundirlas costó un incidente:
 *
 * - `single` — `SingleBrandedFare: true`. Una marca por itinerario. Es lo que hacen **los 34
 *   requests reales** de la colección que piden marcas, y **el único valor que aparece en ellos**.
 *   No da la matriz comparativa, pero sí la IDENTIDAD de la tarifa: el vendedor ve «LIGHT» o
 *   «PLUS» en vez de un precio sin nombre.
 * - `upsell` — `MultipleBrandedFares` + `UpsellLimit`. Varias marcas por itinerario, que es la
 *   matriz comparativa. **Cero apariciones en 88 requests de shop reales.** Es un producto
 *   comercial aparte, y pedirlo a una cuenta que no lo tiene devuelve `MIP/PROCESS` — el motor
 *   de compra de Sabre (`MIP` es el nombre del motor, no un código de error) diciendo que no
 *   pudo procesar la petición.
 * - `off` — no se pide nada.
 *
 * El default es `single` porque es lo único respaldado por evidencia. `upsell` se enciende por
 * cuenta cuando esa agencia tenga el producto. La primera versión hizo lo contrario —`upsell`
 * para toda la red, sin un solo request real que lo respaldara— y dejó el buscador en 502.
 */
export const SABRE_BRANDED_FARES_MODES = ['off', 'single', 'upsell'] as const;
export type SabreBrandedFaresMode = (typeof SABRE_BRANDED_FARES_MODES)[number];

/** Ver {@link SABRE_BRANDED_FARES_MODES}. Lo comparten el esquema y el adapter. */
export const SABRE_BRANDED_FARES_DEFAULT: SabreBrandedFaresMode = 'upsell';

/**
 * El escalón de abajo cuando el motor rechaza lo que se pidió.
 *
 * `upsell` → `single` → `off`, y NO `upsell` → `off`. La diferencia importa: `single` funciona
 * en la cuenta de producción —trae LIGHT, FLEX, ECONOMY BASIC— y apagar las marcas enteras por
 * un rechazo del upsell cambiaría una función que anda por ninguna. La degradación tiene que
 * bajar un escalón, no tirar la escalera.
 */
export function degradarBrandedFares(modo: SabreBrandedFaresMode): SabreBrandedFaresMode {
  if (modo === 'upsell') return 'single';
  return 'off';
}

/**
 * Cuántas marcas adicionales pedir en modo `upsell`.
 *
 * 3 y no más: cada upsell multiplica el tamaño de la respuesta por itinerario y las aerolíneas de
 * la región publican típicamente tres o cuatro marcas por cabina. El tope real lo pone igualmente
 * el carrier, que sólo devuelve las que tenga.
 */
export const SABRE_DEFAULT_UPSELL_LIMIT = 3;

/**
 * Varias tarifas POR ITINERARIO — «Multiple Fares Per Itinerary» (MFPI) en la doc de Sabre.
 *
 * Es una función DISTINTA del upsell de marcas y se pide por otro sitio: `FlexibleFares`
 * (`v5.yml:6384`), donde cada entrada de `FareParameters` define un grupo y la respuesta trae la
 * mejor tarifa de cada grupo para el mismo vuelo. Eso es literalmente la matriz comparativa.
 *
 * - `off` — una tarifa por itinerario. Es el default.
 * - `with-baggage` — dos grupos: la más barata sin condiciones, y la más barata que incluya
 *   pieza facturada (`FareParameters.Baggage.FreePieceRequired`). Es la comparación que decide
 *   la venta: «sin maleta $X, con maleta $Y».
 *
 * **APAGADO por defecto, y por la misma razón que ya costó un 502: cero evidencia.** Los 88
 * requests de shop de la colección no usan `FlexibleFares` ni una vez. La función está
 * documentada y es plausible; no está demostrada contra un PCC real. Se enciende POR CUENTA
 * (`config.shopOptions.multipleFares`) para poder probarla sin arriesgar a toda la red, y si el
 * motor la rechaza el adapter degrada y la recuerda.
 *
 * Incompatibilidades declaradas por Sabre (página «Error Messages» de MFPI): Alternate Cities,
 * Award Shopping, Area Shopping y Low Cost Carriers. Ninguna la pedimos hoy.
 */
export const SABRE_MULTIPLE_FARES_MODES = ['off', 'with-baggage'] as const;
export type SabreMultipleFaresMode = (typeof SABRE_MULTIPLE_FARES_MODES)[number];

export const SABRE_MULTIPLE_FARES_DEFAULT: SabreMultipleFaresMode = 'off';

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
 * Marcas tarifarias (`v5.yml:7978-7983`).
 *
 * **Va colgado de `TravelerInfoSummary.PriceRequestInformation.TPA_Extensions`, y esa ubicación
 * es media historia.** La primera versión lo mandó bajo
 * `TravelPreferences.TPA_Extensions.FlexibleFares.FareParameters[].BrandedFareIndicators` —que
 * también existe en el contrato, con las mismas propiedades— y el PCC de producción respondió un
 * fallo de negocio dentro de un 200 en TODAS las búsquedas. `FlexibleFares` no es "dónde se piden
 * las marcas": es otra función, la de GRUPOS de tarifa flexible, que además hay que tener
 * habilitada aparte.
 *
 * Que dos ramas del contrato acepten el mismo objeto no las hace intercambiables, y el spec por sí
 * solo no lo dice. Lo dicen los 1.077 requests reales de la colección: los 35 que piden marcas las
 * piden **todos** aquí, y ninguno usa `FlexibleFares` para esto (`docs/sabre/02` §7.4).
 */
export interface SabreBrandedFareIndicators {
  SingleBrandedFare?: true;
  MultipleBrandedFares?: true;
  UpsellLimit?: number;
}

/**
 * Un grupo de tarifa de Multiple Fares Per Itinerary (`v5.yml:6384`). Vacío = «la más barata, sin
 * condiciones»; con `Baggage` = «la más barata que incluya pieza facturada».
 */
export interface SabreFareParameterGroup {
  Baggage?: { FreePieceRequired: true };
}

export interface SabreTravelPreferences {
  CabinPref?: SabreCabinPref[];
  Baggage: typeof SABRE_BAGGAGE_REQUEST;
  TPA_Extensions: {
    DataSources: typeof SABRE_DATA_SOURCES;
    PreferNDCSourceOnTie: { Value: boolean };
    NumTrips: { Number: number };
    /** Ausente salvo que se pida MFPI. Ver {@link SABRE_MULTIPLE_FARES_MODES}. */
    FlexibleFares?: { FareParameters: SabreFareParameterGroup[] };
  };
}

export interface SabrePassengerTypeQuantity {
  Code: SabrePtc;
  Quantity: number;
  TPA_Extensions: { VoluntaryChanges: typeof SABRE_VOLUNTARY_CHANGES };
}

export interface SabreTravelerInfoSummary {
  AirTravelerAvail: [{ PassengerTypeQuantity: SabrePassengerTypeQuantity[] }];
  PriceRequestInformation: {
    CurrencyCode: string;
    /** Ausente cuando no se piden marcas: un bloque vacío no es lo mismo que no pedirlo. */
    TPA_Extensions?: { BrandedFareIndicators: SabreBrandedFareIndicators };
  };
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
   * Qué marcas pedir. Ver {@link SABRE_BRANDED_FARES_MODES}.
   *
   * `single` por defecto: es lo único que aparece en los 34 requests reales que piden marcas.
   * `upsell` se enciende POR CUENTA (`config.shopOptions.brandedFares: 'upsell'`) cuando esa
   * agencia tenga el producto contratado con Sabre.
   */
  brandedFares: z.enum(SABRE_BRANDED_FARES_MODES).default(SABRE_BRANDED_FARES_DEFAULT),
  /** Ver {@link SABRE_MULTIPLE_FARES_MODES}. Apagado por defecto: sin evidencia en la colección. */
  multipleFares: z.enum(SABRE_MULTIPLE_FARES_MODES).default(SABRE_MULTIPLE_FARES_DEFAULT),
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
      TravelerInfoSummary: buildTravelerInfoSummary(criteria, opts),
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

  if (opts.multipleFares === 'with-baggage') {
    // Dos grupos y no tres: el primero vacío es «la más barata, sin condiciones», que es la que
    // el vendedor ya ve hoy, y el segundo la más barata CON pieza facturada. Añadir grupos
    // multiplica el tamaño de la respuesta y esta comparación es la que decide la venta.
    prefs.TPA_Extensions.FlexibleFares = {
      FareParameters: [{}, { Baggage: { FreePieceRequired: true } }],
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

/**
 * El bloque de marcas, o `null` si no se pide ninguna.
 *
 * `upsell` con límite 0 equivale a no pedir: un bloque presente pidiendo cero marcas es una
 * instrucción al proveedor, y no mandarlo deja su default en paz. No es lo mismo.
 */
function brandedFareIndicators(
  opts: z.infer<typeof SabreShopOptionsSchema> & { numTrips: number },
): SabreBrandedFareIndicators | null {
  if (opts.brandedFares === 'off') return null;
  if (opts.brandedFares === 'single') return { SingleBrandedFare: true };
  if (opts.upsellLimit <= 0) return null;

  // Las DOS banderas juntas, no `MultipleBrandedFares` sola. Es lo que hace el ejemplo oficial
  // «Request Example for Single and Multiple Branded Fares» del devhub:
  //
  //   <BrandedFareIndicators SingleBrandedFare="true" MultipleBrandedFares="true"/>
  //
  // La primera versión las trató como EXCLUYENTES —«son dos productos distintos, mezclarlas es
  // pedir algo que el contrato no describe»— y hasta tenía un test afirmándolo. Era una
  // suposición mía, no un hallazgo, y contradice el único ejemplo oficial que las combina.
  // Mandar el upsell solo puede ser exactamente lo que el motor rechazaba con `MIP/PROCESS`.
  return {
    SingleBrandedFare: true,
    MultipleBrandedFares: true,
    UpsellLimit: opts.upsellLimit,
  };
}

function buildTravelerInfoSummary(
  criteria: FlightSearchCriteria,
  opts: z.infer<typeof SabreShopOptionsSchema> & { numTrips: number },
): SabreTravelerInfoSummary {
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
    PriceRequestInformation: {
      CurrencyCode: criteria.currency,
      // Un `UpsellLimit: 0` sería pedir "cero marcas adicionales", que no es lo mismo que no
      // pedir marcas: lo primero es una instrucción, lo segundo deja el default del proveedor.
      ...(brandedFareIndicators(opts) === null
        ? {}
        : { TPA_Extensions: { BrandedFareIndicators: brandedFareIndicators(opts)! } }),
    },
  };
}

function passengerType(code: SabrePtc, quantity: number): SabrePassengerTypeQuantity {
  return {
    Code: code,
    Quantity: quantity,
    TPA_Extensions: { VoluntaryChanges: SABRE_VOLUNTARY_CHANGES },
  };
}
