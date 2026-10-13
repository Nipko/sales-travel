import {
  attentionRank,
  isOrderAttentionReason,
  type OrderAttentionReason,
} from '../admin-console/attention.js';
import { redactPayload } from '../audit/redact-payload.js';
import type {
  HotelOrderSubStatus,
  OrderStatus,
  ProviderReconciliationItemsTable,
  TenantType,
  WalletHoldGroupsTable,
} from '../database/database.types.js';
import { encodeAdminOrdersCursor, type AdminOrderVertical } from './admin-orders.schemas.js';
import type { PublicHotelOrderTracking } from './hotel-order-reads.service.js';
import type { OrderOperationRow, OrderRow } from './orders.service.js';

/**
 * Cómo sale una reserva de otro nodo por la consola de la plataforma (Reservas de la red). Sin I/O.
 *
 * El superadmin no vende ni atiende al cliente: necesita reconocer la reserva y ver qué le pasa, no
 * los documentos de los viajeros. La lista no lleva pasajeros ni contacto (admin_search_orders, 0076)
 * y la ficha deja de cada pasajero sólo el nombre y el tipo, y del contacto sólo el correo y el
 * teléfono: nada de documentos ni fechas de nacimiento. Todo lo de acá es lista blanca: un campo que
 * no se nombra no sale.
 */

/** BIGINT y NUMERIC llegan de `pg` como texto. */
type DbNumber = number | string;

// ─────────────────────────────── La lista ───────────────────────────────

/** Una fila de admin_search_orders, con el cursor que le agrega la consulta. */
export interface AdminOrderSearchRow {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_type: TenantType;
  is_branch: boolean;
  provider: string;
  vertical: AdminOrderVertical;
  provider_order_id: string | null;
  provider_booking_ref: string | null;
  order_number: number;
  status: OrderStatus;
  sub_status: HotelOrderSubStatus | null;
  total_amount: DbNumber;
  currency: string;
  created_at: Date;
  updated_at: Date;
  seller_email: string | null;
  attention_reason: string | null;
  attention_since: Date | null;
  /** `created_at` en UTC con microsegundos (ver AdminOrdersCursor). */
  cursor_at: string;
}

/** Por qué una reserva necesita a una persona, desde cuándo. */
export interface AdminOrderAttentionView {
  reason: OrderAttentionReason;
  /** ISO 8601. */
  since: string;
}

export interface AdminOrderListItem {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantType: TenantType;
  isBranch: boolean;
  provider: string;
  vertical: AdminOrderVertical;
  /** PNR o localizador del proveedor. */
  providerOrderId: string | null;
  /** La referencia que generamos y mandamos al proveedor (0042). */
  providerBookingRef: string | null;
  orderNumber: number;
  status: OrderStatus;
  /** El subestado de una reserva de hotel; `null` en las demás o sin seguimiento. */
  subStatus: HotelOrderSubStatus | null;
  totalAmountMinor: number;
  currency: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** El correo de quien la vendió (un usuario de la red, no el cliente). */
  sellerEmail: string | null;
  /** El motivo más grave por el que necesita a una persona, o `null`. */
  attention: AdminOrderAttentionView | null;
}

export interface AdminOrdersPage {
  orders: AdminOrderListItem[];
  /** Para pedir la página siguiente; `null` si no hay más. */
  nextCursor: string | null;
}

/** Un motivo del vocabulario con su momento, o `null` (un motivo que no conocemos no se inventa). */
function attentionOf(reason: string | null, since: Date | null): AdminOrderAttentionView | null {
  if (!isOrderAttentionReason(reason) || since === null) return null;
  return { reason, since: since.toISOString() };
}

export function adminOrderListItem(row: AdminOrderSearchRow): AdminOrderListItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantType: row.tenant_type,
    isBranch: row.is_branch,
    provider: row.provider,
    vertical: row.vertical,
    providerOrderId: row.provider_order_id,
    providerBookingRef: row.provider_booking_ref,
    orderNumber: row.order_number,
    status: row.status,
    subStatus: row.sub_status,
    totalAmountMinor: Number(row.total_amount),
    currency: row.currency,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sellerEmail: row.seller_email,
    attention: attentionOf(row.attention_reason, row.attention_since),
  };
}

/**
 * La página: la base devuelve hasta `limit + 1` filas; la de más sólo dice que hay otra página, y el
 * cursor apunta a la última que se muestra.
 */
export function adminOrdersPage(
  rows: readonly AdminOrderSearchRow[],
  limit: number,
): AdminOrdersPage {
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    orders: visible.map(adminOrderListItem),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeAdminOrdersCursor({ at: last.cursor_at, id: last.id })
        : null,
  };
}

// ─────────────────────────────── La ficha ───────────────────────────────

/** Un pasajero (o huésped, o conductor): sólo el nombre y el tipo. */
export interface AdminPassengerView {
  givenName: string;
  surname: string;
  /** `ADT`, `CHD`, `INF` en vuelos; `DRIVER` en autos; lo que guarde la vertical en las demás. */
  paxType: string | null;
  /** La habitación (base cero) de un huésped de hotel. */
  room?: number;
}

