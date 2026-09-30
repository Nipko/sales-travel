import type { HotelRoompack, Money } from '../../actions';
import { formatMoney } from '../../_components/hotel-format';
import { saleTotal } from '../../_components/hotel-rate-view';
import type { RateSelection } from '../../_components/hotel-rate-selection';
import { OFFER_WARNING_REMAINING_MS, type OfferExpiryState } from '../../_components/offer-expiry';
import { FUNDING_GATE_REASON, parseFunding, type PrebookFunding } from './funding-view';
import { parseNonRefundable, type PrebookNonRefundable } from './non-refundable-view';

/*
 * El paso 1 del checkout sin React (U-09 a U-11): la respuesta del PreBook neutral leída sin
 * confiar en su forma, el aviso de cambio de precio con la regla de D-TBO-20 A, las señales
 * críticas de la tarifa (D-TBO-22 A) y qué falta para seguir.
 */

/** Espejo de `HotelRateConditionCategory` del dominio. */
export type HotelRateConditionCategory =
  | 'checkIn'
  | 'checkOut'
  | 'minCheckInAge'
  | 'mandatoryFees'
  | 'optionalFees'
  | 'cardsAccepted'
  | 'specialInstructions'
  | 'other';

/** Una condición del hotel ya saneada por el API: texto plano, nunca HTML (RF-16). */
export interface HotelPrebookCondition {
  readonly category: HotelRateConditionCategory;
  readonly text: string;
}

export type HotelRepriceOutcome = 'UNCHANGED' | 'DECREASED' | 'INCREASED' | 'CONDITIONS_CHANGED';
export type HotelPriceDirection = 'SAME' | 'DOWN' | 'UP' | 'NOT_COMPARABLE';

/**
 * La comparación C1 del servidor, SIN sus importes: `previousTotal` y `currentTotal` son netos del
 * proveedor y no salen del servidor de la web (G3). El precio que se compara en pantalla es el de
 * VENTA.
 */
export interface HotelPrebookRepricing {
  readonly outcome: HotelRepriceOutcome;
  readonly price: HotelPriceDirection;
  /** Vocabulario cerrado del API (`CURRENCY`, `CANCEL_POLICIES`…). */
  readonly changes: readonly string[];
}

/** Lo que el paso 1 usa de `POST /hotels/prebook` con el cuerpo neutral. */
export interface HotelPrebook {
  /** Con esto se pide el Book (PR-6.4): el resto del snapshot queda en el servidor. */
  readonly prebookRef: string;
  readonly providerCode: string;
  readonly hotelId: string;
  /** Hasta cuándo se puede reservar sin volver a buscar (RF-09). Instante con zona. */
  readonly expiresAt: string;
  /** Políticas finales del PreBook y precio de venta sobre el neto revalidado. */
  readonly roompack: HotelRoompack;
  readonly rateConditions: readonly HotelPrebookCondition[];
  /** Vocabulario cerrado (`PACKAGE_WITH_FLIGHT_ONLY`, `NO_NAME_CHANGE`, `MARKET_RESTRICTION`). */
  readonly signals: readonly string[];
  readonly repricing: HotelPrebookRepricing;
  /**
   * Si la cartera de la agencia en la moneda de la tarifa cubre el precio de venta (RF-23). Sin él
   * no se sabe, y decide el Book.
   */
  readonly funding?: PrebookFunding;
  /**
   * La tarifa es no reembolsable en los hechos con la política final (pedido del 2026-09-29): el
   * 100 % en el precio de venta. El Book exige la confirmación del vendedor.
   */
  readonly nonRefundable?: PrebookNonRefundable;
}

