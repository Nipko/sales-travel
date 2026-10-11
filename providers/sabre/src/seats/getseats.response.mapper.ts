import {
  SeatMapSchema,
  type CabinClass,
  type Money,
  type Offer,
  type Seat,
  type SeatCharacteristic,
  type SeatMap,
  type SeatMapCabin,
  type SeatMapSegment,
  type SeatOffer,
  type SeatRow,
  type Segment,
} from '@sales-travel/canonical';
import { z } from 'zod';

/**
 * Mapper de `SeatAvailabilityRs` de Get Seats v3 (`get-seats-agency-3.0.yml:183-263`).
 *
 * ## El modelo mental
 *
 * La respuesta trae dos mitades que se cruzan por id (docs/sabre/03 §4.3): `seatMaps[]` dice cómo
 * está distribuido el avión y `offerItems[]` qué se puede vender, a quién y a qué precio. El
 * precio está a DOS saltos: `seat.offerItemRefIds[]` → `offerItems[].priceDefinitionRef` →
 * `priceDefinitions[]`. Y un mismo asiento trae un `offerItem` POR PASAJERO —el ejemplo oficial de
 * dos adultos le da dos a cada asiento—, por eso el canónico guarda el precio por pasajero.
 *
 * ## Las reglas que se aplican aquí, y por qué aquí
 *
 * El canónico tiene un vocabulario cerrado de siete características y dos banderas
 * (`adultOnly`, `infantAllowed`); los códigos PADIS que no caben ahí se pierden al salir de este
 * fichero. Por eso las reglas que dependen de ellos se resuelven AQUÍ, siempre por `code` y nunca
 * por `description` (el mismo `E` llega como «ExitRowSeat» y como «ExitRow»):
 *
 * | Código                                | Efecto                                                   |
 * | ------------------------------------- | -------------------------------------------------------- |
 * | `occupationStatusCode` `Q`, código `8` | no hay asiento: hueco del layout, no se emite            |
 * | `occupationStatusCode` ≠ `F`           | no disponible (ocupado, bloqueado, protegido…)           |
 * | `isOperative: false`                   | no disponible                                            |
 * | `1` RestrictedGeneral                  | no disponible                                            |
 * | `E` (asiento o fila), `exitRowPosition` | `EXIT_ROW`, `adultOnly`, sin infante                     |
 * | `IE` SeatNotSuitableForChild           | `adultOnly`                                              |
 * | `1A` NotAllowedForInfants              | sin infante                                              |
 * | `1W` WindowSeatWithoutWindow           | NO lleva `WINDOW` aunque traiga `W`                      |
 * | `1D` RestrictedRecline                 | `NO_RECLINE` (se muestra, no excluye)                    |
 * | `L` / `B` / `A` / `9` / `W`            | `EXTRA_LEGROOM` / `BASSINET` / `AISLE` / `MIDDLE` / `WINDOW` |
 *
 * Un asiento sólo con `displayOnlyItemRefIds` no es comprable (`DisplayOnlyItem`, `:329-354`): no
 * tiene ofertas y sale como no disponible.
 *
 * Un mapa con asientos libres y NINGUNO vendible sale con `displayOnly: true`: es lo que se ve
 * cuando la tarifa no deja elegir asiento, la cuenta de la agencia no está autorizada para la
 * aerolínea (BYOC, docs/sabre/03 §4.2) o las ofertas no se atribuyen a ningún pasajero. Sin esa
 * marca se pintaría como un avión lleno.
 */

// ---------------------------------------------------------------------------
// Contrato de entrada
// ---------------------------------------------------------------------------

const IdSchema = z.string().min(1).max(255);

/**
 * `PriceBreakdown.amount` es `string` con `format: number` en el contrato (`:738-742`), pero los
 * cinco ejemplos oficiales lo mandan como número (`37.0`). Se aceptan las dos formas.
 *
 * `currencyCode` y `amount` son obligatorios en el contrato y aun así el ejemplo oficial de
 * payload trae `{ "id": "8", "totalPrice": {} }`: se toleran ausentes y el precio queda «no
 * informado», que NO es «sin cargo».
 */
const PriceDefinitionSchema = z.object({
  id: IdSchema,
  currencyCode: z.string().optional(),
  totalPrice: z.object({ amount: z.union([z.number(), z.string()]).optional() }).optional(),
});

const OfferItemSchema = z.object({
  id: IdSchema,
  priceDefinitionRef: IdSchema.optional(),
  segmentRefs: z.array(IdSchema).min(1),
  passengerRefs: z.array(IdSchema).min(1),
});

