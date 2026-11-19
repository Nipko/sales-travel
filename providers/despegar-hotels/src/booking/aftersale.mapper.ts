import { Money } from '@sales-travel/canonical';
import { num } from '../internal/coerce';
import type {
  AftersaleReservation,
  AftersaleRoom,
  AftersaleStatus,
  BookStatus,
  CancelAllowance,
  CancelAllowanceValue,
  CancelQuote,
  CancelQuoteRefund,
  CommissionUpdateRequest,
  CommissionUpdateResult,
  PriceJumpInfo,
  ReservationsQuery,
  SpecialRequestCatalogItem,
  SpecialRequestResult,
} from './types';

type Query = Record<string, string | number | boolean | undefined>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string'
    ? v === ''
      ? undefined
      : v
    : typeof v === 'number'
      ? String(v)
      : undefined;

// ───────────────────────── /reservations ─────────────────────────

export function buildReservationsQuery(q: ReservationsQuery): Query {
  const byDate = q.fromPurchaseDate !== undefined || q.toPurchaseDate !== undefined;
  return {
    reservation_id: q.reservationId,
    product_id: q.productId,
    external_transaction_id: q.externalTransactionId,
    flow_id: q.flowId,
    // "Only to be used with the corresponding product_id": suelto (por fecha o por reserva)
    // Despegar responde 400. Sin él, quien llama filtra el tipo en la respuesta.
    product_type: q.productId === undefined ? undefined : q.productType,
    by_api_key: byDate ? true : undefined,
    from_purchase_date: q.fromPurchaseDate,
    to_purchase_date: q.toPurchaseDate,
    limit: q.limit,
    page: q.page,
  };
}

interface RawAftersaleRoom {
  code?: string;
  meal_plan_code?: string;
  meal_plan_description?: string;
  description?: string;
  bed_type_description?: string;
  holder_first_name?: string;
  holder_last_name?: string;
  adults?: number;
  minor_ages?: number[];
}

interface RawAftersaleProduct {
  product_id?: string | number;
  product_type?: string;
  transaction_id?: string | number;
  status?: string;
  purchase_date_time?: string;
  pnr?: string | number;
  external_reservation_id?: string | number;
  reservation_id?: string | number;
  sale_price?: { currency?: string; price?: number | string };
  check_in_date_time?: string;
  check_out_date_time?: string;
  hotel_id?: string | number;
  hotel_name?: string;
  rooms?: RawAftersaleRoom[];
}

interface RawReservationItem {
  id?: string | number;
  product?: RawAftersaleProduct;
  download_voucher_url?: string;
}

interface RawReservationsResponse {
  items?: RawReservationItem[];
}

const AFTERSALE_STATUSES: ReadonlySet<string> = new Set([
  'IN_PROCESS',
  'ISSUED',
  'CANCELLED',
  'DELETED',
]);

function mapAftersaleStatus(s: string | undefined): AftersaleStatus {
  return s !== undefined && AFTERSALE_STATUSES.has(s) ? (s as AftersaleStatus) : 'UNKNOWN';
}

function mapAftersaleRoom(r: RawAftersaleRoom): AftersaleRoom {
  const room: AftersaleRoom = { minorAges: Array.isArray(r.minor_ages) ? [...r.minor_ages] : [] };
  if (r.code) room.code = r.code;
  if (r.meal_plan_code) room.mealPlanCode = r.meal_plan_code;
  if (r.meal_plan_description) room.mealPlanDescription = r.meal_plan_description;
  if (r.description) room.description = r.description;
  if (r.bed_type_description) room.bedTypeDescription = r.bed_type_description;
  if (r.holder_first_name) room.holderFirstName = r.holder_first_name;
  if (r.holder_last_name) room.holderLastName = r.holder_last_name;
  if (typeof r.adults === 'number') room.adults = r.adults;
  return room;
}