/** El contacto de la reserva: sólo el correo y el teléfono. */
export interface AdminContactView {
  email: string | null;
  /** Con su prefijo de país si lo tiene: `+57 300 1234567`. */
  phone: string | null;
}

/**
 * La orden como la serializa OrdersController (`GET /orders/:id`) sin `capabilities`, con los
 * pasajeros y el contacto recortados y la referencia de reserva que generamos.
 */
export interface AdminOrderView {
  id: string;
  tenantId: string;
  userId: string;
  quotationId: string | null;
  provider: string;
  pnr: string | null;
  providerBookingRef: string | null;
  status: OrderStatus;
  searchCriteria: unknown;
  selectedOffer: unknown;
  passengers: AdminPassengerView[];
  contactInfo: AdminContactView;
  totalAmount: number;
  currency: string;
  orderNumber: number;
  errorMessage: string | null;
  providerTracking: PublicHotelOrderTracking | null;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

/** El nodo de la reserva y su camino desde la raíz de la red (él incluido). */
export interface AdminOrderTenantView {
  id: string;
  name: string;
  slug: string;
  tenantType: TenantType;
  isBranch: boolean;
  status: string;
  path: { id: string; name: string }[];
}

export interface AdminOrderSellerView {
  id: string;
  email: string;
  name: string | null;
}

/** La retención de cartera de la orden (0060), del lado del nodo que vende. */
export interface AdminWalletHoldView {
  status: WalletHoldGroupsTable['status'];
  mode: WalletHoldGroupsTable['mode'];
  currency: string;
  saleAmountMinor: number;
  credentialSource: WalletHoldGroupsTable['credential_source'];
  /** ISO 8601. */
  createdAt: string;
  capturedAt: string | null;
  closedAt: string | null;
}

/** Una divergencia de la conciliación sobre la orden (0047). Sin `details`. */
export interface AdminReconciliationItemView {
  kind: ProviderReconciliationItemsTable['kind'];
  severity: ProviderReconciliationItemsTable['severity'];
  action: ProviderReconciliationItemsTable['action'];
  /** ISO 8601. */
  createdAt: string;
}

/** Un evento de auditoría de la orden, con el payload sin claves sensibles y sin `meta`. */
export interface AdminOrderEventView {
  id: string;
  /** ISO 8601. */
  occurredAt: string;
  eventType: string;
  tenantId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  payload: Record<string, unknown>;
}

/** `GET /admin/orders/:id`. */
export interface AdminOrderDetail {
  order: AdminOrderView;
  tenant: AdminOrderTenantView;
  /** Quien la vendió; `null` si su usuario ya no existe. */
  seller: AdminOrderSellerView | null;
  /** Como `GET /orders/:id/operations`: la misma forma que lee el historial del panel. */
  operations: OrderOperationRow[];
  providerTracking: PublicHotelOrderTracking | null;
  walletHold: AdminWalletHoldView | null;
  /** De la más nueva a la más vieja. */
  reconciliation: AdminReconciliationItemView[];
  /** Todos los motivos, del más grave al menos grave. */
  attention: AdminOrderAttentionView[];
  /** Los últimos eventos, del más nuevo al más viejo. */
  events: AdminOrderEventView[];
}

/** Más pasajeros que esto no tiene ninguna reserva: lo que sobre no sale. */
const MAX_PASSENGERS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Texto recortado, o `null` si no hay. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function person(
  given: unknown,
  surname: unknown,
  paxType: unknown,
  room?: number,
): AdminPassengerView | null {
  const g = text(given, 100);
  const s = text(surname, 100);
  if (g === null && s === null) return null;
  return {
    givenName: g ?? '',
    surname: s ?? '',
    paxType: text(paxType, 20),
    ...(room === undefined ? {} : { room }),
  };
}

/**
 * Los pasajeros de cualquier vertical, con el nombre y el tipo:
 *
 * - vuelos: `[{ givenName, surname, paxType, birthdate, identityDoc, … }]`;
 * - autos: `[{ givenName, surname, paxType: 'DRIVER' }]`;
 * - hoteles: `[{ room, guests: [{ firstName, lastName, paxType, … }] }]`, que sale como una lista de
 *   huéspedes con su habitación.
 *
 * Lo que no tiene esa forma no sale.
 */
export function adminPassengers(raw: unknown): AdminPassengerView[] {
  if (!Array.isArray(raw)) return [];
  const out: AdminPassengerView[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PASSENGERS) break;
    if (!isRecord(item)) continue;
    if (Array.isArray(item['guests'])) {
      const roomValue = item['room'];
      const room =
        typeof roomValue === 'number' && Number.isInteger(roomValue) && roomValue >= 0
          ? roomValue
          : undefined;
      for (const guest of item['guests'] as unknown[]) {
        if (out.length >= MAX_PASSENGERS) break;
        if (!isRecord(guest)) continue;
        const p = person(guest['firstName'], guest['lastName'], guest['paxType'], room);
        if (p !== null) out.push(p);
      }
      continue;
    }
    const p = person(item['givenName'], item['surname'], item['paxType']);
    if (p !== null) out.push(p);
  }
  return out;
}

