import type { Offer } from '../../cotizaciones/actions';
import type { HotelOffer, HotelRoompack, RoomDistribution } from '../../hoteles/actions';
import type { CarOffer, CarSearchValues } from '../../autos/actions';

/**
 * El modelo de la sección «Paquetes», sin I/O: qué se recomienda, cuánto cuesta, qué se guarda y
 * cómo se cuenta el viaje día a día. La pantalla y la cotización leen de acá.
 */

export type LaneKind = 'flights' | 'hotels' | 'cars';
export type ManualVertical = 'activities' | 'transfers' | 'other';

export interface Price {
  amountMinor: number;
  currency: string;
}

// ─────────────────────────── Precios de venta ───────────────────────────

/** Venta del vuelo: la cascada si la hay; si no, el neto (venta = neto sin reglas). */
export function flightSale(o: Pick<Offer, 'pricing' | 'total'>): Price {
  return {
    amountMinor: o.pricing?.finalMinor ?? o.total.amountMinor,
    currency: (o.pricing?.currency ?? o.total.currency).toUpperCase(),
  };
}

export function roompackSale(p: Pick<HotelRoompack, 'pricing' | 'price'>): Price {
  return {
    amountMinor: p.pricing?.finalMinor ?? p.price.total.amountMinor,
    currency: p.price.total.currency.toUpperCase(),
  };
}

export function carSale(c: Pick<CarOffer, 'pricing' | 'rateAmount'>): Price {
  return {
    amountMinor: c.pricing?.finalMinor ?? c.rateAmount.amountMinor,
    currency: (c.pricing?.currency ?? c.rateAmount.currency).toUpperCase(),
  };
}

/** La tarifa más barata del hotel en la moneda pedida (las de otra moneda no se pueden sumar). */
export function cheapestRoompack(
  hotel: Pick<HotelOffer, 'roompacks'>,
  currency: string,
): HotelRoompack | undefined {
  let best: HotelRoompack | undefined;
  for (const pack of hotel.roompacks) {
    const sale = roompackSale(pack);
    if (sale.currency !== currency) continue;
    if (!best || sale.amountMinor < roompackSale(best).amountMinor) best = pack;
  }
  return best;
}

// ─────────────────────────── Moneda del paquete ───────────────────────────

/**
 * Un paquete se arma en UNA moneda: no hay tasas de cambio en la plataforma. Manda la de venta de
 * la agencia que informa el API de vuelos; sin vuelo, la que pidió la búsqueda de hoteles, y si no,
 * la del primer precio que haya.
 */
export function packageCurrency(input: {
  flightSaleCurrency?: string | undefined;
  hotelCriteriaCurrency?: string | undefined;
  flights: readonly Pick<Offer, 'pricing' | 'total'>[];
  hotels: readonly Pick<HotelOffer, 'roompacks'>[];
  cars: readonly Pick<CarOffer, 'pricing' | 'rateAmount'>[];
}): string | undefined {
  const explicit = input.flightSaleCurrency ?? input.hotelCriteriaCurrency;
  if (explicit) return explicit.toUpperCase();
  const first = input.flights[0];
  if (first) return flightSale(first).currency;
  const pack = input.hotels.find((h) => h.roompacks.length > 0)?.roompacks[0];
  if (pack) return roompackSale(pack).currency;
  const car = input.cars[0];
  return car ? carSale(car).currency : undefined;
}

// ─────────────────────────── Recomendación ───────────────────────────

/** Cuánto más caro que el más barato se acepta para ganar en escalas o en estrellas. */
const FLIGHT_COMFORT_MARGIN = 0.15;
const HOTEL_UPGRADE_MARGIN = 0.3;

/**
 * El vuelo recomendado: entre los que cuestan hasta un 15 % más que el más barato, el de menos
 * escalas y después el más corto. Un vendedor no recomienda un vuelo con dos escalas por ahorrar
 * un 3 %, y tampoco uno directo que cuesta el doble.
 */