function mapReservationItem(it: RawReservationItem): AftersaleReservation | undefined {
  const p = it.product;
  const productId = str(p?.product_id);
  if (p === undefined || productId === undefined) return undefined;
  const out: AftersaleReservation = {
    id: str(it.id) ?? productId,
    productId,
    productType: p.product_type ?? '',
    status: mapAftersaleStatus(p.status),
    rawStatus: p.status ?? '',
    rooms: (p.rooms ?? []).map(mapAftersaleRoom),
  };
  const set = <K extends keyof AftersaleReservation>(
    k: K,
    v: AftersaleReservation[K] | undefined,
  ) => {
    if (v !== undefined) out[k] = v;
  };
  set('transactionId', str(p.transaction_id));
  set('reservationId', str(p.reservation_id));
  set('externalReservationId', str(p.external_reservation_id));
  set('pnr', str(p.pnr));
  set('purchaseDateTime', str(p.purchase_date_time));
  set('checkIn', str(p.check_in_date_time));
  set('checkOut', str(p.check_out_date_time));
  set('hotelId', str(p.hotel_id));
  set('hotelName', str(p.hotel_name));
  set('downloadVoucherUrl', str(it.download_voucher_url));
  if (p.sale_price?.price != null && p.sale_price.currency) {
    out.salePrice = Money.fromMajor(num(p.sale_price.price), p.sale_price.currency);
  }
  return out;
}

export function mapReservations(raw: RawReservationsResponse): AftersaleReservation[] {
  return (raw.items ?? [])
    .map(mapReservationItem)
    .filter((r): r is AftersaleReservation => r !== undefined);
}

// ───────────────────────── Cancelación ─────────────────────────

interface RawProductAllowance {
  product_type?: string;
  product_id?: string | number;
  allowance?: string;
  disallowed_reason?: string;
  refund_policy?: string;
  policy?: string;
  expiration_date_time?: string;
}

interface RawAllowanceResponse {
  product_allowance?: RawProductAllowance;
}

function mapAllowanceValue(v: string | undefined): CancelAllowanceValue {
  return v === 'ALLOWED' || v === 'DISALLOWED' ? v : 'UNKNOWN';
}

function mapProductAllowance(
  a: RawProductAllowance | undefined,
  fallbackProductId: string,
): CancelAllowance {
  const out: CancelAllowance = {
    productId: str(a?.product_id) ?? fallbackProductId,
    allowance: mapAllowanceValue(a?.allowance),
  };
  if (a?.product_type) out.productType = a.product_type;
  if (a?.disallowed_reason) out.disallowedReason = a.disallowed_reason;
  if (a?.refund_policy) out.refundPolicy = a.refund_policy;
  if (a?.policy) out.policy = a.policy;
  if (a?.expiration_date_time) out.expiresAt = a.expiration_date_time;
  return out;
}

export function mapCancelAllowance(raw: RawAllowanceResponse, productId: string): CancelAllowance {
  return mapProductAllowance(raw.product_allowance, productId);
}

export function buildCancelQuoteBody(transactionId: string): Record<string, unknown> {
  return { transaction_id: transactionId, quote_type: 'BY_POLICIES' };
}

interface RawRefundPriceBox {
  payment_amount?: number | string;
  applied_penalty?: number | string;
  refund_amount?: number | string;
}

interface RawProductQuote {
  quote_id?: string | number;
  status?: string;
  refund_policy?: string;
  resolution?: string;
  guaranteed?: boolean;
  product_data?: { currency?: string; product_id?: string | number };
  price_box?: { refunds?: { refund_method_price_box?: RawRefundPriceBox }[] };
}

interface RawQuoteResponse {
  allowance_info?: {
    product_allowance?: RawProductAllowance;
    quote?: { product_quote?: RawProductQuote };
  };
}

function money(v: number | string | undefined, currency: string | undefined): Money | undefined {
  return v === undefined || v === null || currency === undefined
    ? undefined
    : Money.fromMajor(num(v), currency);
}

export function mapCancelQuote(raw: RawQuoteResponse, productId: string): CancelQuote {
  const info = raw.allowance_info;
  const q = info?.quote?.product_quote;
  const currency = q?.product_data?.currency;
  const out: CancelQuote = {
    refunds: (q?.price_box?.refunds ?? []).map((r): CancelQuoteRefund => {
      const box = r.refund_method_price_box;
      const refund: CancelQuoteRefund = {};
      const payment = money(box?.payment_amount, currency);
      const penalty = money(box?.applied_penalty, currency);
      const amount = money(box?.refund_amount, currency);
      if (payment) refund.paymentAmount = payment;
      if (penalty) refund.appliedPenalty = penalty;
      if (amount) refund.refundAmount = amount;
      return refund;
    }),
  };
  if (q?.quote_id != null) out.quoteId = String(q.quote_id);
  if (q?.status) out.status = q.status;
  if (q?.refund_policy) out.refundPolicy = q.refund_policy;
  if (q?.resolution) out.resolution = q.resolution;
  if (typeof q?.guaranteed === 'boolean') out.guaranteed = q.guaranteed;
  if (currency) out.currency = currency;
  if (info?.product_allowance)
    out.allowance = mapProductAllowance(info.product_allowance, productId);
  return out;
}