const CharacteristicSchema = z.object({ code: z.string().min(1).max(10) });

const SeatNodeSchema = z.object({
  column: z.string(),
  occupationStatusCode: z.string().optional(),
  characteristics: z.array(CharacteristicSchema).optional(),
  isOperative: z.boolean().optional(),
  offerItemRefIds: z.array(IdSchema).optional(),
  displayOnlyItemRefIds: z.array(IdSchema).optional(),
});

/**
 * `SeatRow.row` es entero en v3 (`:983-986`). El v1 lo mandaba como texto (`"12"`): se acepta un
 * texto de sólo dígitos porque no hay forma de leerlo mal.
 */
const RowNumberSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .transform(Number),
]);

const SeatRowNodeSchema = z.object({
  row: RowNumberSchema,
  characteristics: z.array(CharacteristicSchema).optional(),
  seats: z.array(SeatNodeSchema),
});

/** `CabinLayoutColumn.position` es array en v3 (`:951-958`); el v1 mandaba un string suelto. */
const LayoutColumnSchema = z.object({
  id: z.string(),
  position: z.union([z.array(z.string()), z.string()]).optional(),
});

const RowRangeSchema = z.object({ firstRow: z.number().int(), lastRow: z.number().int() });

const CabinLayoutSchema = z.object({
  columns: z.array(LayoutColumnSchema).min(1),
  exitRowPosition: z.array(RowRangeSchema).optional(),
});

const CabinCompartmentSchema = z.object({
  cabinCode: z.string().optional(),
  columnIds: z.array(z.string()).optional(),
  cabinLayout: CabinLayoutSchema.optional(),
  seatRows: z.array(SeatRowNodeSchema).optional(),
});

const SeatMapNodeSchema = z.object({
  segmentRef: IdSchema,
  flightLegRef: IdSchema.optional(),
  cabinCompartments: z.array(CabinCompartmentSchema).optional(),
});

const SegmentNodeSchema = z.object({
  id: IdSchema,
  bookingAirlineCode: z.string(),
  bookingFlightNumber: z.number().int(),
  departureAirportCode: z.string(),
  arrivalAirportCode: z.string(),
  departureDate: z.string(),
  isChangeOfGauge: z.boolean().optional(),
  flightLegs: z.array(z.object({ id: IdSchema })).optional(),
});

/**
 * `SeatAvailabilityResponse` (`:210-263`) con sus cinco obligatorios. `passengers[]` se valida
 * sólo por su `id`: trae nombres y números de socio, y Zod descarta todo lo no declarado, así que
 * no llegan más lejos que esta línea.
 */
const SeatAvailabilityResponseSchema = z.object({
  offerId: IdSchema.optional(),
  segments: z.array(SegmentNodeSchema).min(1),
  passengers: z.array(z.object({ id: IdSchema })).min(1),
  serviceDefinitions: z.array(z.unknown()),
  priceDefinitions: z.array(PriceDefinitionSchema).optional(),
  offerItems: z.array(OfferItemSchema),
  seatMaps: z.array(SeatMapNodeSchema).min(1),
});

/** `SeatAvailabilityRs` (`:183-208`). */
export const SabreGetSeatsResponseSchema = z.object({
  response: SeatAvailabilityResponseSchema.optional(),
  errors: z.array(z.unknown()).optional(),
  warnings: z.array(z.unknown()).optional(),
});

type SeatAvailabilityResponse = z.infer<typeof SeatAvailabilityResponseSchema>;
type SegmentNode = z.infer<typeof SegmentNodeSchema>;
type SeatMapNode = z.infer<typeof SeatMapNodeSchema>;
type CabinCompartmentNode = z.infer<typeof CabinCompartmentSchema>;
type SeatRowNode = z.infer<typeof SeatRowNodeSchema>;
type SeatNode = z.infer<typeof SeatNodeSchema>;
type OfferItemNode = z.infer<typeof OfferItemSchema>;
type PriceDefinitionNode = z.infer<typeof PriceDefinitionSchema>;

// ---------------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------------

/**
 * `CabinTypeCode` es una letra sin enum (`:1143-1148`). Es OTRO vocabulario que el de BFM: aquí
 * llegan códigos de la aerolínea (el ejemplo NDC de BA usa `M` para turista) y `W` es la turista
 * premium de IATA, no la turista que el shop asume para un código que su enum ni siquiera tiene.
 * Un código desconocido no se adivina: la cabina queda sin traducir y se avisa.
 */