export function recommendFlight(offers: readonly Offer[], currency: string): Offer | undefined {
  const priced = offers.filter((o) => flightSale(o).currency === currency);
  if (priced.length === 0) return undefined;
  const cheapest = Math.min(...priced.map((o) => flightSale(o).amountMinor));
  const ceiling = cheapest * (1 + FLIGHT_COMFORT_MARGIN);
  const candidates = priced.filter((o) => flightSale(o).amountMinor <= ceiling);
  return [...candidates].sort(
    (a, b) =>
      totalStops(a) - totalStops(b) ||
      totalDuration(a) - totalDuration(b) ||
      flightSale(a).amountMinor - flightSale(b).amountMinor,
  )[0];
}

export function totalStops(o: Pick<Offer, 'itineraries'>): number {
  return (o.itineraries ?? []).reduce((n, it) => n + it.stops, 0);
}

export function totalDuration(o: Pick<Offer, 'itineraries'>): number {
  return (o.itineraries ?? []).reduce((n, it) => n + it.totalDurationMinutes, 0);
}

export interface HotelChoice {
  hotel: HotelOffer;
  pack: HotelRoompack;
}

/**
 * El hotel recomendado: el 3★+ más barato, salvo que un 4★+ cueste hasta un 30 % más, que entonces
 * gana. Sin estrellas informadas, el más barato.
 */
export function recommendHotel(
  hotels: readonly HotelOffer[],
  currency: string,
): HotelChoice | undefined {
  const choices = hotelChoices(hotels, currency);
  if (choices.length === 0) return undefined;
  const byPrice = (a: HotelChoice, b: HotelChoice) =>
    roompackSale(a.pack).amountMinor - roompackSale(b.pack).amountMinor;
  const threePlus = choices.filter((c) => (c.hotel.stars ?? 0) >= 3).sort(byPrice);
  const base = threePlus[0] ?? [...choices].sort(byPrice)[0]!;
  const upgrade = choices
    .filter((c) => (c.hotel.stars ?? 0) >= 4)
    .sort(byPrice)
    .find(
      (c) =>
        roompackSale(c.pack).amountMinor <=
        roompackSale(base.pack).amountMinor * (1 + HOTEL_UPGRADE_MARGIN),
    );
  return upgrade ?? base;
}

/** Cada hotel con su tarifa más barata en la moneda del paquete; los que no tienen, fuera. */
export function hotelChoices(hotels: readonly HotelOffer[], currency: string): HotelChoice[] {
  const out: HotelChoice[] = [];
  for (const hotel of hotels) {
    const pack = cheapestRoompack(hotel, currency);
    if (pack) out.push({ hotel, pack });
  }
  return out;
}

export function recommendCar(cars: readonly CarOffer[], currency: string): CarOffer | undefined {
  return cars
    .filter((c) => carSale(c).currency === currency)
    .sort((a, b) => carSale(a).amountMinor - carSale(b).amountMinor)[0];
}

/** La clave de un auto: la rentadora no da un id de oferta único. */
export function carKey(
  c: Pick<CarOffer, 'companyCode' | 'sippCode' | 'ccrc' | 'rateType'>,
): string {
  return [c.companyCode, c.sippCode, c.ccrc ?? '', c.rateType ?? ''].join('|');
}

/** Cuánto cambia el total si se elige `option` en lugar de `selected`. */
export function priceDelta(option: Price, selected: Price | undefined): number | undefined {
  if (!selected || selected.currency !== option.currency) return undefined;
  return option.amountMinor - selected.amountMinor;
}

// ─────────────────────────── Pasajeros ───────────────────────────

export interface PaxSplit {
  adults: number;
  children: number;
  infants: number;
  childAges: number[];
}

/**
 * Las habitaciones del hotel a pasajeros de avión: 12+ viaja como adulto, 2–11 como niño (con su
 * edad, que Sabre usa para cotizar) y menores de 2 como infante en brazos.
 */