// ───────────────────────── Lectura de la respuesta ─────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CATEGORIES: ReadonlySet<string> = new Set<HotelRateConditionCategory>([
  'checkIn',
  'checkOut',
  'minCheckInAge',
  'mandatoryFees',
  'optionalFees',
  'cardsAccepted',
  'specialInstructions',
  'other',
]);
const OUTCOMES: ReadonlySet<string> = new Set<HotelRepriceOutcome>([
  'UNCHANGED',
  'DECREASED',
  'INCREASED',
  'CONDITIONS_CHANGED',
]);
const DIRECTIONS: ReadonlySet<string> = new Set<HotelPriceDirection>([
  'SAME',
  'DOWN',
  'UP',
  'NOT_COMPARABLE',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) &&
    typeof value['amountMinor'] === 'number' &&
    Number.isInteger(value['amountMinor']) &&
    isNonEmptyString(value['currency'])
  );
}

function isPricing(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['costMinor', 'finalMinor', 'ownMarkupMinor'].every(
      (k) => typeof value[k] === 'number' && Number.isInteger(value[k]),
    ) &&
    isNonEmptyString(value['currency'])
  );
}

/**
 * Lo mínimo para pintar la tarifa sin inventar nada: proveedor, régimen, habitaciones, política y
 * precio. El resto de los campos son opcionales en el contrato y la vista ya tolera su ausencia.
 */
function isRoompack(value: unknown): value is HotelRoompack {
  if (!isRecord(value)) return false;
  const provider = value['provider'];
  const cancellation = value['cancellation'];
  const price = value['price'];
  const rooms = value['rooms'];
  return (
    isNonEmptyString(value['id']) &&
    isRecord(provider) &&
    isNonEmptyString(provider['name']) &&
    isNonEmptyString(provider['offerRef']) &&
    isNonEmptyString(value['board']) &&
    Array.isArray(rooms) &&
    rooms.length > 0 &&
    rooms.every((r) => isRecord(r) && typeof r['name'] === 'string') &&
    isRecord(cancellation) &&
    typeof cancellation['refundable'] === 'boolean' &&
    isNonEmptyString(cancellation['status']) &&
    Array.isArray(cancellation['rules']) &&
    isRecord(price) &&
    isMoney(price['total']) &&
    (value['pricing'] === undefined || isPricing(value['pricing']))
  );
}

function conditionsOf(value: unknown): HotelPrebookCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HotelPrebookCondition[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['text'] !== 'string') return undefined;
    const category = item['category'];
    out.push({
      // Una categoría que el API sume mañana no se pierde: va con las demás.
      category:
        typeof category === 'string' && CATEGORIES.has(category)
          ? (category as HotelRateConditionCategory)
          : 'other',
      text: item['text'],
    });
  }
  return out;
}

function codesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((c) => typeof c === 'string' && CODE_RE.test(c)) ? [...value] : undefined;
}

/**
 * La respuesta del PreBook neutral, o `undefined` si no es una tarifa revalidada completa: sin
 * `prebookRef` no hay Book posible, y sin precio ni política no hay nada que aceptar.
 */
export function parsePrebook(value: unknown): HotelPrebook | undefined {
  if (!isRecord(value)) return undefined;
  const { prebookRef, providerCode, hotelId, expiresAt, roompack, repricing } = value;
  if (typeof prebookRef !== 'string' || !UUID_RE.test(prebookRef)) return undefined;
  if (!isNonEmptyString(providerCode) || !isNonEmptyString(hotelId)) return undefined;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  if (!isRoompack(roompack)) return undefined;
  const rateConditions = conditionsOf(value['rateConditions']);
  const signals = codesOf(value['signals']);
  if (rateConditions === undefined || signals === undefined || !isRecord(repricing)) {
    return undefined;
  }
  const { outcome, price } = repricing;
  const changes = codesOf(repricing['changes']);
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return undefined;
  if (typeof price !== 'string' || !DIRECTIONS.has(price) || changes === undefined) {
    return undefined;
  }
  const funding = parseFunding(value['funding']);
  const nonRefundable = parseNonRefundable(value['nonRefundable']);
  return {
    prebookRef,
    providerCode,
    hotelId,
    expiresAt,
    roompack,
    rateConditions,
    signals,
    repricing: {
      outcome: outcome as HotelRepriceOutcome,
      price: price as HotelPriceDirection,
      changes,
    },
    ...(funding === undefined ? {} : { funding }),
    ...(nonRefundable === undefined ? {} : { nonRefundable }),
  };
}

