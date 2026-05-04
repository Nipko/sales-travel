import type {
  CabinClass,
  IataAirportCode,
  IataCarrierCode,
  Itinerary,
  Money,
  Offer,
  Segment,
} from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain/ports';
import { randomUUID } from 'node:crypto';

/**
 * Mapea la respuesta IATA_AirShoppingRS de LATAM al modelo canónico.
 *
 * Estructura típica:
 *   IATA_AirShoppingRS
 *     Response
 *       OffersGroup
 *         AirlineOffers[]
 *           Offer[] -> { OfferID, TotalPrice, OfferItem[], TimeLimits, ... }
 *       DataLists
 *         FlightList: Flight[] -> { FlightKey, Dep, Arr, MarketingCarrier, ... }
 *         FlightSegmentList: FlightSegment[]
 *
 * NDC tiene MUCHA flexibilidad y cada aerolínea adapta detalles. Esta
 * implementación cubre el caso "feliz" del sandbox y deja `ParseErrors[]`
 * para casos no contemplados, que iremos endureciendo con tests.
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

  const response = pick(root, 'Response');
  if (!response) {
    return { offers: [], warnings: ['No Response element in AirShoppingRS.'] };
  }

  const segmentMap = buildSegmentMap(response, warnings);
  const flightMap = buildFlightMap(response, segmentMap, warnings);

  const offerNodes = collect(response, ['OffersGroup', 'AirlineOffers'], 'Offer');
  if (offerNodes.length === 0) {
    return { offers: [], warnings: [...warnings, 'No offers in response.'] };
  }

  const offers: Offer[] = [];
  const fetchedAt = new Date().toISOString();

  for (const node of offerNodes) {
    try {
      const offer = mapOneOffer({
        node,
        flightMap,
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

interface OfferNode {
  OfferID?: string;
  TotalPrice?: { SimpleCurrencyPrice?: { '#text'?: string | number; '@_Code'?: string } };
  OfferItem?: unknown;
  TimeLimits?: { OfferExpiration?: { '@_DateTime'?: string } };
}

function mapOneOffer(args: {
  node: OfferNode;
  flightMap: Map<string, Segment>;
  criteria: FlightSearchCriteria;
  tenantId: string;
  fetchedAt: string;
}): Offer | null {
  const offerRef = args.node.OfferID;
  if (!offerRef) return null;

  const totalPriceText = args.node.TotalPrice?.SimpleCurrencyPrice?.['#text'];
  const totalCurrency = args.node.TotalPrice?.SimpleCurrencyPrice?.['@_Code'];
  if (totalPriceText === undefined || !totalCurrency) return null;

  const totalMajor = Number(totalPriceText);
  if (!Number.isFinite(totalMajor)) return null;

  const total: Money = {
    amountMinor: Math.round(totalMajor * 100),
    currency: String(totalCurrency).toUpperCase(),
  };

  const offerItems = arr<{ Service?: unknown }>(args.node.OfferItem);
  const flightKeys = collectFlightRefs(offerItems);
  const itineraries = buildItineraries(flightKeys, args.flightMap);
  if (itineraries.length === 0) return null;

  const expiresAt =
    args.node.TimeLimits?.OfferExpiration?.['@_DateTime'] ??
    new Date(Date.now() + 30 * 60_000).toISOString();

  return {
    id: randomUUID(),
    tenantId: args.tenantId,
    products: ['flight'],
    provider: { name: 'latam-ndc', offerRef },
    total,
    baseFare: total,
    taxes: { amountMinor: 0, currency: total.currency },
    itineraries,
    fetchedAt: args.fetchedAt,
    expiresAt,
  };
}

function buildItineraries(flightKeys: string[][], flightMap: Map<string, Segment>): Itinerary[] {
  return flightKeys
    .map((keys) => {
      const segments = keys.map((k) => flightMap.get(k)).filter((s): s is Segment => Boolean(s));
      if (segments.length === 0) return null;
      const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0);
      return {
        segments,
        totalDurationMinutes: totalDur,
        stops: Math.max(0, segments.length - 1),
      };
    })
    .filter((i): i is Itinerary => i !== null);
}

function collectFlightRefs(offerItems: { Service?: unknown }[]): string[][] {
  // Cada OfferItem.Service.FlightRefs contiene un grupo de FlightKey separados
  // por espacios. Cada grupo = un itinerario (outbound / inbound).
  const groups: string[][] = [];
  for (const item of offerItems) {
    const services = arr<{ FlightRefs?: string }>(item.Service);
    for (const s of services) {
      if (typeof s.FlightRefs !== 'string') continue;
      const keys = s.FlightRefs.split(/\s+/).filter(Boolean);
      if (keys.length > 0) groups.push(keys);
    }
  }
  return groups;
}

function buildFlightMap(
  response: unknown,
  segmentMap: Map<string, Segment>,
  warnings: string[],
): Map<string, Segment> {
  const map = new Map<string, Segment>();
  const flights = collect(response, ['DataLists', 'FlightList'], 'Flight');
  for (const f of flights) {
    const key = (f as { '@_FlightKey'?: string })['@_FlightKey'];
    if (!key) {
      warnings.push('flight without FlightKey skipped');
      continue;
    }
    // Un Flight referencia 1+ FlightSegmentRefs; el primer segmento basta para
    // un vuelo directo. Para conexiones, tomamos el segmento "more relevant".
    const segRefs = (f as { SegmentReferences?: string }).SegmentReferences;
    if (typeof segRefs === 'string') {
      const firstSegKey = segRefs.split(/\s+/)[0];
      if (firstSegKey) {
        const seg = segmentMap.get(firstSegKey);
        if (seg) map.set(key, seg);
      }
    }
  }
  return map;
}

function buildSegmentMap(response: unknown, warnings: string[]): Map<string, Segment> {
  const map = new Map<string, Segment>();
  const segs = collect(response, ['DataLists', 'FlightSegmentList'], 'FlightSegment');
  for (const s of segs) {
    const seg = mapSegment(s);
    if (!seg.ok) {
      warnings.push(`segment skipped: ${seg.reason}`);
      continue;
    }
    map.set(seg.key, seg.segment);
  }
  return map;
}

function mapSegment(
  s: unknown,
): { ok: true; key: string; segment: Segment } | { ok: false; reason: string } {
  const node = s as Record<string, unknown>;
  const key = node['@_SegmentKey'] as string | undefined;
  if (!key) return { ok: false, reason: 'no SegmentKey' };

  const dep = node.Dep as
    | { IATA_LocationCode?: string; AircraftScheduledDateTime?: string }
    | undefined;
  const arr2 = node.Arrival as
    | { IATA_LocationCode?: string; AircraftScheduledDateTime?: string }
    | undefined;
  const carrier = node.MarketingCarrierInfo as
    | { CarrierDesigCode?: string; MarketingCarrierFlightNumberText?: string }
    | undefined;
  const cabinNode = node.CabinType as { CabinTypeName?: string } | undefined;
  const bookingClassNode = node.ClassOfService as { Code?: string } | undefined;

  if (!dep?.IATA_LocationCode || !arr2?.IATA_LocationCode)
    return { ok: false, reason: 'no Dep/Arrival code' };
  if (!dep.AircraftScheduledDateTime || !arr2.AircraftScheduledDateTime)
    return { ok: false, reason: 'no times' };
  if (!carrier?.CarrierDesigCode || !carrier?.MarketingCarrierFlightNumberText) {
    return { ok: false, reason: 'no carrier info' };
  }

  const departureAt = ensureIso(dep.AircraftScheduledDateTime);
  const arrivalAt = ensureIso(arr2.AircraftScheduledDateTime);
  const durationMinutes = Math.max(
    1,
    Math.round((Date.parse(arrivalAt) - Date.parse(departureAt)) / 60_000),
  );

  return {
    ok: true,
    key,
    segment: {
      carrier: carrier.CarrierDesigCode as IataCarrierCode,
      flightNumber: String(carrier.MarketingCarrierFlightNumberText),
      origin: dep.IATA_LocationCode as IataAirportCode,
      destination: arr2.IATA_LocationCode as IataAirportCode,
      departureAt,
      arrivalAt,
      durationMinutes,
      cabin: mapCabin(cabinNode?.CabinTypeName),
      bookingClass: (bookingClassNode?.Code ?? 'Y').slice(0, 1).toUpperCase(),
    },
  };
}

function mapCabin(name: string | undefined): CabinClass {
  const n = (name ?? '').toLowerCase();
  if (n.includes('first')) return 'first';
  if (n.includes('business')) return 'business';
  if (n.includes('premium')) return 'premium_economy';
  return 'economy';
}

function ensureIso(dt: string): string {
  // LATAM a veces devuelve "2026-08-15T08:00:00" sin offset. Asumimos UTC en ese caso.
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(dt)) return dt;
  return `${dt}Z`;
}

// ---- helpers genéricos ----

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
