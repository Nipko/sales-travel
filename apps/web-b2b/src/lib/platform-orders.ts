import type { Route } from 'next';
import {
  ATTENTION_REASON_LABEL,
  isOrderAttentionReason,
  type OrderAttentionReason,
} from './attention-labels';
import { sinceLabel } from './deposit-approvals';
import type { OrderVertical } from './order-vertical';
import {
  PLATFORM_RESERVAS,
  PLATFORM_TIME_ZONE,
  SEVERITY_LABEL,
  periodDates,
  type Severity,
} from './platform-overview';
import { PROVIDER_METADATA, providerMetaFor } from './provider-display';
import { buildForest, flattenForest, nodeKindLabel, type NetworkNode } from './tenant-network';
import { isCurrencyCode, isUuid, type Tone } from './wallets';

/**
 * Plataforma → Reservas de la red (`GET /admin/orders`, `GET /admin/orders/:id`): los filtros y su
 * URL, la lectura de las respuestas y los textos de la pantalla. Sin I/O.
 *
 * El superadmin busca cualquier reserva de cualquier nodo y abre su ficha. Sólo lee: no vende ni
 * cambia nada. Todo lo que llega se lee sin confiar en su forma, y lo que no se entiende no se pinta.
 */

// ───────────────────────────── Vocabulario ─────────────────────────────

/** Los estados de `orders.status` (ORDER_STATUSES del API). */
export const ORDER_STATUSES = ['pending', 'confirmed', 'ticketed', 'cancelled', 'failed'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_VERTICALS = [
  'flights',
  'hotels',
  'cars',
] as const satisfies readonly OrderVertical[];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (ORDER_STATUSES as readonly unknown[]).includes(value);
}

function isOrderVertical(value: unknown): value is OrderVertical {
  return (ORDER_VERTICALS as readonly unknown[]).includes(value);
}

/** Un código de proveedor como lo acepta el API (`latam-ndc`, `tbo-hotels`). */
const PROVIDER_CODE = /^[a-z0-9-]{2,40}$/;

export function isProviderCode(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_CODE.test(value);
}

/** El texto más largo que se busca (ADMIN_ORDERS_MAX_QUERY del API). */
export const ORDERS_SEARCH_MAX_LENGTH = 100;
/** Lo mínimo que el API acepta en la búsqueda: con una letra no se pide nada. */
export const ORDERS_SEARCH_MIN_LENGTH = 2;

// ───────────────────────────── Filtros ─────────────────────────────

export interface OrdersFilters {
  /** Sólo las que necesitan a una persona. */
  readonly attention: boolean;
  /** Ninguno = todos. En el orden de {@link ORDER_STATUSES}, sin repetir. */
  readonly statuses: readonly OrderStatus[];
  readonly vertical: OrderVertical | null;
  readonly provider: string | null;
  /** Un nodo, o `null`: toda la red. */
  readonly tenantId: string | null;
  /** Con un nodo: también su red (por omisión) o sólo él. */
  readonly subtree: boolean;
  /** Días de creación en Bogotá, `AAAA-MM-DD`, ambos incluidos. */
  readonly from: string | null;
  readonly to: string | null;
  /** PNR, localizador, n.º de orden o correo del cliente. No va en la URL (ver ordersHref). */
  readonly q: string;
}