const CABIN_BY_SEAT_MAP_CODE: Readonly<Record<string, CabinClass>> = {
  Y: 'economy',
  M: 'economy',
  W: 'premium_economy',
  S: 'premium_economy',
  C: 'business',
  J: 'business',
  F: 'first',
  P: 'first',
};

/** `occupationStatusCode` libre (PADIS 9865). Cualquier otro valor es no disponible. */
const STATUS_FREE = 'F';
/** `Q` = «No seat here» (PADIS 9865) y código `8` = «No seat at this location» (PADIS 9825). */
const STATUS_NO_SEAT = 'Q';
const CODE_NO_SEAT = '8';

const CODE = {
  restricted: '1',
  noInfant: '1A',
  noRecline: '1D',
  windowWithoutWindow: '1W',
  center: '9',
  aisle: 'A',
  bassinet: 'B',
  exitRow: 'E',
  notForChild: 'IE',
  legSpace: 'L',
  window: 'W',
} as const;

/** `CabinLayoutColumn.position`: `A` pasillo, `W` ventana, `C` centro (`:951-958`). `9` en ATPCO. */
const POSITION = { aisle: 'A', window: 'W', center: new Set(['C', '9']) } as const;

const COLUMN = /^[A-Z]$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(\d{1,12})(?:\.(\d{1,3}))?$/;
const LOCAL_DATE = /^(\d{4}-\d{2}-\d{2})T/;

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export type SabreGetSeatsWarningCode =
  /** Sabre devolvió `warnings[]` en la raíz. Su texto puede llevar datos: sólo se cuenta. */
  | 'provider-warning'
  /** El mapa nombra un segmento que no es ninguno de la oferta: se descarta el mapa entero. */
  | 'seat-map-segment-unmatched'
  /** El segmento tiene varios aviones y el mapa no dice de cuál es: se descarta. */
  | 'seat-map-leg-unmatched'
  /** Segundo mapa para el mismo segmento y avión: gana el primero. */
  | 'seat-map-duplicate'
  /** El mapa no deja ninguna cabina con filas. */
  | 'seat-map-empty'
  /**
   * El avión tiene asientos libres y ninguno se puede vender (sólo exhibición, sin ofertas o
   * con ofertas que no se atribuyen a nadie). El segmento sale con `displayOnly: true`.
   */
  | 'seat-map-display-only'
  | 'cabin-code-unknown'
  /** Ni `cabinLayout.columns`, ni `columnIds`, ni asientos de los que deducirlas. */
  | 'cabin-columns-missing'
  | 'seat-row-duplicate'
  /** El asiento está en una columna que el layout no declara: no se puede ubicar. */
  | 'seat-column-unlisted'
  | 'seat-column-duplicate'
  | 'seat-offer-item-missing'
  /** El `offerItem` no cubre el segmento de este mapa. */
  | 'seat-offer-segment-mismatch'
  /** El `offerItem` nombra a un pasajero que no pedimos (o a un infante en brazos). */
  | 'seat-offer-passenger-unknown'
  | 'seat-offer-duplicate-passenger'
  /** Precio ausente, sin moneda, negativo o con un tercer decimal: queda «no informado». */
  | 'seat-price-undetermined';

export interface SabreGetSeatsWarning {
  readonly code: SabreGetSeatsWarningCode;
  /** Ruta dentro de la respuesta. Nunca un valor. */
  readonly path: string;
  /** Dato acotado y no sensible (un código de cabina, el motivo de un precio). */
  readonly detail?: string;
}

export interface SabreGetSeatsMapContext {
  /** La oferta consultada: de ella salen los índices de segmento. */
  readonly basis: Offer;
  /** id de segmento del request → índice aplanado. Vacío en NDC. */
  readonly segmentIndexById: ReadonlyMap<string, number>;
  /** id de pasajero → `requestedTravelerIndex`. */
  readonly passengerIndexById: ReadonlyMap<string, number>;
}

export interface SabreGetSeatsMapResult {
  readonly seatMap: SeatMap;
  readonly warnings: readonly SabreGetSeatsWarning[];
  /** `response.offerId`: el handle para añadir los asientos a una orden NDC más adelante. */
  readonly offerId: string | undefined;
  /** Mapas de la respuesta que no llegaron al canónico. */
  readonly droppedSeatMaps: number;
}

/**
 * La respuesta no encaja con el contrato v3. El mensaje lleva rutas y códigos de Zod, nunca
 * valores: por la respuesta pasan nombres de pasajero y números de viajero frecuente.
 */
