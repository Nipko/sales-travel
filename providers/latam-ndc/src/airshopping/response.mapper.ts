import type { CabinClass, Itinerary, Money, Offer, Segment } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';

/**
 * Mapea la respuesta IATA_AirShoppingRS de LATAM al modelo canónico.
 *
 * Estructura real de LATAM v192:
 *   IATA_AirShoppingRS
 *     Response
 *       OffersGroup
 *         CarrierOffers
 *           Offer[] → { OfferID, TotalPrice{BaseAmount,TotalAmount}, OfferItem[] }
 *       DataLists
 *         PaxSegmentList → PaxSegment[] (con PaxSegmentID hijo, Dep, Arrival)
 *         PaxJourneyList → PaxJourney[] (con PaxJourneyID, PaxSegmentRefID)
 *         PriceClassList → PriceClass[] (nombre de tarifa: BASIC, LIGHT, FULL)
 *         BaggageAllowanceList
 */
export interface MapResult {
  offers: Offer[];
  warnings: string[];
}

export function mapAirShoppingResponse(
  raw: unknown,
  criteria: FlightSearchCriteria,
  tenantId: string,
): MapResult {
  const warnings: string[] = [];
  const root = pick(raw, 'IATA_AirShoppingRS', 'AirShoppingRS');
  if (!root) {
    return {
      offers: [],
      warnings: ['No IATA_AirShoppingRS root element. Probable error response.'],
    };
  }

  const errorNode = pick(root, 'Error') as { Code?: string; DescText?: string } | undefined;
  if (errorNode) {
    return {
      offers: [],
      warnings: [`LATAM error ${errorNode.Code ?? '?'}: ${errorNode.DescText ?? 'unknown'}`],
    };
  }

  const response = pick(root, 'Response');
  if (!response) {
    return { offers: [], warnings: ['No Response element in AirShoppingRS.'] };
  }

  const segmentMap = buildSegmentMap(response, warnings);
  const journeyMap = buildJourneyMap(response, segmentMap, warnings);
  const priceClassMap = buildPriceClassMap(response);
  const baggageMap = buildBaggageAllowanceMap(response);

  const offerNodes =
    collect(response, ['OffersGroup', 'CarrierOffers'], 'Offer').length > 0
      ? collect(response, ['OffersGroup', 'CarrierOffers'], 'Offer')
      : collect(response, ['OffersGroup', 'AirlineOffers'], 'Offer');

  if (offerNodes.length === 0) {
    return { offers: [], warnings: [...warnings, 'No offers in response.'] };
  }

  const offers: Offer[] = [];
  const fetchedAt = new Date().toISOString();

  for (const node of offerNodes) {
    try {
      const offer = mapOneOffer({
        node: node as OfferNode,
        journeyMap,
        priceClassMap,
        baggageMap,
        criteria,
        tenantId,
        fetchedAt,
      });
      if (offer) offers.push(offer);
    } catch (err) {
      warnings.push(`offer skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { offers, warnings };
}

// ---- Offer mapping ----

interface TotalPriceNode {
  TotalAmount?: string | number | { '#text'?: string | number; '@_CurCode'?: string };
  BaseAmount?: string | number | { '#text'?: string | number; '@_CurCode'?: string };
  TaxSummary?: {
    TotalTaxAmount?: string | number | { '#text'?: string | number; '@_CurCode'?: string };
  };
  SimpleCurrencyPrice?: { '#text'?: string | number; '@_Code'?: string };
}

interface OfferNode {
  OfferID?: string;
  TotalPrice?: TotalPriceNode;
  OfferItem?: unknown;
  BaggageAllowance?: unknown;
  TimeLimits?: { OfferExpiration?: { '@_DateTime'?: string } };
}

function extractMoney(amountNode: unknown, currencyHint?: string): Money | null {
  if (amountNode === undefined || amountNode === null) return null;

  let value: number;
  let currency: string;

  if (typeof amountNode === 'object' && amountNode !== null) {
    const obj = amountNode as Record<string, unknown>;
    const text = obj['#text'] ?? obj[''];
    value = Number(text);
    const raw = obj['@_CurCode'] ?? obj['@_Code'] ?? currencyHint ?? 'USD';
    currency = typeof raw === 'string' ? raw : 'USD';
  } else {
    value = Number(amountNode);
    currency = currencyHint ?? 'USD';
  }

  if (!Number.isFinite(value)) return null;
  return { amountMinor: Math.round(value * 100), currency: currency.toUpperCase() };
}

function mapOneOffer(args: {
  node: OfferNode;
  journeyMap: Map<string, Segment[]>;
  priceClassMap: Map<string, PriceClassInfo>;
  baggageMap: Map<string, BaggageInfo>;
  criteria: FlightSearchCriteria;
  tenantId: string;
  fetchedAt: string;
}): Offer | null {
  const offerRef = args.node.OfferID;
  if (!offerRef) return null;

  const tp = args.node.TotalPrice;
  if (!tp) return null;

  const total =
    extractMoney(tp.TotalAmount) ??
    extractMoney(tp.SimpleCurrencyPrice) ??
    extractMoney(tp.BaseAmount);
  if (!total) return null;

  const baseFare = extractMoney(tp.BaseAmount) ?? total;
  const taxes = extractMoney(tp.TaxSummary?.TotalTaxAmount, total.currency) ?? {
    amountMinor: total.amountMinor - baseFare.amountMinor,
    currency: total.currency,
  };

  const offerItems = arr<Record<string, unknown>>(args.node.OfferItem);
  const itineraries = buildItinerariesFromOfferItems(offerItems, args.journeyMap);
  if (itineraries.length === 0) return null;

  const expiresAt =
    args.node.TimeLimits?.OfferExpiration?.['@_DateTime'] ??
    new Date(Date.now() + 30 * 60_000).toISOString();

  const fareFamily = extractFareFamily(offerItems, args.priceClassMap);
  const baggage = extractOfferBaggage(args.node, args.baggageMap);
  const policies = extractPolicies(offerItems);

  return {
    id: randomUUID(),
    tenantId: args.tenantId,
    products: ['flight'],
    provider: { name: 'latam-ndc', offerRef },
    total,
    baseFare,
    taxes,
    itineraries,
    fareFamily,
    baggage,
    policies,
    fetchedAt: args.fetchedAt,
    expiresAt,
  };
}

// ---- Itinerary building ----

function buildItinerariesFromOfferItems(
  offerItems: Record<string, unknown>[],
  journeyMap: Map<string, Segment[]>,
): Itinerary[] {
  const itineraries: Itinerary[] = [];
  const seen = new Set<string>();

  for (const item of offerItems) {
    const services = arr<Record<string, unknown>>(item.Service);
    for (const svc of services) {
      // LATAM v192: Service.ServiceAssociations.PaxJourneyRefID
      const assoc = svc.ServiceAssociations as Record<string, unknown> | undefined;
      const journeyRefs: string[] = [];

      if (assoc) {
        const refs = assoc.PaxJourneyRefID;
        if (typeof refs === 'string') journeyRefs.push(refs);
        else if (Array.isArray(refs)) journeyRefs.push(...refs.map(String));
      }

      // Fallback: older NDC FlightRefs pattern
      if (journeyRefs.length === 0 && typeof svc.FlightRefs === 'string') {
        journeyRefs.push(...svc.FlightRefs.split(/\s+/).filter(Boolean));
      }

      for (const jRef of journeyRefs) {
        if (seen.has(jRef)) continue;
        seen.add(jRef);
        const segments = journeyMap.get(jRef);
        if (!segments || segments.length === 0) continue;
        const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0);
        itineraries.push({
          segments,
          totalDurationMinutes: totalDur,
          stops: Math.max(0, segments.length - 1),
        });
      }
    }
  }

  return itineraries;
}

// ---- Journey & Segment maps ----

function buildJourneyMap(
  response: unknown,
  segmentMap: Map<string, Segment>,
  warnings: string[],
): Map<string, Segment[]> {
  const map = new Map<string, Segment[]>();
  const journeys = collect(response, ['DataLists', 'PaxJourneyList'], 'PaxJourney');

  if (journeys.length > 0) {
    for (const j of journeys) {
      const node = j as Record<string, unknown>;
      const journeyId = node.PaxJourneyID as string | undefined;
      if (!journeyId) continue;
      const segRefs = arr<string>(node.PaxSegmentRefID);
      const segments = segRefs
        .map((ref) => segmentMap.get(ref))
        .filter((s): s is Segment => Boolean(s));
      if (segments.length > 0) map.set(journeyId, segments);
    }
  }

  // Fallback: older NDC FlightList pattern
  if (map.size === 0) {
    const flights = collect(response, ['DataLists', 'FlightList'], 'Flight');
    for (const f of flights) {
      const key = (f as Record<string, unknown>)['@_FlightKey'] as string | undefined;
      if (!key) {
        warnings.push('flight without FlightKey skipped');
        continue;
      }
      const segRefs = (f as Record<string, unknown>).SegmentReferences;
      if (typeof segRefs === 'string') {
        const segments = segRefs
          .split(/\s+/)
          .map((ref) => segmentMap.get(ref))
          .filter((s): s is Segment => Boolean(s));
        if (segments.length > 0) map.set(key, segments);
      }
    }
  }

  return map;
}

function buildSegmentMap(response: unknown, warnings: string[]): Map<string, Segment> {
  const map = new Map<string, Segment>();

  // LATAM v192: PaxSegmentList → PaxSegment
  const paxSegs = collect(response, ['DataLists', 'PaxSegmentList'], 'PaxSegment');
  for (const s of paxSegs) {
    const seg = mapPaxSegment(s);
    if (!seg.ok) {
      warnings.push(`segment skipped: ${seg.reason}`);
      continue;
    }
    map.set(seg.key, seg.segment);
  }

  // Fallback: older NDC FlightSegmentList → FlightSegment
  if (map.size === 0) {
    const flightSegs = collect(response, ['DataLists', 'FlightSegmentList'], 'FlightSegment');
    for (const s of flightSegs) {
      const seg = mapFlightSegment(s);
      if (!seg.ok) {
        warnings.push(`segment skipped: ${seg.reason}`);
        continue;
      }
      map.set(seg.key, seg.segment);
    }
  }

  return map;
}

type SegResult = { ok: true; key: string; segment: Segment } | { ok: false; reason: string };

function mapPaxSegment(s: unknown): SegResult {
  const node = s as Record<string, unknown>;
  const key = node.PaxSegmentID as string | undefined;
  if (!key) return { ok: false, reason: 'no PaxSegmentID' };

  const dep = node.Dep as
    | { IATA_LocationCode?: string; AircraftScheduledDateTime?: string | Record<string, unknown> }
    | undefined;
  const arrNode = node.Arrival as
    | { IATA_LocationCode?: string; AircraftScheduledDateTime?: string | Record<string, unknown> }
    | undefined;
  const carrier = node.MarketingCarrierInfo as
    | { CarrierDesigCode?: string; MarketingCarrierFlightNumberText?: string | number }
    | undefined;
  const cabinNode = node.CabinType as
    | { CabinTypeName?: string; CabinTypeCode?: string }
    | undefined;
  const durationStr = node.Duration as string | undefined;

  if (!dep?.IATA_LocationCode || !arrNode?.IATA_LocationCode)
    return { ok: false, reason: 'no Dep/Arrival code' };

  const depTime = extractDateTime(dep.AircraftScheduledDateTime);
  const arrTime = extractDateTime(arrNode.AircraftScheduledDateTime);
  if (!depTime || !arrTime) return { ok: false, reason: 'no times' };

  if (!carrier?.CarrierDesigCode || !carrier?.MarketingCarrierFlightNumberText) {
    return { ok: false, reason: 'no carrier info' };
  }

  const departureAt = ensureIso(depTime);
  const arrivalAt = ensureIso(arrTime);
  const durationMinutes =
    parseDuration(durationStr) ?? computeDurationMinutes(departureAt, arrivalAt);

  return {
    ok: true,
    key,
    segment: {
      carrier: carrier.CarrierDesigCode,
      flightNumber: String(carrier.MarketingCarrierFlightNumberText),
      origin: dep.IATA_LocationCode,
      destination: arrNode.IATA_LocationCode,
      departureAt,
      arrivalAt,
      durationMinutes,
      cabin: mapCabin(cabinNode?.CabinTypeName ?? cabinNode?.CabinTypeCode),
      bookingClass: 'Y',
    },
  };
}

function mapFlightSegment(s: unknown): SegResult {
  const node = s as Record<string, unknown>;
  const key =
    (node['@_SegmentKey'] as string | undefined) ?? (node.PaxSegmentID as string | undefined);
  if (!key) return { ok: false, reason: 'no SegmentKey' };

  const dep = node.Dep as
    | { IATA_LocationCode?: string; AircraftScheduledDateTime?: string }
    | undefined;
  const arrNode = node.Arrival as
    | { IATA_LocationCode?: string; AircraftScheduledDateTime?: string }
    | undefined;
  const carrier = node.MarketingCarrierInfo as
    | { CarrierDesigCode?: string; MarketingCarrierFlightNumberText?: string | number }
    | undefined;
  const cabinNode = node.CabinType as { CabinTypeName?: string } | undefined;
  const bookingClassNode = node.ClassOfService as { Code?: string } | undefined;

  if (!dep?.IATA_LocationCode || !arrNode?.IATA_LocationCode)
    return { ok: false, reason: 'no Dep/Arrival code' };
  if (!dep.AircraftScheduledDateTime || !arrNode.AircraftScheduledDateTime)
    return { ok: false, reason: 'no times' };
  if (!carrier?.CarrierDesigCode || !carrier?.MarketingCarrierFlightNumberText) {
    return { ok: false, reason: 'no carrier info' };
  }

  const departureAt = ensureIso(dep.AircraftScheduledDateTime);
  const arrivalAt = ensureIso(arrNode.AircraftScheduledDateTime);
  const durationMinutes = computeDurationMinutes(departureAt, arrivalAt);

  return {
    ok: true,
    key,
    segment: {
      carrier: carrier.CarrierDesigCode,
      flightNumber: String(carrier.MarketingCarrierFlightNumberText),
      origin: dep.IATA_LocationCode,
      destination: arrNode.IATA_LocationCode,
      departureAt,
      arrivalAt,
      durationMinutes,
      cabin: mapCabin(cabinNode?.CabinTypeName),
      bookingClass: (bookingClassNode?.Code ?? 'Y').slice(0, 1).toUpperCase(),
    },
  };
}

// ---- Fare family, baggage, policies extraction ----

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
  const classes = collect(response, ['DataLists', 'PriceClassList'], 'PriceClass');
  for (const pc of classes) {
    const node = pc as Record<string, unknown>;
    const id = node.PriceClassID as string | undefined;
    const name = node.Name as string | undefined;
    if (!id || !name) continue;
    const cabinNode = node.CabinType as
      | { CabinTypeName?: string; CabinTypeCode?: string }
      | undefined;
    map.set(id, {
      name,
      cabin: mapCabin(cabinNode?.CabinTypeName ?? cabinNode?.CabinTypeCode),
    });
  }
  return map;
}

function buildBaggageAllowanceMap(response: unknown): Map<string, BaggageInfo> {
  const map = new Map<string, BaggageInfo>();
  const items = collect(response, ['DataLists', 'BaggageAllowanceList'], 'BaggageAllowance');
  for (const ba of items) {
    const node = ba as Record<string, unknown>;
    const id = node.BaggageAllowanceID as string | undefined;
    if (!id) continue;

    const typeCode = node.TypeCode as string | undefined;
    const pieceNode = node.PieceAllowance as { TotalQty?: number | string } | undefined;
    const qty = Number(pieceNode?.TotalQty ?? 0);

    let type: BaggageInfo['type'] = 'CarryOn';
    if (typeCode === 'Checked') type = 'Checked';
    else if (id.includes('PERSONAL_ITEM')) type = 'PersonalItem';

    let weightKg: number | undefined;
    const weightNodes = arr<Record<string, unknown>>(node.WeightAllowance);
    for (const w of weightNodes) {
      const measure = w.MaximumWeightMeasure as Record<string, unknown> | undefined;
      if (measure && measure['@_UnitCode'] === 'KG') {
        weightKg = Number(measure['#text'] ?? measure[''] ?? 0);
        break;
      }
    }

    map.set(id, { type, qty, weightKg });
  }
  return map;
}

function extractFareFamily(
  offerItems: Record<string, unknown>[],
  priceClassMap: Map<string, PriceClassInfo>,
): Offer['fareFamily'] {
  for (const item of offerItems) {
    const fareDetails = arr<Record<string, unknown>>(item.FareDetail);
    for (const fd of fareDetails) {
      const fareRefText = fd.FareRefText as string | undefined;
      const fareComponents = arr<Record<string, unknown>>(fd.FareComponent);
      for (const fc of fareComponents) {
        const priceClassRefID = fc.PriceClassRefID as string | undefined;
        if (priceClassRefID) {
          const pc = priceClassMap.get(priceClassRefID);
          if (pc) return { name: fareRefText ?? pc.name, cabin: pc.cabin };
        }
      }
      if (fareRefText) {
        return { name: fareRefText, cabin: 'economy' };
      }
    }
  }
  return undefined;
}

function extractOfferBaggage(
  node: OfferNode,
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
    const refId = ref.BaggageAllowanceRefID as string | undefined;
    if (!refId) continue;
    const info = baggageMap.get(refId);
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
    carryOn: { qty: carryOnQty, weightKg: carryOnWeight },
    checked: { qty: checkedQty, weightKg: checkedWeight },
  };
}

function extractPolicies(offerItems: Record<string, unknown>[]): Offer['policies'] {
  let changeable = false;
  let refundable = false;

  for (const item of offerItems) {
    const changeNode = item.ChangeRestrictions as Record<string, unknown> | undefined;
    if (
      changeNode?.AllowedModificationInd === true ||
      changeNode?.AllowedModificationInd === 'true'
    ) {
      changeable = true;
    }
    const cancelNode = item.CancelRestrictions as Record<string, unknown> | undefined;
    if (
      cancelNode?.AllowedModificationInd === true ||
      cancelNode?.AllowedModificationInd === 'true'
    ) {
      refundable = true;
    }
  }

  return { changeable, refundable };
}

// ---- helpers ----

function extractDateTime(dt: unknown): string | null {
  if (typeof dt === 'string') return dt;
  if (dt && typeof dt === 'object') {
    const obj = dt as Record<string, unknown>;
    // fast-xml-parser with attributes: {#text: "2026-06-15T05:10:00", @_TimeZoneCode: "-05:00"}
    const text = obj['#text'] as string | undefined;
    return text ?? null;
  }
  return null;
}

function parseDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
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

function ensureIso(dt: string): string {
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(dt)) return dt;
  return `${dt}Z`;
}

// ---- generic helpers ----

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}

function collect(obj: unknown, path: string[], leaf: string): unknown[] {
  let cur: unknown = obj;
  for (const p of path) {
    cur = pick(cur, p);
    if (!cur) return [];
  }
  const node = pick(cur, leaf);
  return arr(node);
}

function arr<T>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}