/** Lo primero que se ve: todas las reservas de la red, de la más nueva a la más vieja. */
export const DEFAULT_ORDERS_FILTERS: OrdersFilters = {
  attention: false,
  statuses: [],
  vertical: null,
  provider: null,
  tenantId: null,
  subtree: true,
  from: null,
  to: null,
  q: '',
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Un día calendario que existe (`2026-02-30` no). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DAY.exec(value);
  if (m === null) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** Los estados en su orden de siempre y sin repetir: dos URLs con los mismos filtros son iguales. */
export function normalizeStatuses(statuses: readonly OrderStatus[]): OrderStatus[] {
  return ORDER_STATUSES.filter((s) => statuses.includes(s));
}

/** Prende o apaga un estado. */
export function toggleStatus(filters: OrdersFilters, status: OrderStatus): OrdersFilters {
  const statuses = filters.statuses.includes(status)
    ? filters.statuses.filter((s) => s !== status)
    : [...filters.statuses, status];
  return { ...filters, statuses: normalizeStatuses(statuses) };
}

/**
 * Cambia "desde" o "hasta". Un rango al revés no se pide: si "desde" queda después de "hasta", el
 * otro extremo lo acompaña (y al revés), así el pedido nunca vuelve con un 400.
 */
export function withDate(filters: OrdersFilters, key: 'from' | 'to', value: string): OrdersFilters {
  const day = isCalendarDay(value) ? value : null;
  if (key === 'from') {
    const to = day !== null && filters.to !== null && filters.to < day ? day : filters.to;
    return { ...filters, from: day, to };
  }
  const from = day !== null && filters.from !== null && filters.from > day ? day : filters.from;
  return { ...filters, from, to: day };
}

/** ¿Hay algo filtrado además de la búsqueda? Para "Limpiar filtros" y el contador del teléfono. */
export function activeFilterCount(filters: OrdersFilters): number {
  return (
    (filters.attention ? 1 : 0) +
    filters.statuses.length +
    (filters.vertical !== null ? 1 : 0) +
    (filters.provider !== null ? 1 : 0) +
    (filters.tenantId !== null ? 1 : 0) +
    (filters.from !== null || filters.to !== null ? 1 : 0)
  );
}

/** Los filtros sin nada puesto, conservando la búsqueda escrita. */
export function clearedFilters(filters: OrdersFilters): OrdersFilters {
  return { ...DEFAULT_ORDERS_FILTERS, q: filters.q };
}

// ───────────────────────────── Fechas rápidas ─────────────────────────────

export type DatePreset = 'today' | '7d' | '30d';

export const DATE_PRESETS: readonly { readonly value: DatePreset; readonly label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
];

/** Los días de un atajo, en Bogotá como el API: "hoy" es el de la plataforma, no el del navegador. */
export function presetRange(preset: DatePreset, now: Date): { from: string; to: string } {
  return periodDates(preset, now);
}

export function withPreset(filters: OrdersFilters, preset: DatePreset, now: Date): OrdersFilters {
  return { ...filters, ...presetRange(preset, now) };
}

/** El atajo que coincide con las fechas puestas, si alguno. */
export function activePreset(filters: OrdersFilters, now: Date): DatePreset | null {
  for (const { value } of DATE_PRESETS) {
    const range = presetRange(value, now);
    if (filters.from === range.from && filters.to === range.to) return value;
  }
  return null;
}

// ───────────────────────────── La URL de la pantalla ─────────────────────────────

/** `?estado=`: cómo va cada estado en la URL. */
const STATUS_PARAM: Readonly<Record<OrderStatus, string>> = {
  pending: 'pendiente',
  confirmed: 'confirmada',
  ticketed: 'emitida',
  cancelled: 'cancelada',
  failed: 'fallida',
};

/** `?vertical=`. */
const VERTICAL_PARAM: Readonly<Record<OrderVertical, string>> = {
  flights: 'vuelos',
  hotels: 'hoteles',
  cars: 'autos',
};

type SearchParamsLike =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function paramOf(params: SearchParamsLike, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return typeof value === 'string' ? value : value?.[0];
}

function keyOf<V extends string>(
  map: Readonly<Record<V, string>>,
  value: string | undefined,
): V | undefined {
  return (Object.keys(map) as V[]).find((k) => map[k] === value);
}

/**
 * Los filtros de `?atencion=1&estado=pendiente,cancelada&vertical=hoteles&proveedor=tbo-hotels
 * &nodo=<uuid>&red=no&desde=AAAA-MM-DD&hasta=AAAA-MM-DD`. Un valor que no se conoce se ignora: un
 * enlace viejo o editado a mano abre la lista, no un error.
 */
export function filtersFromSearchParams(params: SearchParamsLike): OrdersFilters {
  const nodo = paramOf(params, 'nodo');
  const tenantId = isUuid(nodo) ? nodo.toLowerCase() : null;
  const estado = paramOf(params, 'estado') ?? '';
  const statuses = normalizeStatuses(
    estado
      .split(',')
      .map((s) => keyOf(STATUS_PARAM, s.trim().toLowerCase()))
      .filter((s): s is OrderStatus => s !== undefined),
  );
  const proveedor = paramOf(params, 'proveedor')?.trim().toLowerCase();
  const desde = paramOf(params, 'desde');
  const hasta = paramOf(params, 'hasta');
  let from = isCalendarDay(desde) ? desde : null;
  let to = isCalendarDay(hasta) ? hasta : null;
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  const atencion = paramOf(params, 'atencion');
  return {
    attention: atencion === '1' || atencion === 'si',
    statuses,
    vertical: keyOf(VERTICAL_PARAM, paramOf(params, 'vertical')?.trim().toLowerCase()) ?? null,
    provider: isProviderCode(proveedor) ? proveedor : null,
    tenantId,
    subtree: tenantId === null || paramOf(params, 'red') !== 'no',
    from,
    to,
    q: '',
  };
}

/** La reserva cuya ficha está abierta (`?orden=`), o `null`. */
export function orderFromSearchParams(params: SearchParamsLike): string | null {
  const orden = paramOf(params, 'orden');
  return isUuid(orden) ? orden.toLowerCase() : null;
}

/**
 * La query de la pantalla: sólo lo que se aparta de lo de siempre. La búsqueda NO va: puede ser el
 * correo de un cliente, y una URL queda en el historial, en los registros del servidor y en lo que se
 * comparte.
 */
export function filtersToSearchParams(
  filters: OrdersFilters,
  orderId: string | null = null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.attention) params.set('atencion', '1');
  const statuses = normalizeStatuses(filters.statuses);
  if (statuses.length > 0) params.set('estado', statuses.map((s) => STATUS_PARAM[s]).join(','));
  if (filters.vertical !== null) params.set('vertical', VERTICAL_PARAM[filters.vertical]);
  if (filters.provider !== null && isProviderCode(filters.provider)) {
    params.set('proveedor', filters.provider);
  }
  if (filters.tenantId !== null && isUuid(filters.tenantId)) {
    params.set('nodo', filters.tenantId.toLowerCase());
    if (!filters.subtree) params.set('red', 'no');
  }
  if (filters.from !== null && isCalendarDay(filters.from)) params.set('desde', filters.from);
  if (filters.to !== null && isCalendarDay(filters.to)) params.set('hasta', filters.to);
  if (orderId !== null && isUuid(orderId)) params.set('orden', orderId.toLowerCase());
  return params;
}