export function paxFromRooms(rooms: readonly RoomDistribution[]): PaxSplit {
  let adults = 0;
  const childAges: number[] = [];
  let infants = 0;
  for (const room of rooms) {
    adults += room.adults;
    for (const age of room.childrenAges) {
      if (age >= 12) adults += 1;
      else if (age >= 2) childAges.push(age);
      else infants += 1;
    }
  }
  return { adults, children: childAges.length, infants, childAges };
}

/** Los que pagan plaza: el precio «por persona» no divide entre infantes en brazos. */
export function payingTravelers(rooms: readonly RoomDistribution[]): number {
  const pax = paxFromRooms(rooms);
  return Math.max(1, pax.adults + pax.children);
}

export function perPerson(totalMinor: number, travelers: number): number {
  return Math.round(totalMinor / Math.max(1, travelers));
}

// ─────────────────────────── Auto derivado del vuelo ───────────────────────────

const DEFAULT_CAR_HOUR = '1000';

/** «2026-12-10T14:35:00-05:00» → fecha y hora LOCALES del aeropuerto, tal como las escribe el GDS. */
function localParts(iso: string): { date: string; minutes: number } | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return undefined;
  return { date: m[1]!, minutes: Number(m[2]) * 60 + Number(m[3]) };
}

function hhmm(minutes: number): string {
  const clamped = Math.min(Math.max(minutes, 0), 23 * 60 + 30);
  const rounded = Math.round(clamped / 30) * 30;
  const h = Math.floor(Math.min(rounded, 23 * 60 + 30) / 60);
  const min = Math.min(rounded, 23 * 60 + 30) % 60;
  return `${String(h).padStart(2, '0')}${String(min).padStart(2, '0')}`;
}

/**
 * La búsqueda de auto que encaja con el vuelo: se recoge en el aeropuerto de llegada una hora
 * después de aterrizar y se devuelve tres horas antes del vuelo de regreso. Sin vuelo elegido, las
 * fechas del viaje a las 10:00.
 */
export function carSearchFor(input: {
  airportCode: string;
  countryCode: string;
  departureDate: string;
  returnDate: string;
  flight?: Pick<Offer, 'itineraries'> | undefined;
}): CarSearchValues {
  const outbound = input.flight?.itineraries?.[0];
  const inbound = input.flight?.itineraries?.[1];
  const landed = outbound ? localParts(outbound.segments.at(-1)?.arrivalAt ?? '') : undefined;
  const leaves = inbound ? localParts(inbound.segments[0]?.departureAt ?? '') : undefined;

  const pickUpDate = landed?.date ?? input.departureDate;
  const pickUpHour = landed ? hhmm(landed.minutes + 60) : DEFAULT_CAR_HOUR;
  let dropOffDate = leaves?.date ?? input.returnDate;
  let dropOffHour = leaves ? hhmm(leaves.minutes - 180) : DEFAULT_CAR_HOUR;
  if (`${dropOffDate}${dropOffHour}` <= `${pickUpDate}${pickUpHour}`) {
    dropOffDate = input.returnDate;
    dropOffHour = pickUpHour;
  }
  return {
    pickUpLocation: input.airportCode,
    dropOffLocation: input.airportCode,
    country: input.countryCode.toUpperCase(),
    pickUpDate,
    dropOffDate,
    pickUpHour,
    dropOffHour,
    rateType: 'best',
  };
}

// ─────────────────────────── Snapshot que se guarda ───────────────────────────

export interface FlightSegmentSnapshot {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
}

export interface FlightSnapshot {
  kind: 'flight';
  carriers: string[];
  fareFamily?: string;
  cabin?: string;
  baggage?: Offer['baggage'];
  refundable?: boolean;
  changeable?: boolean;
  itineraries: { segments: FlightSegmentSnapshot[]; totalDurationMinutes: number; stops: number }[];
  test?: boolean;
}

export interface HotelSnapshot {
  kind: 'hotel';
  name: string;
  stars?: number;
  address?: string;
  location?: { lat: number; lng: number };
  /** Rutas del proxy propio (`/api/hotels/images/…`): nunca la URL del proveedor. */
  images: string[];
  description?: string;
  roomName?: string;
  board: string;
  boardLabel?: string;
  refundable: boolean;
  freeCancellationUntilLocal?: string;
  checkin: string;
  checkout: string;
  rooms: number;
  hotelKey?: string;
  test?: boolean;
}