// ───────────────────────── Errores del PreBook ─────────────────────────

/**
 * ¿Vale la pena repetir el mismo PreBook? Sí cuando el problema fue de transporte o del proveedor
 * (5xx, 429, 408): el PreBook no mueve dinero. No cuando el API dijo qué cambió (409: venció, ya
 * no está, cambió la cuenta) o que la tarifa no es de una búsqueda vigente (400): repetirlo da lo
 * mismo, y lo que corresponde es volver al hotel, que busca de nuevo.
 */
export function isRetryablePrebookStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

// ───────────────────────── Cambio de precio (U-09) ─────────────────────────

const CHANGE_LABELS: Readonly<Record<string, string>> = {
  CURRENCY: 'la moneda',
  REFUNDABLE: 'si es reembolsable',
  MEAL_TYPE: 'el régimen de comidas',
  AT_PROPERTY_CHARGES: 'los cargos a pagar en el hotel',
  CANCEL_POLICIES: 'la política de cancelación',
  SIGNALS: 'las restricciones de la tarifa',
  RATE_CONDITIONS: 'las condiciones del hotel',
};

/** "a, b y c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

export type PriceChangeTone = 'warning' | 'success' | 'info';

export interface PriceChangeView {
  readonly tone: PriceChangeTone;
  readonly title: string;
  /** Precio de venta que el vendedor vio al elegir la tarifa, si es comparable. */
  readonly before?: string;
  /** Precio de venta revalidado. */
  readonly after: string;
  /** Diferencia con signo ("+ 12,00 US$"), si es comparable. */
  readonly delta?: string;
  /** Qué más cambió, en una frase, o nada. */
  readonly changes?: string;
  /**
   * Hay que aceptarlo para seguir: subió el precio o cambiaron las condiciones (D-TBO-20 A). Si
   * baja, se avisa y se sigue.
   */
  readonly requiresAcceptance: boolean;
  /** El texto de la casilla de aceptación. */
  readonly acceptLabel?: string;
}

/**
 * El aviso de cambio entre lo que el vendedor vio y lo que revalidó el proveedor (RF-15 CA-3,
 * U-09), o `undefined` si no cambió nada.
 *
 * Se miran las dos cosas: la comparación C1 del servidor (neto, moneda y condiciones) y el precio
 * de VENTA en pantalla, que puede moverse aunque el neto no (el piso del proveedor, otra regla de
 * la red). El importe que se muestra es siempre el de venta: el neto no sale del servidor (G3).
 */