/** La URL de la pantalla con estos filtros y, si la hay, la ficha abierta. */
export function ordersHref(filters: OrdersFilters, orderId: string | null = null): Route {
  const query = filtersToSearchParams(filters, orderId).toString();
  return query === '' ? PLATFORM_RESERVAS : `${PLATFORM_RESERVAS}?${query}`;
}

// ───────────────────────────── El pedido ─────────────────────────────

/** Un número de orden como se ve en la pantalla: "1042", "#1042" o "# 7". */
const ORDER_NUMBER_SEARCH = /^#?\s*(\d{1,9})$/;

/**
 * La búsqueda como la acepta el API: sin caracteres de control, recortada y con al menos dos
 * caracteres. `''` si no hay nada que buscar todavía.
 *
 * El número de orden se copia de la consola o del Resumen con su "#", que no es parte del número:
 * con él, el API no lo reconoce. Y cada agencia numera desde 1, así que una reserva de un dígito
 * ("7", "#7") va con un cero adelante: el API pide 2 caracteres y lee "07" como el número 7
 * (admin_search_orders, 0076).
 */
export function searchTerm(raw: string): string {
  const q = raw
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, ORDERS_SEARCH_MAX_LENGTH)
    .trim();
  const orderNumber = ORDER_NUMBER_SEARCH.exec(q)?.[1];
  if (orderNumber !== undefined) return orderNumber.length === 1 ? `0${orderNumber}` : orderNumber;
  return q.length >= ORDERS_SEARCH_MIN_LENGTH ? q : '';
}

/** La query del BFF (`/api/admin/orders`) para estos filtros y, si se pide, la página siguiente. */
export function ordersSearch(filters: OrdersFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (filters.tenantId !== null && isUuid(filters.tenantId)) {
    params.set('tenantId', filters.tenantId.toLowerCase());
    if (!filters.subtree) params.set('subtree', 'false');
  }
  if (filters.vertical !== null) params.set('vertical', filters.vertical);
  if (filters.provider !== null && isProviderCode(filters.provider)) {
    params.set('provider', filters.provider);
  }
  const statuses = normalizeStatuses(filters.statuses);
  if (statuses.length > 0) params.set('status', statuses.join(','));
  if (filters.from !== null && isCalendarDay(filters.from)) params.set('from', filters.from);
  if (filters.to !== null && isCalendarDay(filters.to)) params.set('to', filters.to);
  const q = searchTerm(filters.q);
  if (q !== '') params.set('q', q);
  if (filters.attention) params.set('attention', 'true');
  if (cursor !== undefined && cursor !== null && cursor !== '') params.set('cursor', cursor);
  return params.toString();
}

// ───────────────────────────── La respuesta ─────────────────────────────

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function text(value: unknown, max = 300): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t === '' ? undefined : t.slice(0, max);
}

function textOrNull(value: unknown, max = 300): string | null {
  return text(value, max) ?? null;
}

function isoInstant(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** Una lista en la que cada elemento roto se descarta; lo que no es lista, una lista vacía. */
function list<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === undefined ? [] : [parsed];
  });
}

/** Por qué una reserva necesita a una persona, desde cuándo. */
export interface OrderAttentionView {
  readonly reason: OrderAttentionReason;
  /** ISO 8601. */
  readonly since: string;
}

function parseAttention(value: unknown): OrderAttentionView | undefined {
  const r = asRecord(value);
  const reason = r?.['reason'];
  const since = isoInstant(r?.['since']);
  if (!isOrderAttentionReason(reason) || since === undefined) return undefined;
  return { reason, since };
}

/** Una fila de la lista. Sin pasajeros ni contacto: el correo es el del vendedor. */
export interface PlatformOrderRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly provider: string;
  readonly vertical: OrderVertical;
  /** PNR o localizador del proveedor. */
  readonly providerOrderId: string | null;
  /** La referencia que generamos y mandamos al proveedor. */
  readonly providerBookingRef: string | null;
  readonly orderNumber: number;
  readonly status: OrderStatus;
  /** El subestado de una reserva de hotel. */
  readonly subStatus: string | null;
  readonly totalAmountMinor: number;
  readonly currency: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly sellerEmail: string | null;
  /** El motivo más grave por el que necesita a una persona, o `null`. */
  readonly attention: OrderAttentionView | null;
}