// ───────────────────────── Comisión ─────────────────────────

export function buildCommissionUpdateBody(req: CommissionUpdateRequest): Record<string, unknown> {
  return { prebook_id: req.prebookId, commission: req.commission };
}

interface RawCommissionResponse {
  commission?: {
    amount?: number | string;
    min_amount?: number | string;
    max_amount?: number | string;
  };
  total?: number | string;
  currency?: string;
}

export function mapCommissionUpdate(raw: RawCommissionResponse): CommissionUpdateResult {
  const currency = raw.currency ?? 'USD';
  const c = raw.commission;
  const out: CommissionUpdateResult = {
    commission: { amount: Money.fromMajor(num(c?.amount), currency) },
    total: Money.fromMajor(num(raw.total), currency),
  };
  if (c?.min_amount != null)
    out.commission.minAmount = Money.fromMajor(num(c.min_amount), currency);
  if (c?.max_amount != null)
    out.commission.maxAmount = Money.fromMajor(num(c.max_amount), currency);
  return out;
}

// ───────────────────────── Pedidos especiales ─────────────────────────

interface RawSpecialCatalog {
  items?: { code?: string; description?: string; requires_value?: boolean }[];
}

export function mapSpecialRequestCatalog(raw: RawSpecialCatalog): SpecialRequestCatalogItem[] {
  return (raw.items ?? [])
    .filter((i) => typeof i.code === 'string' && i.code !== '')
    .map((i) => ({
      code: i.code as string,
      description: i.description ?? (i.code as string),
      requiresValue: i.requires_value === true,
    }));
}

export function mapSpecialRequestResult(raw: {
  flow_id?: string;
  product_id?: string | number;
}): SpecialRequestResult {
  const out: SpecialRequestResult = {};
  if (raw.flow_id) out.flowId = raw.flow_id;
  const productId = str(raw.product_id);
  if (productId) out.productId = productId;
  return out;
}

// ───────────────────────── Recovery (GET) ─────────────────────────

interface RawPriceJump {
  reservation_id?: string | number;
  status?: string;
  sub_status?: string;
  price_jump?: {
    difference?: number | string;
    price_before_price_jump?: number | string;
    price_after_price_jump?: number | string;
    currency?: string;
    timeout?: string;
    message?: {
      message_type?: string;
      price_jump_confirmations?: { flavor_id?: string }[];
    };
  };
  payment_selection?: { timeout?: string };
}

function bookStatus(s: string | undefined): BookStatus {
  return s === 'SUCCESS' || s === 'PROCESSING' || s === 'ERROR' ? s : 'ERROR';
}

export function mapPriceJump(raw: RawPriceJump, reservationId: string): PriceJumpInfo {
  const pj = raw.price_jump;
  const out: PriceJumpInfo = {
    reservationId: str(raw.reservation_id) ?? reservationId,
    status: bookStatus(raw.status),
    flavorIds: (pj?.message?.price_jump_confirmations ?? [])
      .map((c) => c.flavor_id)
      .filter((f): f is string => typeof f === 'string' && f !== ''),
  };
  if (raw.sub_status) out.subStatus = raw.sub_status;
  const difference = money(pj?.difference, pj?.currency);
  const before = money(pj?.price_before_price_jump, pj?.currency);
  const after = money(pj?.price_after_price_jump, pj?.currency);
  if (difference) out.difference = difference;
  if (before) out.priceBefore = before;
  if (after) out.priceAfter = after;
  if (pj?.timeout) out.timeout = pj.timeout;
  if (pj?.message?.message_type) out.messageType = pj.message.message_type;
  if (raw.payment_selection?.timeout) out.paymentSelectionTimeout = raw.payment_selection.timeout;
  return out;
}
