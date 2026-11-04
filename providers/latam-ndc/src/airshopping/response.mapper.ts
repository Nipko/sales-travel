import type { CabinClass, Itinerary, Offer, Segment } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';
import { LatamApiError, LatamBusinessError } from '../errors';
import {
  buildFareBreakdown,
  buildFareComponents,
  readFareLists,
  type FareLists,
  type OfferLeg,
} from './fare-components';
import { arr, attr, collect, dateTimeWithOffset, latamErrors, money, pick, text } from '../xml';

export const AIRSHOPPING_PATH = '/ndc/v192/airshopping';

/**
 * Códigos con los que LATAM dice «no vendo esa ruta o esa fecha» (`[portal:/ndc/air-shopping-v2]`,
 * Error Handling). Son una respuesta válida sin vuelos, no una falla del proveedor.
 */
export const LATAM_NO_AVAILABILITY_CODES = ['404122006', '404122007'] as const;

/**
 * Mapea `IATA_AirShoppingRS` (API v2) al modelo canónico.
 *
 * Forma de LATAM v2 (`[portal:/ndc/air-shopping-v2]`):
 *   Response/OffersGroup/CarrierOffers/Offer[]
 *     OfferID (UUID) · TotalPrice (de TODOS los pasajeros)
 *     OfferItem[] — UNO POR TRAYECTO, con todos los pasajeros:
 *       Service[]/ServiceAssociations/PaxJourneyRefID
 *       FareDetail[] — uno por grupo de pasajeros: PaxRefID[], FareRefText (marca),
 *                      FareComponent (FareBasisCode, RBD, PriceClassRefID, FareRule/PenaltyRefID)
 *       ChangeRestrictions[] / CancelRestrictions[] — uno por pasajero
 *   Response/DataLists/ PaxSegmentList · PaxJourneyList · PriceClassList · BaggageAllowanceList ·
 *                       PenaltyList · FareList · ServiceDefinitionList
 *
 * Errores: los de «no hay vuelos» devuelven lista vacía; cualquier otro `<Error>` se LANZA como
 * {@link LatamBusinessError}. Antes se devolvía `[]` y la búsqueda decía «LATAM: 0 vuelos» ante
 * un error de credenciales o de punto de venta.
 */
export interface MapResult {
  offers: Offer[];
  warnings: string[];
}