export function priceChangeView(
  prebook: Pick<HotelPrebook, 'roompack' | 'repricing'>,
  shownSale: Money | undefined,
): PriceChangeView | undefined {
  const { repricing } = prebook;
  const next = saleTotal(prebook.roompack);
  const after = formatMoney(next);
  const comparable = shownSale !== undefined && shownSale.currency === next.currency;
  const diff = comparable ? next.amountMinor - shownSale.amountMinor : undefined;
  const currencyChanged =
    (shownSale !== undefined && shownSale.currency !== next.currency) ||
    repricing.price === 'NOT_COMPARABLE' ||
    repricing.changes.includes('CURRENCY');
  const conditions = [
    ...new Set(
      repricing.changes
        .filter((c) => c !== 'CURRENCY')
        .map((c) => CHANGE_LABELS[c] ?? 'otras condiciones'),
    ),
  ];
  const before = shownSale === undefined ? undefined : formatMoney(shownSale);
  // Tachar un precio para repetirlo al lado dice que cambió algo que no cambió.
  const withBefore = before === undefined || currencyChanged || diff === 0 ? {} : { before };
  const delta =
    diff === undefined || diff === 0
      ? {}
      : {
          delta: `${diff > 0 ? '+' : '−'} ${formatMoney({ amountMinor: Math.abs(diff), currency: next.currency })}`,
        };
  const changes = conditions.length > 0 ? { changes: `Qué cambió: ${joinList(conditions)}.` } : {};

  if (currencyChanged) {
    return {
      tone: 'warning',
      title: 'Cambió la moneda de la tarifa.',
      ...(before === undefined ? {} : { before }),
      after,
      ...changes,
      requiresAcceptance: true,
      acceptLabel: `Revisé los cambios y acepto el precio de venta de ${after}.`,
    };
  }

  // Sin el precio que vio el vendedor, manda la dirección que midió el servidor sobre el neto.
  const priceUp = diff !== undefined ? diff > 0 : repricing.outcome === 'INCREASED';
  const priceDown = diff !== undefined ? diff < 0 : repricing.outcome === 'DECREASED';
  if (priceUp || conditions.length > 0 || repricing.outcome === 'CONDITIONS_CHANGED') {
    const title = priceUp
      ? 'El precio subió al revalidar la tarifa.'
      : priceDown
        ? 'Cambiaron las condiciones y el precio bajó.'
        : 'Cambiaron las condiciones de la tarifa.';
    return {
      tone: 'warning',
      title,
      ...withBefore,
      after,
      ...delta,
      ...(conditions.length > 0
        ? changes
        : priceUp
          ? {}
          : { changes: 'El proveedor actualizó las condiciones: revisalas abajo.' }),
      requiresAcceptance: true,
      acceptLabel: !priceUp
        ? `Revisé las condiciones nuevas y acepto seguir con ${after}.`
        : conditions.length > 0
          ? `Revisé los cambios y acepto el precio nuevo de ${after}.`
          : `Acepto el precio nuevo de ${after}.`,
    };
  }

  if (priceDown) {
    return {
      tone: 'success',
      title: 'El precio bajó al revalidar la tarifa.',
      ...withBefore,
      after,
      ...delta,
      requiresAcceptance: false,
    };
  }

  // El neto cambió y el precio de venta no: se dice igual (RF-15 CA-3), sin pedir nada.
  if (repricing.outcome !== 'UNCHANGED') {
    return {
      tone: 'info',
      title: 'El proveedor actualizó la tarifa; el precio de venta no cambió.',
      after,
      requiresAcceptance: false,
    };
  }
  return undefined;
}

// ───────────────────────── Señales críticas (U-11) ─────────────────────────

export interface SignalNotice {
  readonly code: string;
  readonly tone: 'danger' | 'warning';
  readonly title: string;
  readonly detail: string;
}

export interface SignalsView {
  /** La tarifa no se puede vender como hotel suelto (D-TBO-22 A): no se sigue. */
  readonly blocking: boolean;
  readonly notices: readonly SignalNotice[];
}

const SIGNAL_NOTICES: Readonly<Record<string, Omit<SignalNotice, 'code'>>> = {
  PACKAGE_WITH_FLIGHT_ONLY: {
    tone: 'danger',
    title: 'Esta tarifa sólo se vende en un paquete con aéreo.',
    detail: 'No se puede reservar como hotel suelto. Volvé al hotel y elegí otra tarifa.',
  },
  NO_NAME_CHANGE: {
    tone: 'warning',
    title: 'No admite cambio de nombre.',
    detail:
      'Cargá los nombres de los huéspedes tal como figuran en su documento: después de reservar no se pueden corregir.',
  },
  MARKET_RESTRICTION: {
    tone: 'warning',
    title: 'Tiene restricciones según el país del huésped.',
    detail:
      'Revisá las condiciones del hotel antes de seguir: la tarifa puede no valer para este pasajero.',
  },
};