export interface PlatformOrdersPage {
  readonly orders: readonly PlatformOrderRow[];
  readonly nextCursor: string | null;
}

const SUB_STATUS = /^[a-z][a-z-]{0,39}$/;

export function parsePlatformOrderRow(value: unknown): PlatformOrderRow | undefined {
  const r = asRecord(value);
  const id = r?.['id'];
  const tenantId = r?.['tenantId'];
  const tenantName = text(r?.['tenantName'], 200);
  const provider = r?.['provider'];
  const vertical = r?.['vertical'];
  const orderNumber = safeInteger(r?.['orderNumber']);
  const status = r?.['status'];
  const total = safeInteger(r?.['totalAmountMinor']);
  const currency = r?.['currency'];
  const createdAt = isoInstant(r?.['createdAt']);
  if (
    !isUuid(id) ||
    !isUuid(tenantId) ||
    tenantName === undefined ||
    typeof provider !== 'string' ||
    provider.trim() === '' ||
    !isOrderVertical(vertical) ||
    orderNumber === undefined ||
    !isOrderStatus(status) ||
    total === undefined ||
    !isCurrencyCode(currency) ||
    createdAt === undefined
  ) {
    return undefined;
  }
  const subStatus = r?.['subStatus'];
  const attention = r?.['attention'];
  return {
    id: id.toLowerCase(),
    tenantId: tenantId.toLowerCase(),
    tenantName,
    tenantType: text(r?.['tenantType'], 40) ?? '',
    isBranch: r?.['isBranch'] === true,
    provider: provider.trim(),
    vertical,
    providerOrderId: textOrNull(r?.['providerOrderId'], 64),
    providerBookingRef: textOrNull(r?.['providerBookingRef'], 64),
    orderNumber,
    status,
    subStatus: typeof subStatus === 'string' && SUB_STATUS.test(subStatus) ? subStatus : null,
    totalAmountMinor: total,
    currency,
    createdAt,
    sellerEmail: textOrNull(r?.['sellerEmail'], 254),
    attention: attention === null ? null : (parseAttention(attention) ?? null),
  };
}

/** Una página de la lista. Una fila rota se descarta; la respuesta rota, entera. */
export function parsePlatformOrdersPage(value: unknown): PlatformOrdersPage | undefined {
  const r = asRecord(value);
  const orders = r?.['orders'];
  const nextCursor = r?.['nextCursor'];
  if (!Array.isArray(orders)) return undefined;
  if (nextCursor !== null && typeof nextCursor !== 'string') return undefined;
  return {
    orders: list(orders, parsePlatformOrderRow),
    nextCursor: nextCursor === null || nextCursor === '' ? null : nextCursor,
  };
}

/**
 * Agrega una página sin repetir: si entre página y página entró una reserva nueva, el cursor no la
 * repite, pero una fila que cambió de estado podría volver.
 */
export function appendOrders(
  current: readonly PlatformOrderRow[],
  next: readonly PlatformOrderRow[],
): PlatformOrderRow[] {
  const seen = new Set(current.map((o) => o.id));
  return [...current, ...next.filter((o) => !seen.has(o.id))];
}

// ───────────────────────────── La ficha ─────────────────────────────

export interface OrderPassengerView {
  readonly givenName: string;
  readonly surname: string;
  readonly paxType: string | null;
  /** La habitación (base cero) de un huésped de hotel. */
  readonly room: number | null;
}

/** Una operación del historial, en la forma que lee OrderOperationsHistory. */
export interface OrderOperationRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly retryable: boolean;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'UNVERIFIED' | null;
  readonly reconciliationRequired: boolean;
}

export type WalletHoldStatus = 'held' | 'captured' | 'released' | 'conflict' | 'exempt';
export type WalletHoldMode = 'off' | 'observe' | 'enforce' | 'legacy';

export interface OrderWalletHoldView {
  readonly status: WalletHoldStatus;
  readonly mode: WalletHoldMode | null;
  readonly currency: string;
  readonly saleAmountMinor: number;
  readonly createdAt: string;
  readonly capturedAt: string | null;
  readonly closedAt: string | null;
}

export interface OrderReconciliationView {
  readonly kind: string;
  readonly severity: Severity;
  readonly action: string;
  readonly createdAt: string;
}

export interface OrderEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly actorEmail: string | null;
}

export interface PlatformOrderDetail {
  readonly order: {
    readonly id: string;
    readonly tenantId: string;
    readonly provider: string;
    readonly pnr: string | null;
    readonly providerBookingRef: string | null;
    readonly status: OrderStatus;
    readonly orderNumber: number;
    readonly totalAmount: number;
    readonly currency: string;
    readonly errorMessage: string | null;
    readonly searchCriteria: unknown;
    /** El seguimiento del hotel tal cual: lo lee hotel-order-view (parseHotelTracking). */
    readonly providerTracking: unknown;
    readonly passengers: readonly OrderPassengerView[];
    readonly contact: { readonly email: string | null; readonly phone: string | null };
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly tenantType: string;
    readonly isBranch: boolean;
    readonly status: string;
    /** De la raíz de la red hasta el nodo de la reserva (él incluido). */
    readonly path: readonly { readonly id: string; readonly name: string }[];
  };
  readonly seller: { readonly email: string; readonly name: string | null } | null;
  readonly operations: readonly OrderOperationRow[];
  readonly walletHold: OrderWalletHoldView | null;
  readonly reconciliation: readonly OrderReconciliationView[];
  /** Todos los motivos, del más grave al menos grave. */
  readonly attention: readonly OrderAttentionView[];
  /** Los últimos eventos, del más nuevo al más viejo. */
  readonly events: readonly OrderEventView[];
}