export class SabreGetSeatsMappingError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`respuesta de getseats fuera de contrato (${issues.join(', ') || '<root>'})`);
    this.name = 'SabreGetSeatsMappingError';
  }
}

/** Respuesta con `errors[]`: Sabre no pintó el mapa. Sólo se conserva cuántos. */
export class SabreGetSeatsRejectedError extends Error {
  constructor(readonly errorCount: number) {
    super(`getseats devolvió ${String(errorCount)} error(es) y ningún mapa utilizable`);
    this.name = 'SabreGetSeatsRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export function mapSabreGetSeatsResponse(
  raw: unknown,
  ctx: SabreGetSeatsMapContext,
): SabreGetSeatsMapResult {
  const parsed = SabreGetSeatsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreGetSeatsMappingError([
      ...legacyContractIssues(raw),
      ...parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    ]);
  }
  const envelope = parsed.data;
  if ((envelope.errors?.length ?? 0) > 0) {
    throw new SabreGetSeatsRejectedError(envelope.errors?.length ?? 0);
  }
  if (envelope.response === undefined) {
    throw new SabreGetSeatsMappingError([...legacyContractIssues(raw), 'response:required']);
  }

  const warnings: SabreGetSeatsWarning[] = [];
  if ((envelope.warnings?.length ?? 0) > 0) {
    warnings.push({ code: 'provider-warning', path: 'warnings' });
  }

  const response = envelope.response;
  const lookup = buildLookup(response, ctx, warnings);
  const located = locateSeatMaps(response, ctx, warnings);

  const segments: SeatMapSegment[] = [];
  for (const entry of located) {
    const stats: CabinStats = { freeSeats: 0 };
    const cabins = mapCabins(entry, lookup, warnings, stats);
    if (cabins.length === 0) {
      warnings.push({ code: 'seat-map-empty', path: entry.path });
      continue;
    }
    // Asientos libres y ninguno vendible no es un avión lleno: sin esta marca el mapa se pinta
    // todo en gris y el vendedor lee «no quedan asientos» cuando lo que pasa es que la tarifa, la
    // cuenta o la atribución de ofertas no deja vender ninguno.
    const sellable = cabins.some((cabin) =>
      cabin.rows.some((row) => row.seats.some((seat) => seat.available)),
    );
    const displayOnly = stats.freeSeats > 0 && !sellable;
    if (displayOnly) warnings.push({ code: 'seat-map-display-only', path: entry.path });
    segments.push({
      segmentRef: entry.segmentRef,
      legIndex: entry.legIndex,
      changeOfGauge: entry.changeOfGauge,
      displayOnly,
      cabins,
    });
  }
  segments.sort((a, b) => a.segmentRef - b.segmentRef || a.legIndex - b.legIndex);

  const candidate: SeatMap = {
    segments,
    warnings: [...new Set(warnings.map((warning) => warning.code))],
  };
  const checked = SeatMapSchema.safeParse(candidate);
  if (!checked.success) {
    throw new SabreGetSeatsMappingError(
      checked.error.issues.map(
        (issue) => `canonical.${issue.path.join('.') || '<root>'}:${issue.code}`,
      ),
    );
  }

  return {
    seatMap: checked.data,
    warnings,
    offerId: response.offerId,
    droppedSeatMaps: response.seatMaps.length - segments.length,
  };
}

/**
 * La página oficial «Get Seats Payload (2pax 2seg)» de la documentación v3 todavía muestra el
 * contrato v1 (`requestType`/`aLaCarteOffer`, docs/sabre/03 §4.1). Si Sabre contestara así es que
 * el PCC sólo tiene v1 habilitado (P-06), y el error tiene que decirlo con todas las letras en vez
 * de quedarse en «falta `segments`».
 */
function legacyContractIssues(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return [];
  const response = (raw as Record<string, unknown>)['response'];
  if (response === null || typeof response !== 'object') return [];
  return 'aLaCarteOffer' in response ? ['response.aLaCarteOffer:legacy_v1_contract'] : [];
}

// ---------------------------------------------------------------------------
// Segmentos y aviones
// ---------------------------------------------------------------------------

interface LocatedSeatMap {
  readonly node: SeatMapNode;
  readonly path: string;
  readonly segmentRef: number;
  readonly legIndex: number;
  readonly changeOfGauge: boolean;
}

