import type {
  ActivityAdditional,
  ActivityDetail,
  ActivityModality,
  ActivityOffer,
  ActivityParticipants,
  ActivitySummary,
  AgeRange,
  Money,
} from '@sales-travel/canonical';
import type { ActivitySuggestion, ShoppingPark } from '../types';
import {
  amount,
  category,
  hourLabel,
  isoDate,
  mapCancellation,
  mapParticipants,
  mapPrices,
  mapTicketValidity,
  money,
  str,
  strings,
} from './common';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function httpsImages(v: unknown): string[] {
  return arr(v).flatMap((i) => {
    const url = str(i['url']);
    if (!url) return [];
    if (url.startsWith('https://')) return [url];
    if (url.startsWith('//')) return [`https:${url}`];
    if (url.startsWith('http://')) return [`https://${url.slice('http://'.length)}`];
    return [];
  });
}

// ───────────────────────── Discovery ─────────────────────────

/**
 * `/discovery` devuelve un array de grupos `{ items[] }` (la guía lo llama `available_tickets`; manda
 * la referencia). Se acepta también un objeto con `items` o con `available_tickets`, por si la
 * respuesta real difiere del esquema (sin verificar).
 */
export function mapDiscovery(raw: unknown): ActivitySummary[] {
  const groups = Array.isArray(raw) ? raw.map(obj) : [obj(raw)];
  const out: ActivitySummary[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const items = arr(g['items'] ?? g['available_tickets']);
    // Un array plano de ítems también vale.
    const list = items.length > 0 ? items : g['tracking_id'] !== undefined ? [g] : [];
    for (const it of list) {
      const id = str(it['tracking_id']) ?? str(it['id']);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, category: category(it['type']), name: str(it['name']) ?? id });
    }
  }
  return out;
}

// ───────────────────────── Modalities ─────────────────────────

function ageRange(v: unknown): AgeRange | undefined {
  const o = obj(v);
  if (o['min_age'] === undefined && o['max_age'] === undefined) return undefined;
  return { minAge: Math.trunc(amount(o['min_age'])), maxAge: Math.trunc(amount(o['max_age'])) };
}

function unitPrices(v: unknown): Money[] {
  return arr(v).flatMap((p) => {
    const cur = str(p['currency']);
    return cur && /^[A-Za-z]{3}$/.test(cur) ? [money(p['unit_price'], cur)] : [];
  });
}

function mapAdditional(a: Obj): ActivityAdditional | undefined {
  const id = str(a['id']);
  if (!id) return undefined;
  const description = str(a['description']);
  return {
    id,
    title: str(a['title']) ?? id,
    prices: unitPrices(a['price']),
    ...(description ? { description } : {}),
  };
}

function mapModality(m: Obj): ActivityModality | undefined {
  const id = str(m['id']);
  if (!id) return undefined;
  const ranges = {
    adult: ageRange(m['adult_age_range']),
    child: ageRange(m['child_age_range']),
    infant: ageRange(m['infant_age_range']),
  };
  const maxCapacity = Math.trunc(amount(m['max_capacity']));
  const type = str(m['modality_type']);
  return {
    id,
    name: str(m['name']) ?? id,
    availableDates: arr(m['available_dates']).flatMap((d) => {
      const date = isoDate(d['date']);
      if (!date) return [];
      const hours = arr(d['hours'])
        .map((h) => hourLabel(h['hour']))
        .filter((h): h is string => h !== undefined);
      return [{ date, hours: [...new Set(hours)].sort() }];
    }),
    referencePrices: unitPrices(m['prices']),
    ageRanges: Object.fromEntries(
      Object.entries(ranges).filter(([, r]) => r !== undefined),
    ),
    additionals: arr(m['additionals'])
      .map(mapAdditional)
      .filter((a): a is ActivityAdditional => a !== undefined),
    ...(maxCapacity > 0 ? { maxCapacity } : {}),
    ...(type ? { type } : {}),
  };
}

function duration(v: unknown): ActivityDetail['duration'] {
  const d = obj(v);
  const unit = str(d['type']);
  const value = amount(d['value']);
  return unit && value > 0 ? { unit: unit.toLowerCase(), value } : undefined;
}

