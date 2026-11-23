/*
 * Modelo de la sección de actividades: tipos espejo del contrato /activities del API y funciones
 * puras (formato, cancelación, participantes y el ítem de paquete). Sin React, para testearlas.
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface Participants {
  adults: number;
  childrenAges: number[];
}

export type ActivityCategory = 'ticket' | 'tour';

export interface ActivitySummary {
  id: string;
  category: ActivityCategory;
  name: string;
}

export interface AgeRange {
  minAge: number;
  maxAge: number;
}

export interface ActivityModality {
  id: string;
  name: string;
  availableDates: { date: string; hours: string[] }[];
  referencePrices: Money[];
  maxCapacity?: number;
  ageRanges: { adult?: AgeRange; child?: AgeRange; infant?: AgeRange };
  additionals: { id: string; title: string; description?: string; prices: Money[] }[];
}

export interface ActivityDetail {
  id: string;
  category: ActivityCategory;
  name: string;
  description?: string;
  duration?: { unit: string; value: number };
  images: string[];
  inclusions: string[];
  exclusions: string[];
  modalities: ActivityModality[];
}

export interface CancellationTier {
  from: string;
  to?: string;
  percentage: number;
  label?: string;
  penalties: Money[];
}

export interface ActivityCancellation {
  refundable: boolean;
  title?: string;
  tiers: CancellationTier[];
  conditions: string[];
}

export interface ActivityPrice {
  currency: string;
  net: Money;
  tax: Money;
  gross: Money;
  agencyCommission?: Money;
}

export interface TenantPricing {
  costMinor: number;
  finalMinor: number;
  ownMarkupMinor: number;
  currency: string;
}

export interface ActivityOffer {
  choiceId: string;
  activityId: string;
  modalityId?: string;
  category: ActivityCategory;
  name: string;
  modalityName?: string;
  date: string;
  startAt?: string;
  endAt?: string;
  participants: Participants;
  prices: ActivityPrice[];
  price: ActivityPrice;
  pricing?: TenantPricing;
  cancellation: ActivityCancellation;
  ticketValidity?: { useDate?: string; expirationDate?: string };
  highlights: string[];
}

export interface ActivitiesStatus {
  enabled: boolean;
  reason?: 'flag-off' | 'kill-switch';
}

// ───────────────────────── Formato ─────────────────────────

const ZERO_DECIMALS = new Set(['COP', 'CLP', 'PYG', 'JPY']);

export function formatMoney(m: Money, locale = 'es-CO'): string {
  const digits = ZERO_DECIMALS.has(m.currency) ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(m.amountMinor / 100);
  } catch {
    return `${m.currency} ${(m.amountMinor / 100).toFixed(digits)}`;
  }
}

/** Lo que la agencia cobra: el final de la cascada o, sin reglas, el bruto del proveedor. */
export function saleOf(offer: Pick<ActivityOffer, 'price' | 'pricing'>): Money {
  return offer.pricing
    ? { amountMinor: offer.pricing.finalMinor, currency: offer.pricing.currency }
    : offer.price.gross;
}

/** `2026-12-10` → `mié 10 dic 2026`, sin correr la fecha por zona horaria. */
export function formatDate(iso: string, locale = 'es-CO'): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!d) return iso;
  const date = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function participantsLabel(p: Participants): string {
  const adults = `${p.adults} ${p.adults === 1 ? 'adulto' : 'adultos'}`;
  if (p.childrenAges.length === 0) return adults;
  const ages = p.childrenAges.map((a) => (a === 0 ? 'menos de 1' : String(a))).join(', ');
  const n = p.childrenAges.length;
  return `${adults} · ${n} ${n === 1 ? 'menor' : 'menores'} (${ages} ${
    p.childrenAges.length === 1 && p.childrenAges[0] === 1 ? 'año' : 'años'
  })`;
}

export function participantCount(p: Participants): number {
  return p.adults + p.childrenAges.length;
}

/**
 * La cancelación en una línea: lo que el vendedor le repite al cliente. Usa el primer tramo gratis
 * (hasta cuándo) o dice que no hay reembolso.
 */
export function cancellationSummary(c: ActivityCancellation): string {
  if (!c.refundable || c.tiers.length === 0) return 'No reembolsable';
  const free = c.tiers.find((t) => t.percentage === 0);
  if (free?.to) return `Cancelación gratis hasta el ${formatDate(free.to)}`;
  if (free) return 'Cancelación gratis';
  const min = Math.min(...c.tiers.map((t) => t.percentage));
  return `Cancelación con cargo desde ${min}%`;
}

export function tierLabel(t: CancellationTier): string {
  const range = t.to
    ? `${formatDate(t.from)} – ${formatDate(t.to)}`
    : `desde ${formatDate(t.from)}`;
  const what =
    t.percentage === 0
      ? 'sin cargo'
      : t.percentage >= 100
        ? 'sin reembolso'
        : `se cobra el ${t.percentage}%`;
  return `${range}: ${what}`;
}

// ───────────────────────── Participantes ─────────────────────────

/**
 * Edades separadas por coma (`7, 1`). Devuelve el error para mostrar, o las edades. Los menores
 * son 0–17; el proveedor decide con la edad si es niño o bebé.
 */