/**
 * Ubica cada mapa en (segmento de la oferta, avión). El cambio de equipo se marca si Sabre lo
 * declara (`isChangeOfGauge`), si el segmento trae más de un `flightLeg` o si llegan mapas de
 * aviones distintos para el mismo segmento: cualquiera de las tres basta, porque no marcarlo deja
 * al pasajero sin asiento en la segunda mitad del vuelo.
 */
function locateSeatMaps(
  response: SeatAvailabilityResponse,
  ctx: SabreGetSeatsMapContext,
  warnings: SabreGetSeatsWarning[],
): LocatedSeatMap[] {
  const flat = (ctx.basis.itineraries ?? []).flatMap((itinerary) => itinerary.segments);
  const nodesById = new Map(response.segments.map((segment) => [segment.id, segment]));

  const pending: Omit<LocatedSeatMap, 'changeOfGauge'>[] = [];
  const legsBySegment = new Map<number, Set<number>>();
  const flagged = new Set<number>();
  const taken = new Set<string>();

  response.seatMaps.forEach((node, index) => {
    const path = `response.seatMaps.${String(index)}`;
    const segmentNode = nodesById.get(node.segmentRef);
    const segmentRef = ctx.segmentIndexById.get(node.segmentRef) ?? matchFlight(segmentNode, flat);
    if (segmentRef === undefined) {
      warnings.push({ code: 'seat-map-segment-unmatched', path: `${path}.segmentRef` });
      return;
    }

    const legs = segmentNode?.flightLegs ?? [];
    const legIndex = resolveLegIndex(node.flightLegRef, legs);
    if (legIndex === undefined) {
      warnings.push({ code: 'seat-map-leg-unmatched', path: `${path}.flightLegRef` });
      return;
    }

    const key = `${String(segmentRef)}:${String(legIndex)}`;
    if (taken.has(key)) {
      warnings.push({ code: 'seat-map-duplicate', path });
      return;
    }
    taken.add(key);

    if (segmentNode?.isChangeOfGauge === true || legs.length > 1) flagged.add(segmentRef);
    const seen = legsBySegment.get(segmentRef) ?? new Set<number>();
    seen.add(legIndex);
    legsBySegment.set(segmentRef, seen);
    pending.push({ node, path, segmentRef, legIndex });
  });

  return pending.map((entry) => ({
    ...entry,
    changeOfGauge:
      flagged.has(entry.segmentRef) || (legsBySegment.get(entry.segmentRef)?.size ?? 0) > 1,
  }));
}

/**
 * En NDC los segmentos llevan ids de la aerolínea (`BA0005`) y no los nuestros: se casan por
 * vuelo —transportista, número, ruta y fecha local de salida—, y sólo si el resultado es único.
 */