export interface CarSnapshot {
  kind: 'car';
  model: string;
  category: string;
  companyName: string;
  imageUrl?: string;
  companyImageUrl?: string;
  doors: number;
  passengers: number;
  bags: number;
  automatic: boolean;
  air: boolean;
  kmIncluded: string;
  pickUp: { code: string; date: string; hour: string };
  dropOff: { code: string; date: string; hour: string };
}

export interface ManualSnapshot {
  kind: 'manual';
  title: string;
  description?: string;
  imageUrl?: string;
  date?: string;
}

/**
 * Una actividad de un proveedor (Despegar/HotelDO: `providerName = 'despegar-activities'`). Sus
 * participantes son PROPIOS: no heredan la ocupación del hotel (un tour puede ser para parte del
 * grupo). Lo arma `toActivitySnapshot` (`actividades/_components/activity-model.ts`).
 */
export interface ActivitySnapshot {
  kind: 'activity';
  title: string;
  category: 'ticket' | 'tour';
  modality?: string;
  /** YYYY-MM-DD. */
  date: string;
  /** ISO 8601 con offset, si el proveedor lo informó. */
  startAt?: string;
  endAt?: string;
  participants: { adults: number; childrenAges: number[] };
  cancellation: {
    refundable: boolean;
    tiers: { from: string; to?: string; percentage: number; label?: string }[];
  };
  ticketValidity?: { useDate?: string; expirationDate?: string };
  images: string[];
  description?: string;
  test?: boolean;
}

export type ItemSnapshot =
  | FlightSnapshot
  | HotelSnapshot
  | CarSnapshot
  | ManualSnapshot
  | ActivitySnapshot;

export function flightSnapshot(o: Offer): FlightSnapshot {
  const itineraries = (o.itineraries ?? []).map((it) => ({
    segments: it.segments.map((s) => ({
      carrier: s.carrier,
      flightNumber: s.flightNumber,
      origin: s.origin,
      destination: s.destination,
      departureAt: s.departureAt,
      arrivalAt: s.arrivalAt,
    })),
    totalDurationMinutes: it.totalDurationMinutes,
    stops: it.stops,
  }));
  const carriers = [...new Set(itineraries.flatMap((it) => it.segments.map((s) => s.carrier)))];
  return {
    kind: 'flight',
    carriers,
    ...(o.fareFamily?.name ? { fareFamily: o.fareFamily.name } : {}),
    ...(o.fareFamily?.cabin ? { cabin: o.fareFamily.cabin } : {}),
    ...(o.baggage ? { baggage: o.baggage } : {}),
    ...(o.policies?.refundable !== undefined ? { refundable: o.policies.refundable } : {}),
    ...(o.policies?.changeable !== undefined ? { changeable: o.policies.changeable } : {}),
    itineraries,
    ...(o.provider.environment === 'test' ? { test: true } : {}),
  };
}

const DESCRIPTION_MAX = 600;

