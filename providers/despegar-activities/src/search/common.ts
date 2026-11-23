import {
  Money,
  type ActivityCancellation,
  type ActivityCategory,
  type ActivityParticipants,
  type ActivityPrice,
  type TicketValidity,
} from '@sales-travel/canonical';

/** Despegar manda montos como número o como texto. Lo que no es un número finito ≥ 0 es 0. */
export function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function money(v: unknown, currency: string): Money {
  return Money.fromMajor(amount(v), currency.toUpperCase());
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x === 'string') return x.trim() === '' ? [] : [x];
    // inclusions/exclusions vienen sin tipo de ítem: a veces { description } o { title }.
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const s = str(o['description']) ?? str(o['title']) ?? str(o['name']);
      return s ? [s] : [];
    }
    return [];
  });
}

export function category(type: unknown): ActivityCategory {
  return typeof type === 'string' && type.toUpperCase() === 'TICKET' ? 'ticket' : 'tour';
}

const CURRENCY_RE = /^[A-Za-z]{3}$/;

/**
 * `distribution` de Despegar: `adultos-edad-edad…`. El primer número son los adultos; cada uno de
 * los siguientes es la edad de un menor (niño o bebé: no hay marca de bebé).
 */
export function buildDistribution(p: ActivityParticipants): string {
  const adults = Math.max(1, Math.trunc(p.adults));
  return [adults, ...p.childrenAges.map((a) => Math.trunc(a))].join('-');
}

/**
 * Hora de un tour en `HH:mm`. `modalities[].available_dates[].hours[].hour` es un número sin ejemplo
 * (sin verificar): `930` → `09:30`, `9` → `09:00`; un texto `9:30` o `09:30` se normaliza.
 */
export function hourLabel(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
    if (m) return valid(Number(m[1]), Number(m[2]));
    return /^\d+$/.test(v.trim()) ? hourLabel(Number(v)) : undefined;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined;
  if (v < 24) return valid(v, 0);
  return valid(Math.trunc(v / 100), v % 100);
}

function valid(h: number, m: number): string | undefined {
  if (h > 23 || m > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface RawPriceDetail {
  total?: unknown;
  net?: unknown;
  tax?: unknown;
  gross?: unknown;
  currency?: unknown;
  price_disaggregation?: { agency_commission?: { gross?: unknown; net?: unknown; tax?: unknown } };
}

/** `price_details[]`: un precio por moneda (USD y la local). `gross = net + tax = total`. */
export function mapPrices(raw: unknown): ActivityPrice[] {
  if (!Array.isArray(raw)) return [];
  const out: ActivityPrice[] = [];
  const seen = new Set<string>();
  for (const p of raw as RawPriceDetail[]) {
    const currency = typeof p.currency === 'string' ? p.currency.toUpperCase() : '';
    if (!CURRENCY_RE.test(currency) || seen.has(currency)) continue;
    seen.add(currency);
    const net = amount(p.net);
    const tax = amount(p.tax);
    const gross = amount(p.gross ?? p.total) || net + tax;
    const commission = p.price_disaggregation?.agency_commission;
    out.push({
      currency,
      net: money(net, currency),
      tax: money(tax, currency),
      gross: money(gross, currency),
      ...(commission && commission.gross !== undefined
        ? { agencyCommission: money(commission.gross, currency) }
        : {}),
    });
  }
  return out;
}

interface RawRange {
  from?: unknown;
  to?: unknown;
  penalty?: Record<string, unknown>;
  percentage?: unknown;
  label?: unknown;
}
interface RawCancellationPolicy {
  title?: unknown;
  cancellable?: unknown;
  ranges?: RawRange[];
  conditions?: unknown;
}

/**
 * `cancellation_policy`: tramos con `percentage` 0 (gratis) a 100 (sin reembolso). `from`/`to` son
 * `date` en availability y `date-time` en shopping: se guardan tal cual. Sin política, no
 * reembolsable: nunca se promete un reembolso que el proveedor no informó.
 */
export function mapCancellation(raw: unknown): ActivityCancellation {
  const p = (raw && typeof raw === 'object' ? raw : {}) as RawCancellationPolicy;
  const tiers = (Array.isArray(p.ranges) ? p.ranges : []).flatMap((r) => {
    const from = str(r.from);
    if (!from) return [];
    const pct = Math.min(100, amount(r.percentage));
    const penalties = Object.entries(r.penalty ?? {})
      .filter(([cur]) => CURRENCY_RE.test(cur))
      .map(([cur, v]) => money(v, cur));
    const to = str(r.to);
    const label = str(r.label);
    return [
      {
        from,
        percentage: pct,
        penalties,
        ...(to ? { to } : {}),
        ...(label ? { label } : {}),
      },
    ];
  });
  const title = str(p.title);
  return {
    refundable: p.cancellable === true && tiers.some((t) => t.percentage < 100),
    tiers,
    conditions: strings(p.conditions),
    ...(title ? { title } : {}),
  };
}

export function mapTicketValidity(raw: unknown): TicketValidity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const use = str(o['use_date']);
  const useDate = use && /^\d{4}-\d{2}-\d{2}/.test(use) ? use.slice(0, 10) : undefined;
  const expirationDate = str(o['use_expiration_date']);
  if (!useDate && !expirationDate) return undefined;
  return { ...(useDate ? { useDate } : {}), ...(expirationDate ? { expirationDate } : {}) };
}

interface RawDistribution {
  adults?: unknown;
  adults_ages?: unknown;
  children_ages?: unknown;
  infants_ages?: unknown;
  adult_max_age?: unknown;
  child_max_age?: unknown;
  infant_max_age?: unknown;
}

function ages(v: unknown): number[] {
  return Array.isArray(v)
    ? v.map((x) => amount(x)).filter((n) => Number.isInteger(n) && n <= 17)
    : [];
}

/**
 * Participantes como los devolvió el proveedor, o los pedidos si no los devolvió. Los adultos con
 * edad < 18 (la certificación pide un «adulto» de 11) siguen contando como adultos.
 */
export function mapParticipants(
  raw: unknown,
  requested: ActivityParticipants,
): { participants: ActivityParticipants; ageLimits: Record<string, number> } {
  const d = (raw && typeof raw === 'object' ? raw : {}) as RawDistribution;
  const adults = Math.trunc(amount(d.adults));
  const minors = [...ages(d.children_ages), ...ages(d.infants_ages)];
  const participants = adults >= 1 ? { adults, childrenAges: minors } : { ...requested };
  const ageLimits: Record<string, number> = {};
  for (const [key, field] of [
    ['adultMaxAge', d.adult_max_age],
    ['childMaxAge', d.child_max_age],
    ['infantMaxAge', d.infant_max_age],
  ] as const) {
    if (field !== undefined && field !== null && Number.isFinite(Number(field))) {
      ageLimits[key] = Number(field);
    }
  }
  return { participants, ageLimits };
}

/** YYYY-MM-DD de un ISO (fecha o instante); `undefined` si no empieza con una fecha. */
export function isoDate(v: unknown): string | undefined {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}