function matchFlight(node: SegmentNode | undefined, flat: readonly Segment[]): number | undefined {
  if (node === undefined) return undefined;
  const matches: number[] = [];
  flat.forEach((segment, index) => {
    const digits = /^\d+/.exec(segment.flightNumber)?.[0];
    if (
      segment.carrier === node.bookingAirlineCode &&
      digits !== undefined &&
      Number(digits) === node.bookingFlightNumber &&
      segment.origin === node.departureAirportCode &&
      segment.destination === node.arrivalAirportCode &&
      LOCAL_DATE.exec(segment.departureAt)?.[1] === node.departureDate
    ) {
      matches.push(index);
    }
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveLegIndex(
  flightLegRef: string | undefined,
  legs: readonly { id: string }[],
): number | undefined {
  if (flightLegRef !== undefined) {
    const index = legs.findIndex((leg) => leg.id === flightLegRef);
    if (index >= 0) return index;
  }
  return legs.length <= 1 ? 0 : undefined;
}

// ---------------------------------------------------------------------------
// Ofertas y precios
// ---------------------------------------------------------------------------

interface Lookup {
  readonly offerItems: ReadonlyMap<string, OfferItemNode>;
  readonly prices: ReadonlyMap<string, Money | undefined>;
  readonly passengerIndexById: ReadonlyMap<string, number>;
  /** Para avisar una vez por id y no una vez por asiento: 300 asientos repiten la misma referencia. */
  readonly warned: Set<string>;
}

function buildLookup(
  response: SeatAvailabilityResponse,
  ctx: SabreGetSeatsMapContext,
  warnings: SabreGetSeatsWarning[],
): Lookup {
  const priceDefinitions = new Map(
    (response.priceDefinitions ?? []).map((definition) => [definition.id, definition]),
  );
  const offerItems = new Map<string, OfferItemNode>();
  const prices = new Map<string, Money | undefined>();
  response.offerItems.forEach((item, index) => {
    offerItems.set(item.id, item);
    const path = `response.offerItems.${String(index)}`;
    prices.set(item.id, priceOf(item, priceDefinitions, path, warnings));
  });
  return {
    offerItems,
    prices,
    passengerIndexById: ctx.passengerIndexById,
    warned: new Set<string>(),
  };
}

function priceOf(
  item: OfferItemNode,
  definitions: ReadonlyMap<string, PriceDefinitionNode>,
  path: string,
  warnings: SabreGetSeatsWarning[],
): Money | undefined {
  const undetermined = (detail: string): undefined => {
    warnings.push({ code: 'seat-price-undetermined', path, detail });
    return undefined;
  };
  if (item.priceDefinitionRef === undefined) return undetermined('sin priceDefinitionRef');
  const definition = definitions.get(item.priceDefinitionRef);
  if (definition === undefined) return undetermined('priceDefinition ausente');

  const currency = definition.currencyCode?.trim().toUpperCase();
  if (currency === undefined || !CURRENCY.test(currency)) return undetermined('sin moneda');
  const amount = definition.totalPrice?.amount;
  if (amount === undefined) return undetermined('sin importe');

  const minor = amountToMinor(amount);
  if (minor === null) return undetermined('importe no representable');
  return { amountMinor: minor, currency };
}

/**
 * Importe → unidades menores, con aritmética de enteros sobre el TEXTO: `19.99 * 100` en coma
 * flotante da `1998.9999999999998`. Un número JSON se pasa a texto con `String`, que da la
 * representación más corta que lo reproduce (`37.0` → `"37"`).
 *
 * Un tercer decimal distinto de cero no se redondea y un negativo no es un precio de asiento:
 * los dos quedan «no informado», que el selector trata como «con cargo».
 */
function amountToMinor(amount: number | string): number | null {
  const text = typeof amount === 'number' ? String(amount) : amount.trim();
  const match = AMOUNT.exec(text);
  const units = match?.[1];
  if (match === null || units === undefined) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0');
  if (fraction.charAt(2) !== '0') return null;
  return Number(units) * 100 + Number(fraction.slice(0, 2));
}

function resolveOffers(
  seat: SeatNode,
  seatMapSegmentRef: string,
  lookup: Lookup,
  path: string,
  warnings: SabreGetSeatsWarning[],
): SeatOffer[] {
  const offers: SeatOffer[] = [];
  const seen = new Set<number>();
  const warnOnce = (code: SabreGetSeatsWarningCode, key: string, at: string): void => {
    const token = `${code}|${key}`;
    if (lookup.warned.has(token)) return;
    lookup.warned.add(token);
    warnings.push({ code, path: at });
  };

  (seat.offerItemRefIds ?? []).forEach((ref, refIndex) => {
    const refPath = `${path}.offerItemRefIds.${String(refIndex)}`;
    const item = lookup.offerItems.get(ref);
    if (item === undefined) {
      warnOnce('seat-offer-item-missing', ref, refPath);
      return;
    }
    if (!item.segmentRefs.includes(seatMapSegmentRef)) {
      warnOnce('seat-offer-segment-mismatch', `${ref}|${seatMapSegmentRef}`, refPath);
      return;
    }
    const price = lookup.prices.get(item.id);
    for (const passengerRef of item.passengerRefs) {
      const passengerIndex = lookup.passengerIndexById.get(passengerRef);
      if (passengerIndex === undefined) {
        warnOnce('seat-offer-passenger-unknown', passengerRef, refPath);
        continue;
      }
      if (seen.has(passengerIndex)) {
        warnings.push({ code: 'seat-offer-duplicate-passenger', path: refPath });
        continue;
      }
      seen.add(passengerIndex);
      offers.push({ passengerIndex, offerRef: item.id, ...(price === undefined ? {} : { price }) });
    }
  });

  return offers.sort((a, b) => a.passengerIndex - b.passengerIndex);
}

// ---------------------------------------------------------------------------
// Cabinas, filas y asientos
// ---------------------------------------------------------------------------

/** Lo que el canónico no guarda por asiento pero el segmento necesita para su `displayOnly`. */
interface CabinStats {
  /** Asientos que llegan al canónico libres, operativos y sin restricción general. */
  freeSeats: number;
}

function mapCabins(
  entry: LocatedSeatMap,
  lookup: Lookup,
  warnings: SabreGetSeatsWarning[],
  stats: CabinStats,
): SeatMapCabin[] {
  const cabins: SeatMapCabin[] = [];
  (entry.node.cabinCompartments ?? []).forEach((compartment, index) => {
    const path = `${entry.path}.cabinCompartments.${String(index)}`;
    const cabin = mapCabin(compartment, entry.node.segmentRef, lookup, path, warnings, stats);
    if (cabin !== null) cabins.push(cabin);
  });
  return cabins;
}

function mapCabin(
  compartment: CabinCompartmentNode,
  seatMapSegmentRef: string,
  lookup: Lookup,
  path: string,
  warnings: SabreGetSeatsWarning[],
  stats: CabinStats,
): SeatMapCabin | null {
  const rowsIn = compartment.seatRows ?? [];
  const layout = resolveColumns(compartment, rowsIn);
  if (layout.columns.length === 0) {
    warnings.push({ code: 'cabin-columns-missing', path });
    return null;
  }

  const cabinCode = compartment.cabinCode?.trim().toUpperCase();
  const cabinClass = cabinCode === undefined ? undefined : CABIN_BY_SEAT_MAP_CODE[cabinCode];
  if (cabinClass === undefined) {
    warnings.push({
      code: 'cabin-code-unknown',
      path: `${path}.cabinCode`,
      ...(cabinCode === undefined ? {} : { detail: cabinCode.slice(0, 3) }),
    });
  }

  const exitRanges = compartment.cabinLayout?.exitRowPosition ?? [];
  const order = new Map(layout.columns.map((column, index) => [column, index]));
  const rows: SeatRow[] = [];
  const rowNumbers = new Set<number>();

  rowsIn.forEach((rowNode, rowIndex) => {
    const rowPath = `${path}.seatRows.${String(rowIndex)}`;
    if (rowNumbers.has(rowNode.row)) {
      warnings.push({ code: 'seat-row-duplicate', path: rowPath });
      return;
    }
    rowNumbers.add(rowNode.row);
    const exitRow =
      codesOf(rowNode.characteristics).has(CODE.exitRow) ||
      exitRanges.some((range) => rowNode.row >= range.firstRow && rowNode.row <= range.lastRow);

    const seats: Seat[] = [];
    const columnsTaken = new Set<string>();
    rowNode.seats.forEach((seatNode, seatIndex) => {
      const seatPath = `${rowPath}.seats.${String(seatIndex)}`;
      const codes = codesOf(seatNode.characteristics);
      if (seatNode.occupationStatusCode === STATUS_NO_SEAT || codes.has(CODE_NO_SEAT)) return;
      const column = seatNode.column.trim().toUpperCase();
      if (!order.has(column)) {
        warnings.push({ code: 'seat-column-unlisted', path: `${seatPath}.column` });
        return;
      }
      if (columnsTaken.has(column)) {
        warnings.push({ code: 'seat-column-duplicate', path: `${seatPath}.column` });
        return;
      }
      columnsTaken.add(column);
      if (isFreeSeat(seatNode, codes)) stats.freeSeats += 1;
      seats.push(
        mapSeat({
          seatNode,
          column,
          codes,
          exitRow,
          position: layout.positions.get(column) ?? new Set(),
          offers: () => resolveOffers(seatNode, seatMapSegmentRef, lookup, seatPath, warnings),
        }),
      );
    });

    seats.sort((a, b) => (order.get(a.column) ?? 0) - (order.get(b.column) ?? 0));
    rows.push({ number: rowNode.row, seats });
  });

  if (rows.length === 0) return null;
  rows.sort((a, b) => a.number - b.number);
  return {
    ...(cabinClass === undefined ? {} : { cabin: cabinClass }),
    columns: layout.columns,
    aisleAfter: aislesOf(layout.columns, layout.positions),
    rows,
  };
}

interface ColumnLayout {
  readonly columns: string[];
  /** Posiciones de cada columna (`A`/`W`/`C`/`9`). Vacías si nadie las informó. */
  readonly positions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Columnas de izquierda a derecha: las del `cabinLayout`, si no `columnIds`, y si tampoco, las
 * que usan los asientos en orden alfabético. Las posiciones salen del layout; sin layout se
 * deducen de las características de los asientos de cada columna, que dicen lo mismo.
 */
function resolveColumns(
  compartment: CabinCompartmentNode,
  rows: readonly SeatRowNode[],
): ColumnLayout {
  const positions = new Map<string, Set<string>>();
  const layoutColumns = compartment.cabinLayout?.columns;
  if (layoutColumns !== undefined) {
    const columns: string[] = [];
    for (const column of layoutColumns) {
      const id = column.id.trim().toUpperCase();
      if (!COLUMN.test(id) || positions.has(id)) continue;
      const raw = column.position;
      const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      positions.set(id, new Set(list.map((value) => value.trim().toUpperCase())));
      columns.push(id);
    }
    return { columns, positions };
  }

  const declared = (compartment.columnIds ?? []).map((id) => id.trim().toUpperCase());
  const fromSeats = rows.flatMap((row) =>
    row.seats.map((seat) => seat.column.trim().toUpperCase()),
  );
  const columns = [...new Set(declared.length > 0 ? declared : fromSeats.sort())].filter((id) =>
    COLUMN.test(id),
  );
  for (const row of rows) {
    for (const seat of row.seats) {
      const id = seat.column.trim().toUpperCase();
      const codes = codesOf(seat.characteristics);
      const set = positions.get(id) ?? new Set<string>();
      if (codes.has(CODE.aisle)) set.add(POSITION.aisle);
      if (codes.has(CODE.window)) set.add(POSITION.window);
      if (codes.has(CODE.center)) set.add(CODE.center);
      positions.set(id, set);
    }
  }
  return { columns, positions };
}

/** Hay pasillo entre dos columnas vecinas cuando las dos son de pasillo. */
function aislesOf(
  columns: readonly string[],
  positions: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const out: string[] = [];
  for (let index = 0; index + 1 < columns.length; index += 1) {
    const left = columns[index];
    const right = columns[index + 1];
    if (left === undefined || right === undefined) continue;
    if (positions.get(left)?.has(POSITION.aisle) && positions.get(right)?.has(POSITION.aisle)) {
      out.push(left);
    }
  }
  return out;
}

interface SeatInput {
  readonly seatNode: SeatNode;
  readonly column: string;
  readonly codes: ReadonlySet<string>;
  readonly exitRow: boolean;
  readonly position: ReadonlySet<string>;
  /** Perezoso: un asiento no disponible no consulta ofertas ni emite avisos de precio. */
  readonly offers: () => SeatOffer[];
}

function mapSeat(input: SeatInput): Seat {
  const { seatNode, column, codes, position } = input;
  const exit = input.exitRow || codes.has(CODE.exitRow);

  // Sin ningún código de ubicación, la columna del layout dice dónde está el asiento. Con `1W`
  // no: la ventana que no existe no se promete ni por la columna.
  const located = [CODE.window, CODE.aisle, CODE.center, CODE.windowWithoutWindow].some((code) =>
    codes.has(code),
  );
  const window = located
    ? codes.has(CODE.window) && !codes.has(CODE.windowWithoutWindow)
    : position.has(POSITION.window);
  const aisle = located ? codes.has(CODE.aisle) : position.has(POSITION.aisle);
  const middle = located
    ? codes.has(CODE.center)
    : [...POSITION.center].some((value) => position.has(value));

  const characteristics: SeatCharacteristic[] = [];
  if (window) characteristics.push('WINDOW');
  if (aisle) characteristics.push('AISLE');
  if (middle) characteristics.push('MIDDLE');
  if (exit) characteristics.push('EXIT_ROW');
  if (codes.has(CODE.legSpace)) characteristics.push('EXTRA_LEGROOM');
  if (codes.has(CODE.bassinet)) characteristics.push('BASSINET');
  if (codes.has(CODE.noRecline)) characteristics.push('NO_RECLINE');

  const offers = isFreeSeat(seatNode, codes) ? input.offers() : [];

  return {
    column,
    available: offers.length > 0,
    characteristics,
    adultOnly: exit || codes.has(CODE.notForChild),
    infantAllowed: !(exit || codes.has(CODE.noInfant)),
    offers,
  };
}

/**
 * Libre, operativo y sin restricción general: el avión tiene ese asiento para alguien. Que se le
 * pueda vender a uno de NUESTROS pasajeros lo deciden después sus ofertas.
 */
function isFreeSeat(seatNode: SeatNode, codes: ReadonlySet<string>): boolean {
  return (
    seatNode.occupationStatusCode === STATUS_FREE &&
    seatNode.isOperative !== false &&
    !codes.has(CODE.restricted)
  );
}

function codesOf(characteristics: readonly { code: string }[] | undefined): Set<string> {
  return new Set((characteristics ?? []).map((item) => item.code.trim().toUpperCase()));
}