function parsePassenger(value: unknown): OrderPassengerView | undefined {
  const r = asRecord(value);
  const givenName = typeof r?.['givenName'] === 'string' ? r['givenName'].trim() : '';
  const surname = typeof r?.['surname'] === 'string' ? r['surname'].trim() : '';
  if (givenName === '' && surname === '') return undefined;
  const room = r?.['room'];
  return {
    givenName: givenName.slice(0, 100),
    surname: surname.slice(0, 100),
    paxType: textOrNull(r?.['paxType'], 20),
    room: typeof room === 'number' && Number.isInteger(room) && room >= 0 ? room : null,
  };
}

const OUTCOMES = new Set(['SUCCEEDED', 'FAILED', 'UNVERIFIED']);

function parseOperation(value: unknown): OrderOperationRow | undefined {
  const r = asRecord(value);
  const id = text(r?.['id'], 64);
  const type = text(r?.['type'], 40);
  const status = text(r?.['status'], 40);
  const createdAt = isoInstant(r?.['created_at']);
  if (id === undefined || type === undefined || status === undefined || createdAt === undefined) {
    return undefined;
  }
  const outcome = r?.['outcome'];
  return {
    id,
    type,
    status,
    attempts: safeInteger(r?.['attempts']) ?? 0,
    last_error: textOrNull(r?.['last_error'], 1_000),
    created_at: createdAt,
    retryable: r?.['retryable'] === true,
    outcome:
      typeof outcome === 'string' && OUTCOMES.has(outcome)
        ? (outcome as OrderOperationRow['outcome'])
        : null,
    reconciliationRequired: r?.['reconciliationRequired'] === true,
  };
}

const HOLD_STATUSES = new Set<WalletHoldStatus>([
  'held',
  'captured',
  'released',
  'conflict',
  'exempt',
]);
const HOLD_MODES = new Set<WalletHoldMode>(['off', 'observe', 'enforce', 'legacy']);

function parseWalletHold(value: unknown): OrderWalletHoldView | null {
  const r = asRecord(value);
  const status = r?.['status'];
  const mode = r?.['mode'];
  const currency = r?.['currency'];
  const amount = safeInteger(r?.['saleAmountMinor']);
  const createdAt = isoInstant(r?.['createdAt']);
  if (
    typeof status !== 'string' ||
    !HOLD_STATUSES.has(status as WalletHoldStatus) ||
    !isCurrencyCode(currency) ||
    amount === undefined ||
    createdAt === undefined
  ) {
    return null;
  }
  return {
    status: status as WalletHoldStatus,
    mode:
      typeof mode === 'string' && HOLD_MODES.has(mode as WalletHoldMode)
        ? (mode as WalletHoldMode)
        : null,
    currency,
    saleAmountMinor: amount,
    createdAt,
    capturedAt: isoInstant(r?.['capturedAt']) ?? null,
    closedAt: isoInstant(r?.['closedAt']) ?? null,
  };
}

const SEVERITIES = new Set<Severity>(['critical', 'warning', 'info']);

function parseReconciliation(value: unknown): OrderReconciliationView | undefined {
  const r = asRecord(value);
  const kind = text(r?.['kind'], 10);
  const severity = r?.['severity'];
  const action = text(r?.['action'], 40);
  const createdAt = isoInstant(r?.['createdAt']);
  if (
    kind === undefined ||
    typeof severity !== 'string' ||
    !SEVERITIES.has(severity as Severity) ||
    action === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }
  return { kind, severity: severity as Severity, action, createdAt };
}

function parseEvent(value: unknown): OrderEventView | undefined {
  const r = asRecord(value);
  const id = text(r?.['id'], 64);
  const occurredAt = isoInstant(r?.['occurredAt']);
  const eventType = text(r?.['eventType'], 80);
  if (id === undefined || occurredAt === undefined || eventType === undefined) return undefined;
  return { id, occurredAt, eventType, actorEmail: textOrNull(r?.['actorEmail'], 254) };
}

function parseContact(value: unknown): PlatformOrderDetail['order']['contact'] {
  const r = asRecord(value);
  return { email: textOrNull(r?.['email'], 254), phone: textOrNull(r?.['phone'], 60) };
}

function parsePathNode(value: unknown): { id: string; name: string } | undefined {
  const r = asRecord(value);
  const id = r?.['id'];
  const name = text(r?.['name'], 200);
  return isUuid(id) && name !== undefined ? { id: id.toLowerCase(), name } : undefined;
}