/** Texto plano de la descripción del hotel: la cotización nunca pinta HTML del proveedor. */
export function plainDescription(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.length <= DESCRIPTION_MAX) return text;
  const cut = text.slice(0, DESCRIPTION_MAX);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : DESCRIPTION_MAX)}…`;
}

export function hotelSnapshot(input: {
  hotel: HotelOffer;
  pack: HotelRoompack;
  checkin: string;
  checkout: string;
  images: readonly string[];
  description?: string | undefined;
  hotelKey?: string | undefined;
  test?: boolean;
}): HotelSnapshot {
  const { hotel, pack } = input;
  const images = [...new Set([...(hotel.mainImage ? [hotel.mainImage.url] : []), ...input.images])]
    .filter((src) => src.startsWith('/api/hotels/images/'))
    .slice(0, 6);
  return {
    kind: 'hotel',
    name: hotel.name ?? 'Hotel',
    ...(hotel.stars ? { stars: hotel.stars } : {}),
    ...(hotel.address ? { address: hotel.address } : {}),
    ...(hotel.location ? { location: hotel.location } : {}),
    images,
    ...(input.description ? { description: input.description } : {}),
    ...(pack.rooms[0]?.name ? { roomName: pack.rooms[0].name } : {}),
    board: pack.board,
    ...(pack.boardLabel ? { boardLabel: pack.boardLabel } : {}),
    refundable: pack.cancellation.refundable,
    ...(pack.cancellation.freeCancellationUntilLocal
      ? { freeCancellationUntilLocal: pack.cancellation.freeCancellationUntilLocal }
      : {}),
    checkin: input.checkin,
    checkout: input.checkout,
    rooms: pack.rooms.length || 1,
    ...(input.hotelKey ? { hotelKey: input.hotelKey } : {}),
    ...(input.test ? { test: true } : {}),
  };
}

export function carSnapshot(c: CarOffer, search: CarSearchValues): CarSnapshot {
  return {
    kind: 'car',
    model: c.carModel,
    category: c.category,
    companyName: c.companyName,
    ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
    ...(c.companyImageUrl ? { companyImageUrl: c.companyImageUrl } : {}),
    doors: c.doors,
    passengers: c.passengers,
    bags: c.bags,
    automatic: /^a/i.test(c.trans) || c.sippCode.charAt(2).toUpperCase() === 'A',
    air: c.air,
    kmIncluded: c.kmIncluded,
    pickUp: { code: search.pickUpLocation, date: search.pickUpDate, hour: search.pickUpHour },
    dropOff: { code: search.dropOffLocation, date: search.dropOffDate, hour: search.dropOffHour },
  };
}

// ─────────────────────────── Lo que va al API ───────────────────────────

export interface PackageItemPayload {
  vertical: LaneKind | ManualVertical;
  providerName: string;
  providerItemId: string;
  rawDetails: ItemSnapshot;
  baseFareMinor: number;
  taxesMinor: number;
  currency: string;
  minimumSellingMinor?: number;
}

/**
 * El API recalcula el precio de venta con la cascada: se le manda el NETO. Mandarle el precio de
 * venta aplicaría el markup dos veces.
 */
export function flightItem(o: Offer): PackageItemPayload {
  return {
    vertical: 'flights',
    providerName: o.provider.name,
    providerItemId: o.provider.offerRef || o.id,
    rawDetails: flightSnapshot(o),
    baseFareMinor: o.baseFare.amountMinor,
    taxesMinor: o.total.amountMinor - o.baseFare.amountMinor,
    currency: o.total.currency.toUpperCase(),
  };
}

export function hotelItem(pack: HotelRoompack, snapshot: HotelSnapshot): PackageItemPayload {
  return {
    vertical: 'hotels',
    providerName: pack.provider?.name ?? 'hotels',
    providerItemId: pack.provider?.offerRef ?? pack.id,
    rawDetails: snapshot,
    baseFareMinor: pack.price.total.amountMinor,
    taxesMinor: 0,
    currency: pack.price.total.currency.toUpperCase(),
    ...(pack.price.minimumSellingPrice
      ? { minimumSellingMinor: pack.price.minimumSellingPrice.amountMinor }
      : {}),
  };
}

export function carItem(c: CarOffer, search: CarSearchValues): PackageItemPayload {
  return {
    vertical: 'cars',
    providerName: 'agent-cars',
    providerItemId: carKey(c),
    rawDetails: carSnapshot(c, search),
    baseFareMinor: c.rateAmount.amountMinor,
    taxesMinor: 0,
    currency: c.rateAmount.currency.toUpperCase(),
  };
}

export interface ManualDraft {
  vertical: ManualVertical;
  title: string;
  description?: string;
  date?: string;
  priceMinor: number;
}

export function manualItem(draft: ManualDraft, currency: string, seq: number): PackageItemPayload {
  return {
    vertical: draft.vertical,
    providerName: 'manual',
    providerItemId: `manual-${seq}`,
    rawDetails: {
      kind: 'manual',
      title: draft.title.trim(),
      ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
      ...(draft.date ? { date: draft.date } : {}),
    },
    baseFareMinor: draft.priceMinor,
    taxesMinor: 0,
    currency,
  };
}

/** Título de la cotización: «Cartagena · 5 noches». */
export function packageTitle(destinationLabel: string, nights: number): string {
  const city = destinationLabel.split(',')[0]?.trim() || destinationLabel.trim() || 'Viaje';
  return nights > 0 ? `${city} · ${nights} ${nights === 1 ? 'noche' : 'noches'}` : city;
}

export function nightsBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ─────────────────────────── Itinerario día a día ───────────────────────────

export interface ItineraryEvent {
  time?: string;
  icon: 'flight' | 'hotel' | 'car' | 'activity';
  text: string;
}

export interface ItineraryDay {
  date: string;
  dayNumber: number;
  events: ItineraryEvent[];
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function clock(iso: string): string | undefined {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

function hourText(hhmmValue: string): string {
  return `${hhmmValue.slice(0, 2)}:${hhmmValue.slice(2, 4)}`;
}

/**
 * El viaje contado por días, a partir de lo que se cotizó: vuelos, entrada y salida del hotel,
 * auto y servicios manuales con fecha. Los días sin nada quedan como «Día libre».
 */
export function buildItinerary(
  start: string,
  end: string,
  items: readonly ItemSnapshot[],
  placeName: (code: string) => string = (c) => c,
): ItineraryDay[] {
  const nights = nightsBetween(start, end);
  const days: ItineraryDay[] = Array.from({ length: nights + 1 }, (_, i) => ({
    date: addDaysIso(start, i),
    dayNumber: i + 1,
    events: [],
  }));
  const at = (date: string) => days.find((d) => d.date === date);

  for (const item of items) {
    if (item.kind === 'flight') {
      for (const it of item.itineraries) {
        const first = it.segments[0];
        const last = it.segments.at(-1);
        if (!first || !last) continue;
        const day = at(first.departureAt.slice(0, 10));
        const via = it.stops > 0 ? ` (${it.stops} ${it.stops === 1 ? 'escala' : 'escalas'})` : '';
        const time = clock(first.departureAt);
        day?.events.push({
          ...(time ? { time } : {}),
          icon: 'flight',
          text: `Vuelo ${placeName(first.origin)} → ${placeName(last.destination)}${via}`,
        });
      }
    } else if (item.kind === 'hotel') {
      at(item.checkin)?.events.push({ icon: 'hotel', text: `Check-in en ${item.name}` });
      at(item.checkout)?.events.push({ icon: 'hotel', text: `Check-out de ${item.name}` });
    } else if (item.kind === 'car') {
      at(item.pickUp.date)?.events.push({
        time: hourText(item.pickUp.hour),
        icon: 'car',
        text: `Retiro del auto (${item.model})`,
      });
      at(item.dropOff.date)?.events.push({
        time: hourText(item.dropOff.hour),
        icon: 'car',
        text: 'Devolución del auto',
      });
    } else if (item.kind === 'manual' && item.date) {
      at(item.date)?.events.push({ icon: 'activity', text: item.title });
    } else if (item.kind === 'activity') {
      const time = item.startAt ? clock(item.startAt) : undefined;
      at(item.date)?.events.push({
        ...(time ? { time } : {}),
        icon: 'activity',
        text: item.modality ? `${item.title} · ${item.modality}` : item.title,
      });
    }
  }
  for (const day of days) {
    day.events.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
  }
  return days;
}

/** Lee el snapshot guardado sin confiar en su forma: un ítem viejo o ajeno no rompe la página. */
export function asSnapshot(details: unknown): ItemSnapshot | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const kind = (details as { kind?: unknown }).kind;
  return kind === 'flight' ||
    kind === 'hotel' ||
    kind === 'car' ||
    kind === 'manual' ||
    kind === 'activity'
    ? (details as ItemSnapshot)
    : undefined;
}