function dialPrefix(value: unknown): string | null {
  const code = text(value, 6);
  if (code === null) return null;
  return code.startsWith('+') ? code : `+${code}`;
}

function phoneOf(contact: Record<string, unknown>): string | null {
  const phone = contact['phone'];
  const parts = isRecord(phone)
    ? // Hoteles: { countryCode, areaCode?, number }.
      [dialPrefix(phone['countryCode']), text(phone['areaCode'], 10), text(phone['number'], 30)]
    : // Vuelos: phone con countryDialingCode y areaCode aparte.
      [dialPrefix(contact['countryDialingCode']), text(contact['areaCode'], 10), text(phone, 30)];
  if (parts[2] === null) return null;
  return parts.filter((p): p is string => p !== null).join(' ');
}

/** El contacto, sólo con el correo y el teléfono (sin dirección ni nada más). */
export function adminContact(raw: unknown): AdminContactView {
  if (!isRecord(raw)) return { email: null, phone: null };
  return { email: text(raw['email'], 254), phone: phoneOf(raw) };
}

export function adminOrderView(
  row: OrderRow,
  tracking: PublicHotelOrderTracking | null,
): AdminOrderView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    quotationId: row.quotation_id,
    provider: row.provider,
    pnr: row.provider_order_id,
    providerBookingRef: row.provider_booking_ref,
    status: row.status,
    searchCriteria: row.search_criteria,
    selectedOffer: row.selected_offer,
    passengers: adminPassengers(row.passengers),
    contactInfo: adminContact(row.contact_info),
    // BIGINT desde 0023: `pg` lo entrega como texto aunque OrderRow diga number.
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    orderNumber: row.order_number,
    errorMessage: row.error_message,
    providerTracking: tracking,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Una fila de `tenants`, con sus ancestros (de la raíz a él) ya leídos. */
export function adminOrderTenant(
  row: {
    id: string;
    name: string;
    slug: string;
    tenant_type: TenantType;
    is_branch: boolean;
    status: string;
  },
  path: readonly { id: string; name: string }[],
): AdminOrderTenantView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tenantType: row.tenant_type,
    isBranch: row.is_branch,
    status: row.status,
    path: path.map((p) => ({ id: p.id, name: p.name })),
  };
}

/** La retención de la orden como la lee la ficha (`wallet_hold_groups`, 0060). */
export interface WalletHoldRow {
  status: WalletHoldGroupsTable['status'];
  mode: WalletHoldGroupsTable['mode'];
  currency: string;
  sale_amount_minor: DbNumber;
  credential_source: WalletHoldGroupsTable['credential_source'];
  created_at: Date | string;
  captured_at: Date | string | null;
  closed_at: Date | string | null;
}

export function adminWalletHold(row: WalletHoldRow): AdminWalletHoldView {
  return {
    status: row.status,
    mode: row.mode,
    currency: row.currency.trim().toUpperCase(),
    saleAmountMinor: Number(row.sale_amount_minor),
    credentialSource: row.credential_source,
    createdAt: iso(row.created_at),
    capturedAt: isoOrNull(row.captured_at),
    closedAt: isoOrNull(row.closed_at),
  };
}

/** Una divergencia de la orden como la lee la ficha (`provider_reconciliation_items`, 0047). */
export interface ReconciliationItemRow {
  kind: ProviderReconciliationItemsTable['kind'];
  severity: ProviderReconciliationItemsTable['severity'];
  action: ProviderReconciliationItemsTable['action'];
  created_at: Date | string;
}

export function adminReconciliationItem(row: ReconciliationItemRow): AdminReconciliationItemView {
  return {
    kind: row.kind,
    severity: row.severity,
    action: row.action,
    createdAt: iso(row.created_at),
  };
}

/**
 * Los motivos de una orden, del más grave al menos grave (ATTENTION_PRIORITY) y, a igual motivo, del
 * más viejo al más nuevo. Uno que no está en el vocabulario no sale.
 */
export function sortAttention(
  rows: readonly { reason: string; since: Date }[],
): AdminOrderAttentionView[] {
  return rows
    .flatMap((r) =>
      isOrderAttentionReason(r.reason) ? [{ reason: r.reason, since: r.since }] : [],
    )
    .sort(
      (a, b) =>
        attentionRank(a.reason) - attentionRank(b.reason) || a.since.getTime() - b.since.getTime(),
    )
    .map((r) => ({ reason: r.reason, since: r.since.toISOString() }));
}

/** Un evento de `domain_events` como sale en la ficha: el payload sin claves sensibles. */
export function adminOrderEvent(row: {
  id: string;
  occurred_at: Date | string;
  event_type: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  payload: unknown;
}): AdminOrderEventView {
  return {
    id: row.id,
    occurredAt: iso(row.occurred_at),
    eventType: row.event_type,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    payload: redactPayload(row.payload),
  };
}