/**
 * La ficha. Sin la orden o sin su nodo no hay ficha que mostrar; lo demás (historial, cartera,
 * conciliación, actividad) se lee por partes y lo roto se descarta.
 */
export function parsePlatformOrderDetail(value: unknown): PlatformOrderDetail | undefined {
  const r = asRecord(value);
  const o = asRecord(r?.['order']);
  const t = asRecord(r?.['tenant']);
  const id = o?.['id'];
  const tenantId = o?.['tenantId'];
  const provider = text(o?.['provider'], 60);
  const status = o?.['status'];
  const orderNumber = safeInteger(o?.['orderNumber']);
  const totalAmount = safeInteger(o?.['totalAmount']);
  const currency = o?.['currency'];
  const createdAt = isoInstant(o?.['createdAt']);
  const nodeId = t?.['id'];
  const nodeName = text(t?.['name'], 200);
  if (
    !isUuid(id) ||
    !isUuid(tenantId) ||
    provider === undefined ||
    !isOrderStatus(status) ||
    orderNumber === undefined ||
    totalAmount === undefined ||
    !isCurrencyCode(currency) ||
    createdAt === undefined ||
    !isUuid(nodeId) ||
    nodeName === undefined
  ) {
    return undefined;
  }
  const seller = asRecord(r?.['seller']);
  const sellerEmail = text(seller?.['email'], 254);
  return {
    order: {
      id: id.toLowerCase(),
      tenantId: tenantId.toLowerCase(),
      provider,
      pnr: textOrNull(o?.['pnr'], 64),
      providerBookingRef: textOrNull(o?.['providerBookingRef'], 64),
      status,
      orderNumber,
      totalAmount,
      currency,
      errorMessage: textOrNull(o?.['errorMessage'], 1_000),
      searchCriteria: o?.['searchCriteria'] ?? null,
      providerTracking: o?.['providerTracking'] ?? r?.['providerTracking'] ?? null,
      passengers: list(o?.['passengers'], parsePassenger),
      contact: parseContact(o?.['contactInfo']),
      createdAt,
      updatedAt: isoInstant(o?.['updatedAt']) ?? createdAt,
    },
    tenant: {
      id: nodeId.toLowerCase(),
      name: nodeName,
      tenantType: text(t?.['tenantType'], 40) ?? '',
      isBranch: t?.['isBranch'] === true,
      status: text(t?.['status'], 40) ?? 'active',
      path: list(t?.['path'], parsePathNode),
    },
    seller:
      sellerEmail === undefined
        ? null
        : { email: sellerEmail, name: textOrNull(seller?.['name'], 200) },
    operations: list(r?.['operations'], parseOperation),
    walletHold: parseWalletHold(r?.['walletHold']),
    reconciliation: list(r?.['reconciliation'], parseReconciliation),
    attention: list(r?.['attention'], parseAttention),
    events: list(r?.['events'], parseEvent),
  };
}

// ───────────────────────────── Textos ─────────────────────────────