export function mapModalities(raw: unknown, requestedId: string): ActivityDetail {
  const r = obj(raw);
  const description = str(r['description']);
  const dur = duration(r['duration']);
  return {
    id: str(r['tracking_id']) ?? str(r['id']) ?? requestedId,
    category: category(r['type']),
    name: str(r['name']) ?? requestedId,
    images: httpsImages(r['images']),
    inclusions: strings(r['inclusions']),
    exclusions: strings(r['exclusions']),
    modalities: arr(r['modalities'])
      .map(mapModality)
      .filter((m): m is ActivityModality => m !== undefined),
    ...(description ? { description } : {}),
    ...(dur ? { duration: dur } : {}),
  };
}

// ───────────────────────── Availability ─────────────────────────

interface OfferContext {
  activityId: string;
  modalityId?: string;
  date: string;
  requested: ActivityParticipants;
  name?: string;
  categoryHint?: unknown;
}

/**
 * Una tarifa reservable a partir de un objeto con `choice_id` (availability o
 * `shopping.modalities[].availabilities[]`). `undefined` si no trae `choice_id` o precios: sin eso
 * no se puede ni vender ni reservar.
 */
function mapOffer(o: Obj, ctx: OfferContext): ActivityOffer | undefined {
  const choiceId = str(o['choice_id']);
  const prices = mapPrices(o['price_details']);
  if (!choiceId || prices.length === 0) return undefined;
  const { participants, ageLimits } = mapParticipants(o['distribution'], ctx.requested);
  const startAt = str(o['from']);
  const endAt = str(o['to']);
  const modalityName = str(o['modality_choice_name']);
  const destination = str(o['destination']);
  const validity = mapTicketValidity(o['ticket_validity']);
  return {
    choiceId,
    activityId: ctx.activityId,
    category: category(o['type'] ?? ctx.categoryHint),
    name: str(o['name']) ?? ctx.name ?? ctx.activityId,
    date: isoDate(o['date']) ?? isoDate(startAt) ?? ctx.date,
    participants,
    ageLimits,
    prices,
    cancellation: mapCancellation(o['cancellation_policy']),
    highlights: strings(o['highlights']),
    additionals: arr(o['additions_chosen'] ?? o['additionals']).flatMap((a) => {
      const title = str(a['title']);
      const description = str(a['description']);
      return title ? [{ title, ...(description ? { description } : {}) }] : [];
    }),
    ...(ctx.modalityId ? { modalityId: ctx.modalityId } : {}),
    ...(modalityName ? { modalityName } : {}),
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
    ...(destination ? { destination } : {}),
    ...(validity ? { ticketValidity: validity } : {}),
  };
}

export function mapAvailability(
  raw: unknown,
  ctx: { activityId: string; modalityId: string; date: string; requested: ActivityParticipants },
): ActivityOffer | undefined {
  return mapOffer(obj(raw), ctx);
}

// ───────────────────────── Shopping (Orlando) ─────────────────────────

export function mapShopping(raw: unknown, requested: ActivityParticipants): ShoppingPark[] {
  const parks = Array.isArray(raw) ? raw.map(obj) : [obj(raw)];
  return parks.flatMap((p) => {
    const id = str(p['tracking_id']);
    if (!id) return [];
    const parkName = str(p['name']) ?? id;
    const offers = arr(p['modalities']).flatMap((m) => {
      const modalityId = str(m['id']);
      const modalityName = str(m['name']);
      return arr(m['availabilities']).flatMap((a) => {
        const date = isoDate(a['date']);
        if (!date) return [];
        const offer = mapOffer(a, {
          activityId: id,
          date,
          requested,
          name: parkName,
          categoryHint: 'TICKET',
          ...(modalityId ? { modalityId } : {}),
        });
        if (!offer) return [];
        return [modalityName && !offer.modalityName ? { ...offer, modalityName } : offer];
      });
    });
    const description = str(p['description']);
    const logo = str(p['logo']);
    return [
      {
        id,
        name: parkName,
        images: httpsImages(p['images']),
        offers,
        ...(description ? { description } : {}),
        ...(logo ? { logo } : {}),
      },
    ];
  });
}

// ───────────────────────── Sugerencias ─────────────────────────

export function mapActivitySuggestions(raw: unknown): ActivitySuggestion[] {
  return arr(obj(raw)['items']).flatMap((it) => {
    const id = str(it['id']);
    if (!id) return [];
    const target = obj(it['target']);
    const cityGid = str(obj(target['parents'])['city']);
    return [
      {
        id,
        label: str(it['display']) ?? id,
        type: str(target['type']) ?? 'POI',
        ...(cityGid ? { cityGid } : {}),
      },
    ];
  });
}