export function parseAges(
  raw: string,
): { ok: true; ages: number[] } | { ok: false; error: string } {
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ages: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,2}$/.test(p) || Number(p) > 17) {
      return {
        ok: false,
        error: 'Escribe la edad de cada menor entre 0 y 17, separadas por coma.',
      };
    }
    ages.push(Number(p));
  }
  return { ok: true, ages };
}

/** Edad cumplida al día de la actividad (YYYY-MM-DD). */
export function ageOn(birthDate: string, onDate: string): number | undefined {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onDate);
  if (!b || !d) return undefined;
  let age = Number(d[1]) - Number(b[1]);
  if (Number(d[2]) < Number(b[2]) || (d[2] === b[2] && Number(d[3]) < Number(b[3]))) age -= 1;
  return age;
}

/**
 * Los participantes que se cargan en la reserva tienen que coincidir con los de la tarifa: misma
 * cantidad y, para los menores, las mismas edades al día de la actividad (la certificación pide
 * verificar la edad). Devuelve el problema o `undefined`.
 */
export function travelersMismatch(
  participants: Participants,
  birthDates: readonly string[],
  date: string,
): string | undefined {
  if (birthDates.length !== participantCount(participants)) {
    return `La tarifa es para ${participantCount(participants)} participantes.`;
  }
  const minors = birthDates
    .map((b) => ageOn(b, date))
    .filter((a): a is number => a !== undefined && a < 18)
    .sort((a, b) => a - b);
  const expected = [...participants.childrenAges].sort((a, b) => a - b);
  if (minors.length !== expected.length || minors.some((a, i) => a !== expected[i])) {
    return `Las fechas de nacimiento no coinciden con las edades de la búsqueda (${
      expected.length > 0 ? expected.join(', ') : 'sin menores'
    }).`;
  }
  return undefined;
}

// ───────────────────────── Paquetes ─────────────────────────

/**
 * Snapshot de una actividad dentro de un paquete (`package_items.raw_details`), con el contrato
 * acordado con Paquetes (docs/platform/20-paquetes.md): `kind: 'activity'` y participantes propios,
 * que no heredan la ocupación del hotel.
 */
export interface ActivitySnapshot {
  kind: 'activity';
  title: string;
  category: ActivityCategory;
  modality?: string;
  date: string;
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

/** El cuerpo de `POST /packages/:id/items` para una actividad. */
export interface ActivityPackageItemInput {
  vertical: 'activities';
  providerName: 'despegar-activities';
  providerItemId: string;
  rawDetails: ActivitySnapshot;
  baseFareMinor: number;
  taxesMinor: number;
  currency: string;
  minimumSellingMinor?: number;
}

export function toActivitySnapshot(
  offer: ActivityOffer,
  detail?: Pick<ActivityDetail, 'images' | 'description'>,
  test?: boolean,
): ActivitySnapshot {
  return {
    kind: 'activity',
    title: offer.name,
    category: offer.category,
    date: offer.date,
    participants: {
      adults: offer.participants.adults,
      childrenAges: [...offer.participants.childrenAges],
    },
    cancellation: {
      refundable: offer.cancellation.refundable,
      tiers: offer.cancellation.tiers.map((t) => ({
        from: t.from,
        percentage: t.percentage,
        ...(t.to ? { to: t.to } : {}),
        ...(t.label ? { label: t.label } : {}),
      })),
    },
    images: (detail?.images ?? []).slice(0, 4),
    ...(offer.modalityName ? { modality: offer.modalityName } : {}),
    ...(offer.startAt ? { startAt: offer.startAt } : {}),
    ...(offer.endAt ? { endAt: offer.endAt } : {}),
    ...(offer.ticketValidity ? { ticketValidity: { ...offer.ticketValidity } } : {}),
    ...(detail?.description ? { description: detail.description.slice(0, 1000) } : {}),
    ...(test ? { test: true } : {}),
  };
}

/**
 * El ítem de paquete de una tarifa en la moneda del PAQUETE. Un paquete tiene una sola moneda y la
 * plataforma no convierte: de los precios de HotelDO (USD y local) se toma el de esa moneda. Si no
 * está, `undefined` (el API rechazaría el ítem con 409).
 *
 * El neto va en `baseFareMinor` + `taxesMinor` (neto e impuestos del proveedor); la cascada de
 * markup la aplica el paquete. Despegar no informa un piso de venta para actividades.
 */
export function toPackageItemInput(
  offer: ActivityOffer,
  packageCurrency: string,
  detail?: Pick<ActivityDetail, 'images' | 'description'>,
  test?: boolean,
): ActivityPackageItemInput | undefined {
  const currency = packageCurrency.toUpperCase();
  const price = offer.prices.find((p) => p.currency === currency);
  if (!price) return undefined;
  return {
    vertical: 'activities',
    providerName: 'despegar-activities',
    providerItemId: offer.choiceId,
    rawDetails: toActivitySnapshot(offer, detail, test),
    baseFareMinor: price.net.amountMinor,
    taxesMinor: price.tax.amountMinor,
    currency,
  };
}