export const ORDER_STATUS_VIEW: Readonly<Record<OrderStatus, { label: string; tone: Tone }>> = {
  pending: { label: 'Pendiente', tone: 'warning' },
  confirmed: { label: 'Confirmada', tone: 'success' },
  ticketed: { label: 'Emitida', tone: 'success' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
  failed: { label: 'Fallida', tone: 'danger' },
};

/** Los chips de arriba: lo que espera a una persona y cada estado. */
export const STATUS_CHIPS: readonly { readonly value: OrderStatus; readonly label: string }[] = [
  { value: 'pending', label: 'Pendientes' },
  { value: 'confirmed', label: 'Confirmadas' },
  { value: 'ticketed', label: 'Emitidas' },
  { value: 'cancelled', label: 'Canceladas' },
  { value: 'failed', label: 'Fallidas' },
];

export const ATTENTION_CHIP_LABEL = 'Requieren atención';

export const VERTICAL_OPTIONS: readonly {
  readonly value: OrderVertical;
  readonly label: string;
}[] = [
  { value: 'flights', label: 'Vuelos' },
  { value: 'hotels', label: 'Hoteles' },
  { value: 'cars', label: 'Autos' },
];

/** Los proveedores con ficha (lib/provider-display), y el filtrado aunque no la tenga. */
export function providerOptions(
  selected: string | null,
): { readonly value: string; readonly label: string }[] {
  const codes = Object.keys(PROVIDER_METADATA);
  if (selected !== null && !codes.includes(selected)) codes.push(selected);
  return codes
    .map((code) => ({ value: code, label: providerMetaFor(code).name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
}

export interface NodeOption {
  readonly id: string;
  /** Con sangría por nivel y su tipo: "  Agencia Sur · Sucursal". */
  readonly label: string;
}

/** Sangría de un `<option>`: los espacios comunes se colapsan, los de no separación no. */
const INDENT = '   ';

/**
 * Los nodos de la red en el orden del árbol (cada uno seguido de sus hijos), con sangría por nivel:
 * así se lee de quién cuelga cada agencia sin abrir Agencias.
 */
export function nodeOptions(nodes: readonly NetworkNode[]): NodeOption[] {
  return flattenForest(buildForest(nodes)).map(({ node, level }) => ({
    id: node.id.toLowerCase(),
    label: `${INDENT.repeat(level)}${node.name} · ${nodeKindLabel(node)}`,
  }));
}

const DATE_TIME = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: PLATFORM_TIME_ZONE,
});

/** "13 oct 2026, 11:48", en hora de Bogotá como los filtros de fechas. */
export function formatOrderDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return DATE_TIME.format(date).replace(/\./g, '');
}

/** El motivo y desde cuándo ("ayer", "hace 3 horas"; vacío si la fecha no se lee). */
export function attentionParts(
  attention: OrderAttentionView,
  now: number,
): { readonly label: string; readonly since: string } {
  return {
    label: ATTENTION_REASON_LABEL[attention.reason],
    since: sinceLabel(attention.since, now),
  };
}

/** "Cancelación fallida · desde ayer". */
export function attentionText(attention: OrderAttentionView, now: number): string {
  const { label, since } = attentionParts(attention, now);
  return since === '' ? label : `${label} · desde ${since}`;
}

const PAX_TYPE_LABEL: Readonly<Record<string, string>> = {
  ADT: 'Adulto',
  CHD: 'Niño',
  INF: 'Infante',
  DRIVER: 'Conductor',
};

/** "Ana Pérez · Adulto · Habitación 1". */
export function passengerLine(p: OrderPassengerView): string {
  const name = `${p.givenName} ${p.surname}`.trim();
  const type = p.paxType === null ? undefined : (PAX_TYPE_LABEL[p.paxType] ?? p.paxType);
  return [name, type, p.room === null ? undefined : `Habitación ${p.room + 1}`]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
}

export const WALLET_HOLD_VIEW: Readonly<Record<WalletHoldStatus, { label: string; tone: Tone }>> = {
  held: { label: 'Retenida', tone: 'warning' },
  captured: { label: 'Cobrada', tone: 'neutral' },
  released: { label: 'Liberada', tone: 'success' },
  conflict: { label: 'En conflicto', tone: 'danger' },
  exempt: { label: 'Exenta', tone: 'neutral' },
};

/**
 * Lo que no se ve en el estado: hasta dónde subió la retención por la red (wallet_hold_policy,
 * 0060). En los tres casos el nodo que vende SÍ retuvo en su cartera; lo que cambia es la cascada
 * hacia los nodos que lo financian.
 */
export const WALLET_HOLD_MODE_HINT: Readonly<Record<WalletHoldMode, string | null>> = {
  enforce: null,
  observe:
    'Red en observación: retuvo el nodo que vende; los nodos de arriba sólo se evaluaron, sin bloquear su saldo.',
  off: 'Retención en la red apagada: retuvo sólo el nodo que vende.',
  legacy: 'Retención anterior a la retención en cadena: sólo en el nodo que vende.',
};

/**
 * La aclaración bajo el estado de la retención. Una exenta no retuvo en ninguna cartera, con
 * cualquier modo: se reservó con la cuenta propia del nodo y nadie de la red queda expuesto.
 */
export function walletHoldHint(hold: Pick<OrderWalletHoldView, 'status' | 'mode'>): string | null {
  if (hold.status === 'exempt') {
    return 'No retuvo ninguna cartera: se reservó con la cuenta propia del nodo con el proveedor.';
  }
  return hold.mode === null ? null : WALLET_HOLD_MODE_HINT[hold.mode];
}

/** Las divergencias de la conciliación (docs/tbo/04 §9.4). */
const RECONCILIATION_KIND_LABEL: Readonly<Record<string, string>> = {
  R1: 'Recuperada por la conciliación',
  R2: 'Reserva del proveedor sin orden',
  R3: 'Cancelada fuera de la plataforma',
  R4: 'Cancelada aquí y activa en el proveedor',
  R5: 'El proveedor no tiene la reserva',
  R6: 'Precio o moneda distintos',
  R7: 'Estado que no reconocemos',
  R8: 'Cancelación atascada',
};

const RECONCILIATION_ACTION_LABEL: Readonly<Record<string, string>> = {
  recovered: 'Se recuperó la reserva',
  cancelled: 'Se marcó cancelada',
  'cancellation-verifying': 'Verificando la cancelación',
  failed: 'Se marcó fallida',
  reported: 'Informada',
  recorded: 'Registrada',
  review: 'Para revisar',
};

export function reconciliationKindLabel(kind: string): string {
  return RECONCILIATION_KIND_LABEL[kind] ?? kind;
}

export function reconciliationActionLabel(action: string): string {
  return RECONCILIATION_ACTION_LABEL[action] ?? action;
}

export const RECONCILIATION_SEVERITY_VIEW: Readonly<
  Record<Severity, { label: string; tone: Tone }>
> = {
  critical: { label: SEVERITY_LABEL.critical, tone: 'danger' },
  warning: { label: SEVERITY_LABEL.warning, tone: 'warning' },
  info: { label: SEVERITY_LABEL.info, tone: 'neutral' },
};

/**
 * Los eventos más comunes de una reserva, con un nombre corto. Uno que no está sale por su código:
 * al menos es diagnosticable.
 */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  OrderCreateRequested: 'Se pidió la reserva al proveedor',
  OrderCreated: 'Respondió el proveedor',
  OrderCreateFailed: 'Falló el pedido al proveedor',
  OrderCreationVerified: 'Reserva verificada con el proveedor',
  OrderCompensationScheduled: 'Se programó una compensación',
  OrderEscalated: 'Pasó a revisión de una persona',
  OrderCancellationAttempted: 'Se intentó cancelar',
  OrderProviderStatusChanged: 'Cambió el estado en el proveedor',
  OrderReconciliationDiscrepancy: 'Diferencia en la conciliación',
  HotelConfirmationNumberReceived: 'Llegó la confirmación del hotel (HCN)',
  HotelConfirmationNumberMissing: 'Sin confirmación del hotel (HCN)',
  HotelOfferRepriced: 'El proveedor cambió el precio',
  HotelNonRefundableAcknowledged: 'Se aceptó la tarifa no reembolsable',
  CarReservationCreated: 'Reserva de auto creada',
};