export function mapAirShoppingResponse(
  raw: unknown,
  criteria: FlightSearchCriteria,
  tenantId: string,
  trackId?: string,
): MapResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_AirShoppingRS', 'AirShoppingRS');
  if (!root) {
    throw new LatamApiError(200, 'respuesta sin IATA_AirShoppingRS', AIRSHOPPING_PATH);
  }

  const errors = latamErrors(root);
  if (errors.length > 0) {
    if (errors.every((e) => (LATAM_NO_AVAILABILITY_CODES as readonly string[]).includes(e.code))) {
      return { offers: [], warnings: errors.map((e) => `${e.code}: ${e.desc}`) };
    }
    throw new LatamBusinessError(errors, AIRSHOPPING_PATH, trackId);
  }

  const response = pick(root, 'Response');
  if (!response) {
    throw new LatamApiError(200, 'AirShoppingRS sin Response', AIRSHOPPING_PATH);
  }

  const segmentMap = buildSegmentMap(response, warnings);
  const journeyMap = buildJourneyMap(response, segmentMap);
  const priceClassMap = buildPriceClassMap(response);
  const baggageMap = buildBaggageAllowanceMap(response);
  const fareLists = readFareLists(response);

  const offerNodes = collect(response, ['OffersGroup', 'CarrierOffers'], 'Offer');
  if (offerNodes.length === 0) {
    return { offers: [], warnings: [...warnings, 'No offers in response.'] };
  }

  const offers: Offer[] = [];
  const fetchedAt = new Date().toISOString();

  for (const node of offerNodes) {
    try {
      const offer = mapOneOffer({
        node: node as Record<string, unknown>,
        journeyMap,
        priceClassMap,
        baggageMap,
        fareLists,
        tenantId,
        fetchedAt,
      });
      if (offer) offers.push(offer);
    } catch (err) {
      warnings.push(`offer skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // LATAM cotiza en la moneda del punto de venta con que dio de alta la cuenta de la agencia, no
  // en la que pedimos: no hay campo de moneda en el request (§ «Moneda» de docs/latam-ndc). El
  // aviso se conserva para que la diferencia quede a la vista.
  const responseCurrency = offers[0]?.total.currency;
  if (
    responseCurrency &&
    criteria.currency &&
    responseCurrency !== criteria.currency.toUpperCase()
  ) {
    warnings.push(
      `currency mismatch: requested ${criteria.currency.toUpperCase()}, LATAM returned ${responseCurrency}`,
    );
  }

  return { offers, warnings };
}

// ---- Offer ----

function mapOneOffer(args: {
  node: Record<string, unknown>;
  journeyMap: Map<string, KeyedSegment[]>;
  priceClassMap: Map<string, PriceClassInfo>;
  baggageMap: Map<string, BaggageInfo>;
  fareLists: FareLists;
  tenantId: string;
  fetchedAt: string;
}): Offer | null {
  const offerRef = text(args.node.OfferID);
  if (!offerRef) return null;

  const tp = args.node.TotalPrice as Record<string, unknown> | undefined;
  if (!tp) return null;
  const total = money(tp.TotalAmount);
  if (!total) return null;

  const baseFare = money(tp.BaseAmount) ?? total;
  const declaredTaxes = money(pick(tp.TaxSummary, 'TotalTaxAmount'));
  const taxes =
    declaredTaxes && declaredTaxes.currency === total.currency
      ? declaredTaxes
      : {
          amountMinor: Math.max(0, total.amountMinor - baseFare.amountMinor),
          currency: total.currency,
        };

  const offerItems = arr<Record<string, unknown>>(args.node.OfferItem);
  const { itineraries, legs } = buildItineraries(offerItems, args.journeyMap);
  if (itineraries.length === 0) return null;
  const flatKeys = legs.flatMap((l) => l.segmentKeys);
  const fareComponents = buildFareComponents(legs, flatKeys, args.node, args.fareLists);
  const fareBreakdown = buildFareBreakdown(offerItems, args.fareLists, total);

  // OfferPrice tampoco trae vigencia; la de 30 min es política NUESTRA y se marca como tal.
  const declared = attr(pick(args.node.TimeLimits, 'OfferExpiration'), 'DateTime');
  const expiresAt = declared ?? new Date(Date.now() + 30 * 60_000).toISOString();
  const expiresAtSource = declared === undefined ? 'platform-policy' : 'provider';

  const fareFamily = extractFareFamily(offerItems, args.priceClassMap);
  const baggage = extractOfferBaggage(args.node, args.baggageMap);
  const policies = extractPolicies(offerItems);

  // `OfferID|item1,item2`: el OfferID es un UUID y los OfferItemID traen `|` pero nunca `,`.
  const itemIds = offerItems.map((item) => text(item.OfferItemID) ?? '').filter(Boolean);
  const encodedRef = itemIds.length > 0 ? `${offerRef}|${itemIds.join(',')}` : offerRef;

  return {
    id: randomUUID(),
    tenantId: args.tenantId,
    products: ['flight'],
    provider: { name: 'latam-ndc', offerRef: encodedRef },
    total,
    baseFare,
    taxes,
    itineraries,
    ...(fareBreakdown ? { fareBreakdown } : {}),
    ...(fareFamily ? { fareFamily } : {}),
    ...(fareComponents ? { fareComponents } : {}),
    ...(baggage ? { baggage } : {}),
    ...(policies ? { policies } : {}),
    fetchedAt: args.fetchedAt,
    expiresAt,
    expiresAtSource,
  };
}

// ---- Itinerarios ----

/**
 * Un itinerario por trayecto (`PaxJourney`), ordenados por salida. La clase de reserva de cada
 * segmento sale del `FareComponent` del OfferItem —es de la tarifa, no del vuelo: el mismo vuelo
 * va en Q en una oferta y en Y en otra—.
 */
function buildItineraries(
  offerItems: Record<string, unknown>[],
  journeyMap: Map<string, KeyedSegment[]>,
): { itineraries: Itinerary[]; legs: OfferLeg[] } {
  const built: { itinerary: Itinerary; leg: OfferLeg }[] = [];
  const seen = new Set<string>();

  for (const item of offerItems) {
    const rbdBySegment = rbdBySegmentRef(item);
    for (const svc of arr<Record<string, unknown>>(item.Service)) {
      const refs = arr<unknown>(pick(svc.ServiceAssociations, 'PaxJourneyRefID'))
        .map((r) => text(r))
        .filter((r): r is string => Boolean(r));
      for (const jRef of refs) {
        if (seen.has(jRef)) continue;
        seen.add(jRef);
        const base = journeyMap.get(jRef);
        if (!base || base.length === 0) continue;
        const segments = base.map((s) => {
          const rbd = rbdBySegment.get(s.key);
          return rbd ? { ...s.segment, bookingClass: rbd } : s.segment;
        });
        built.push({
          itinerary: {
            segments,
            totalDurationMinutes: journeyDuration(segments),
            stops: Math.max(0, segments.length - 1),
          },
          leg: { item, journeyId: jRef, segmentKeys: base.map((s) => s.key) },
        });
      }
    }
  }

  built.sort(
    (a, b) =>
      Date.parse(a.itinerary.segments[0]!.departureAt) -
      Date.parse(b.itinerary.segments[0]!.departureAt),
  );
  return { itineraries: built.map((b) => b.itinerary), legs: built.map((b) => b.leg) };
}

function journeyDuration(segments: Segment[]): number {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return 0;
  const span = Math.round((Date.parse(last.arrivalAt) - Date.parse(first.departureAt)) / 60_000);
  return Number.isFinite(span) && span > 0
    ? span
    : segments.reduce((sum, s) => sum + s.durationMinutes, 0);
}

function rbdBySegmentRef(item: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const fd of arr<Record<string, unknown>>(item.FareDetail)) {
    for (const fc of arr<Record<string, unknown>>(fd.FareComponent)) {
      const rbd = text(pick(fc.RBD, 'RBD_Code'))?.trim().toUpperCase();
      if (!rbd || !/^[A-Z]$/.test(rbd)) continue;
      for (const ref of arr<unknown>(fc.PaxSegmentRefID)) {
        const key = text(ref);
        if (key && !map.has(key)) map.set(key, rbd);
      }
    }
  }
  return map;
}

// ---- Segmentos y trayectos ----

interface KeyedSegment {
  key: string;
  segment: Segment;
}

function buildJourneyMap(
  response: unknown,
  segmentMap: Map<string, Segment>,
): Map<string, KeyedSegment[]> {
  const map = new Map<string, KeyedSegment[]>();
  for (const j of collect(response, ['DataLists', 'PaxJourneyList'], 'PaxJourney')) {
    const node = j as Record<string, unknown>;
    const journeyId = text(node.PaxJourneyID);
    if (!journeyId) continue;
    const segments: KeyedSegment[] = [];
    for (const ref of arr<unknown>(node.PaxSegmentRefID)) {
      const key = text(ref);
      const segment = key ? segmentMap.get(key) : undefined;
      if (key && segment) segments.push({ key, segment });
    }
    if (segments.length > 0) map.set(journeyId, segments);
  }
  return map;
}

function buildSegmentMap(response: unknown, warnings: string[]): Map<string, Segment> {
  const map = new Map<string, Segment>();
  for (const s of collect(response, ['DataLists', 'PaxSegmentList'], 'PaxSegment')) {
    const seg = mapPaxSegment(s as Record<string, unknown>);
    if (!seg.ok) {
      warnings.push(`segment skipped: ${seg.reason}`);
      continue;
    }
    map.set(seg.key, seg.segment);
  }
  return map;
}

type SegResult = { ok: true; key: string; segment: Segment } | { ok: false; reason: string };

/** Mapea un `PaxSegment` de LATAM. Exportado para OfferPrice/OrderView, que traen la misma forma. */
export function mapPaxSegment(node: Record<string, unknown>): SegResult {
  const key = text(node.PaxSegmentID);
  if (!key) return { ok: false, reason: 'no PaxSegmentID' };

  const origin = text(pick(node.Dep, 'IATA_LocationCode'));
  const destination = text(pick(node.Arrival, 'IATA_LocationCode'));
  if (!origin || !destination) return { ok: false, reason: `${key}: no Dep/Arrival code` };

  const departureAt = dateTimeWithOffset(pick(node.Dep, 'AircraftScheduledDateTime'));
  const arrivalAt = dateTimeWithOffset(pick(node.Arrival, 'AircraftScheduledDateTime'));
  if (!departureAt || !arrivalAt) {
    return { ok: false, reason: `${key}: no times with TimeZoneCode` };
  }

  const carrier = text(pick(node.MarketingCarrierInfo, 'CarrierDesigCode'));
  const flightNumber = text(pick(node.MarketingCarrierInfo, 'MarketingCarrierFlightNumberText'));
  if (!carrier || !flightNumber) return { ok: false, reason: `${key}: no carrier info` };

  const durationMinutes =
    parseDuration(text(node.Duration)) ?? computeDurationMinutes(departureAt, arrivalAt);

  const operatingCarrier = text(pick(node.OperatingCarrierInfo, 'CarrierDesigCode'));
  const operatingFlightNumber = text(
    pick(node.OperatingCarrierInfo, 'OperatingCarrierFlightNumberText'),
  );
  const aircraft = arr(node.DatedOperatingLeg)
    .map((leg) => text(pick(pick(leg, 'CarrierAircraftType'), 'CarrierAircraftTypeCode')))
    .find(Boolean);
  const cabinNode = node.CabinType;

  return {
    ok: true,
    key,
    segment: {
      carrier,
      flightNumber: String(flightNumber),
      origin,
      destination,
      departureAt,
      arrivalAt,
      durationMinutes,
      cabin: mapCabin(
        text(pick(cabinNode, 'CabinTypeCode')) ?? text(pick(cabinNode, 'CabinTypeName')),
      ),
      // La clase real la pone el OfferItem (`rbdBySegmentRef`); 'Y' queda sólo si no la informa.
      bookingClass: 'Y',
      ...(aircraft ? { aircraft } : {}),
      ...(operatingCarrier && operatingCarrier !== carrier ? { operatingCarrier } : {}),
      ...(operatingFlightNumber && /^\d{1,4}[A-Z]?$/.test(operatingFlightNumber)
        ? { operatingFlightNumber }
        : {}),
    },
  };
}

// ---- Marca, equipaje y políticas ----

interface PriceClassInfo {
  name: string;
  cabin: CabinClass;
}

interface BaggageInfo {
  type: 'CarryOn' | 'Checked' | 'PersonalItem';
  qty: number;
  weightKg?: number;
}

function buildPriceClassMap(response: unknown): Map<string, PriceClassInfo> {
  const map = new Map<string, PriceClassInfo>();
  for (const pc of collect(response, ['DataLists', 'PriceClassList'], 'PriceClass')) {
    const node = pc as Record<string, unknown>;
    const id = text(node.PriceClassID);
    const name = text(node.Name);
    if (!id || !name) continue;
    map.set(id, {
      name,
      cabin: mapCabin(
        text(pick(node.CabinType, 'CabinTypeCode')) ?? text(pick(node.CabinType, 'CabinTypeName')),
      ),
    });
  }
  return map;
}

function buildBaggageAllowanceMap(response: unknown): Map<string, BaggageInfo> {
  const map = new Map<string, BaggageInfo>();
  for (const ba of collect(response, ['DataLists', 'BaggageAllowanceList'], 'BaggageAllowance')) {
    const node = ba as Record<string, unknown>;
    const id = text(node.BaggageAllowanceID);
    if (!id) continue;

    const qty = Number(text(pick(node.PieceAllowance, 'TotalQty')) ?? 0);
    // LATAM manda el artículo personal también con TypeCode=CarryOn; sólo el id los distingue.
    let type: BaggageInfo['type'] = 'CarryOn';
    if (text(node.TypeCode) === 'Checked') type = 'Checked';
    else if (id.includes('PERSONAL_ITEM') && !id.includes('CARRY_ON')) type = 'PersonalItem';

    let weightKg: number | undefined;
    for (const w of arr<Record<string, unknown>>(node.WeightAllowance)) {
      const measure = w.MaximumWeightMeasure;
      if (attr(measure, 'UnitCode') === 'KG') {
        const kg = Number(text(measure));
        if (Number.isFinite(kg)) weightKg = kg;
        break;
      }
    }

    map.set(id, {
      type,
      qty: Number.isFinite(qty) ? qty : 0,
      ...(weightKg !== undefined ? { weightKg } : {}),
    });
  }
  return map;
}

function extractFareFamily(
  offerItems: Record<string, unknown>[],
  priceClassMap: Map<string, PriceClassInfo>,
): Offer['fareFamily'] {
  for (const item of offerItems) {
    for (const fd of arr<Record<string, unknown>>(item.FareDetail)) {
      const fareRefText = text(fd.FareRefText);
      for (const fc of arr<Record<string, unknown>>(fd.FareComponent)) {
        const pcId = text(fc.PriceClassRefID);
        const pc = pcId ? priceClassMap.get(pcId) : undefined;
        if (pc) return { name: fareRefText ?? pc.name, cabin: pc.cabin };
      }
      if (fareRefText) return { name: fareRefText, cabin: 'economy' };
    }
  }
  return undefined;
}

function extractOfferBaggage(
  node: Record<string, unknown>,
  baggageMap: Map<string, BaggageInfo>,
): Offer['baggage'] {
  const refs = arr<Record<string, unknown>>(node.BaggageAllowance);
  if (refs.length === 0) return undefined;

  let personalItem = 0;
  let carryOnQty = 0;
  let carryOnWeight: number | undefined;
  let checkedQty = 0;
  let checkedWeight: number | undefined;

  for (const ref of refs) {
    const refId = text(ref.BaggageAllowanceRefID);
    const info = refId ? baggageMap.get(refId) : undefined;
    if (!info) continue;
    if (info.type === 'PersonalItem' && info.qty > personalItem) {
      personalItem = info.qty;
    } else if (info.type === 'CarryOn' && info.qty > carryOnQty) {
      carryOnQty = info.qty;
      carryOnWeight = info.weightKg;
    } else if (info.type === 'Checked' && info.qty > checkedQty) {
      checkedQty = info.qty;
      checkedWeight = info.weightKg;
    }
  }

  return {
    personalItem,
    carryOn: {
      qty: carryOnQty,
      ...(carryOnWeight !== undefined ? { weightKg: carryOnWeight } : {}),
    },
    checked: {
      qty: checkedQty,
      ...(checkedWeight !== undefined ? { weightKg: checkedWeight } : {}),
    },
  };
}

/**
 * ¿Se puede cambiar / reembolsar? LATAM manda `ChangeRestrictions` y `CancelRestrictions` como
 * LISTA, una entrada por pasajero y por trayecto, con `AllowedModificationInd`. Leerlas como un
 * solo objeto daba `undefined` → «no permitido» en tarifas que sí permiten cambios.
 *
 * La oferta permite algo sólo si TODAS las entradas lo permiten: un ida y vuelta con un trayecto
 * no cambiable no es cambiable sin más. Sin entradas, el dato es «no informado» (`undefined`).
 */
export function extractPolicies(offerItems: Record<string, unknown>[]): Offer['policies'] {
  const verdict = (field: 'ChangeRestrictions' | 'CancelRestrictions'): boolean | undefined => {
    const values: boolean[] = [];
    for (const item of offerItems) {
      for (const entry of arr<Record<string, unknown>>(item[field])) {
        const ind = entry.AllowedModificationInd;
        if (ind === true || ind === 'true') values.push(true);
        else if (ind === false || ind === 'false') values.push(false);
      }
    }
    return values.length === 0 ? undefined : values.every(Boolean);
  };

  const changeable = verdict('ChangeRestrictions');
  const refundable = verdict('CancelRestrictions');
  if (changeable === undefined && refundable === undefined) return undefined;
  return {
    ...(changeable === undefined ? {} : { changeable }),
    ...(refundable === undefined ? {} : { refundable }),
  };
}

// ---- helpers ----

function parseDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!m) return null;
  const minutes = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return minutes > 0 ? minutes : null;
}

function computeDurationMinutes(dep: string, arr: string): number {
  return Math.max(1, Math.round((Date.parse(arr) - Date.parse(dep)) / 60_000));
}

function mapCabin(name: string | undefined): CabinClass {
  const n = (name ?? '').toLowerCase();
  if (n.includes('first') || n === 'f') return 'first';
  if (n.includes('business') || n === 'j' || n === 'c') return 'business';
  if (n.includes('premium') || n === 'w') return 'premium_economy';
  return 'economy';
}