const UNKNOWN_SIGNAL: Omit<SignalNotice, 'code'> = {
  tone: 'warning',
  title: 'Esta tarifa tiene una restricción.',
  detail: 'Revisá las condiciones del hotel antes de seguir.',
};

/** Las señales críticas, arriba y fuera del colapsable (docs/tbo/03 §2.4), la que bloquea primero. */
export function signalsView(signals: readonly string[]): SignalsView {
  const notices = [...new Set(signals)]
    .map((code) => ({ code, ...(SIGNAL_NOTICES[code] ?? UNKNOWN_SIGNAL) }))
    .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
  return { blocking: signals.includes('PACKAGE_WITH_FLIGHT_ONLY'), notices };
}

// ───────────────────────── Vencimiento (RF-09) ─────────────────────────

/** Los avisos del contador para UNA tarifa: el del listado habla de "estas tarifas". */
export function checkoutExpiryNotice(
  state: Pick<OfferExpiryState, 'phase'>,
): { tone: 'warning' | 'expired'; title: string; detail: string } | undefined {
  if (state.phase === 'expired') {
    return {
      tone: 'expired',
      title: 'La tarifa venció.',
      detail: 'El proveedor ya no la mantiene. Volvé al hotel para buscarla de nuevo.',
    };
  }
  if (state.phase === 'warning') {
    return {
      tone: 'warning',
      title: `Quedan menos de ${OFFER_WARNING_REMAINING_MS / 60_000} minutos para reservar esta tarifa.`,
      detail: 'Después hay que buscarla de nuevo: el proveedor ya no la mantiene.',
    };
  }
  return undefined;
}

// ───────────────────────── Seguir al paso 2 ─────────────────────────

export interface ContinueGate {
  readonly ok: boolean;
  /** Por qué no se puede seguir, a la vista junto al botón. */
  readonly reason?: string;
}

/**
 * Qué falta para pasar a los huéspedes, en el orden en que el vendedor lo resuelve. Una cartera que
 * no cubre la tarifa frena acá y no en el Book: cargar los huéspedes sería en vano.
 */
export function continueGate(input: {
  readonly expired: boolean;
  readonly blocked: boolean;
  readonly change: Pick<PriceChangeView, 'requiresAcceptance'> | undefined;
  readonly accepted: boolean;
  readonly funding?: PrebookFunding;
}): ContinueGate {
  if (input.expired) {
    return { ok: false, reason: 'La tarifa venció: volvé al hotel para buscarla de nuevo.' };
  }
  if (input.blocked) {
    return { ok: false, reason: 'Esta tarifa no se puede reservar como hotel suelto.' };
  }
  if (input.funding?.status === 'blocked') return { ok: false, reason: FUNDING_GATE_REASON };
  if (input.change?.requiresAcceptance === true && !input.accepted) {
    return { ok: false, reason: 'Aceptá los cambios de la tarifa para continuar.' };
  }
  return { ok: true };
}

/**
 * Lo que el paso 2 (huéspedes y Book, PR-6.4) recibe del paso 1: la tarifa revalidada, el precio
 * de VENTA que el vendedor aceptó —el que el Book manda como `acceptedTotal` y el servidor vuelve
 * a verificar en C2— y la elección, con la estadía por habitación en el orden de la búsqueda.
 */
export interface AcceptedPrebook {
  readonly prebook: HotelPrebook;
  readonly acceptedTotal: Money;
  readonly selection: RateSelection;
  /** Reloj del servidor menos el del navegador, para el vencimiento. */
  readonly clockOffsetMs: number;
}

export function acceptedPrebookOf(
  prebook: HotelPrebook,
  selection: RateSelection,
  clockOffsetMs: number,
): AcceptedPrebook {
  return { prebook, acceptedTotal: saleTotal(prebook.roompack), selection, clockOffsetMs };
}