export function eventLabel(eventType: string): string {
  return EVENT_LABEL[eventType] ?? eventType;
}

/** Estados del proveedor (de hoteles) que dicen que la reserva sigue en pie o ya no. */
const PROVIDER_ACTIVE = new Set(['Confirmed', 'Vouchered']);
const PROVIDER_CANCELLED = new Set(['Cancelled', 'CancelledAndRefundAwaited']);

function providerStatusOf(tracking: unknown): string | null {
  const status = asRecord(tracking)?.['providerStatus'];
  return typeof status === 'string' ? status : null;
}

/**
 * ¿La plataforma y el proveedor dicen cosas que no cierran? Es lo primero que hay que ver: una
 * cancelada aquí que sigue activa en el proveedor puede estar cobrando. `null` si cuadran o si no hay
 * lectura del proveedor con la que comparar.
 */
export function statusMismatch(
  order: Pick<PlatformOrderDetail['order'], 'status' | 'providerTracking'>,
): string | null {
  const provider = providerStatusOf(order.providerTracking);
  if (provider === null) return null;
  if (order.status === 'cancelled' && PROVIDER_ACTIVE.has(provider)) {
    return 'Aquí figura cancelada, pero el proveedor la tiene activa.';
  }
  if (
    (order.status === 'confirmed' || order.status === 'ticketed') &&
    PROVIDER_CANCELLED.has(provider)
  ) {
    return 'Aquí figura confirmada, pero el proveedor la tiene cancelada.';
  }
  if (order.status === 'failed' && PROVIDER_ACTIVE.has(provider)) {
    return 'Aquí figura fallida, pero el proveedor la tiene activa.';
  }
  if (provider === 'unknown') return 'El proveedor informó un estado que no reconocemos.';
  return null;
}

/** "#1042 · Agencia Sur": el título de la ficha. */
export function orderSheetTitle(orderNumber: number | null, tenantName: string | null): string {
  if (orderNumber === null) return 'Reserva';
  return tenantName === null
    ? `Reserva #${orderNumber}`
    : `Reserva #${orderNumber} · ${tenantName}`;
}

/** El mensaje de un pedido a la lista o a la ficha que falló. */
export function ordersErrorMessage(
  status: number,
  apiMessage: string | undefined,
  kind: 'list' | 'detail',
): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'Sólo el superadmin de la plataforma ve las reservas de toda la red.';
  const fromApi = apiMessage?.trim() ?? '';
  if (status === 404) {
    if (kind === 'detail') return 'Esa reserva no existe o ya no está disponible.';
    return fromApi !== '' ? fromApi : 'Ese nodo no existe: busca en toda la red.';
  }
  if (status === 400) {
    return fromApi !== '' ? fromApi : 'Revisa los filtros: alguno no es válido.';
  }
  if (status === 0) {
    return 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
  }
  return kind === 'detail'
    ? 'No pudimos abrir la reserva. Reintenta en unos segundos.'
    : 'No pudimos cargar las reservas. Reintenta en unos segundos.';
}

export interface EmptyCopy {
  readonly title: string;
  readonly text: string;
}

export function emptyCopy(filters: OrdersFilters): EmptyCopy {
  const searching = searchTerm(filters.q) !== '';
  if (filters.attention && activeFilterCount(filters) === 1 && !searching) {
    return {
      title: 'No hay reservas que requieran atención.',
      text: 'Ninguna reserva de la red espera a una persona en este momento.',
    };
  }
  return {
    title: 'No hay reservas con estos filtros.',
    text: searching
      ? 'Prueba con el PNR completo, el n.º de orden o el correo exacto del cliente.'
      : 'Prueba con otras fechas, otro estado u otro nodo.',
  };
}
