import { isOrderAttentionReason, type OrderAttentionReason } from '../admin-console/attention.js';
import { PLATFORM_TIME_ZONE, todayIn } from '../admin-console/admin-overview.schemas.js';
import { csvDecimal, toCsv, type CsvValue } from '../admin-console/csv.js';
import type { OrderStatus } from '../database/database.types.js';
import { MONEY_EXPONENT } from '../portfolios/wallet-currency.js';
import type { AdminOrderSearchRow } from './admin-order-view.js';
import type { AdminOrderVertical, AdminOrdersFilters } from './admin-orders.schemas.js';

/**
 * Plataforma → Reservas de la red › Exportar CSV: cómo sale cada reserva en el archivo. Sin I/O.
 *
 * Es lo que la consola muestra en la lista, para contabilidad o seguimiento: nada de pasajeros ni del
 * contacto del cliente (admin_search_orders, 0076, ni los lee), y el único correo es el de quien la
 * vendió, un usuario de la red. Lista blanca: una columna que no se nombra acá no sale.
 *
 * - Las fechas, en hora de Bogotá (la zona va en el encabezado): `2026-10-13 09:41:12`, que cualquier
 *   planilla lee como fecha y hora.
 * - El total, con punto decimal en unidades de su moneda y la moneda en su columna. Nunca se suman
 *   monedas: no hay fila de totales.
 * - Estado, vertical y motivo de atención con los nombres de la consola; el subestado del hotel, con
 *   su código.
 */

export const ADMIN_ORDERS_EXPORTED_EVENT = 'platform.orders.exported';

export const ADMIN_ORDERS_CSV_HEADER = [
  `fecha (${PLATFORM_TIME_ZONE})`,
  'nodo',
  'sucursal',
  'vertical',
  'proveedor',
  'localizador',
  'referencia',
  'n_orden',
  'estado',
  'subestado',
  'total',
  'moneda',
  'vendedor_email',
  'atencion',
  `atencion_desde (${PLATFORM_TIME_ZONE})`,
] as const;

/** Como los chips de la consola (lib/platform-orders.ts, ORDER_STATUS_VIEW). */
export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  ticketed: 'Emitida',
  cancelled: 'Cancelada',
  failed: 'Fallida',
};

export const ORDER_VERTICAL_LABEL: Readonly<Record<AdminOrderVertical, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
};

/**
 * Los mismos nombres que la consola y el Resumen (apps/web-b2b/src/lib/attention-labels.ts): un test
 * del panel los compara, para que la fila y el archivo no digan cosas distintas de la misma reserva.
 */
export const ATTENTION_REASON_LABEL: Readonly<Record<OrderAttentionReason, string>> = {
  review: 'En revisión con el proveedor',
  'verifying-long': 'Verificación demorada',
  'create-stuck': 'Creación sin respuesta',
  'cancel-failed': 'Cancelación fallida',
  'hold-conflict': 'Retención de cartera en conflicto',
  'hold-orphan': 'Saldo retenido sin reserva',
  'hcn-missing': 'Sin confirmación del hotel (HCN)',
  reconciliation: 'Diferencia en la conciliación',
};

const BOGOTA_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PLATFORM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** El instante en hora de Bogotá, `AAAA-MM-DD HH:MM:SS`; `null` si no es una fecha. */
export function bogotaDateTime(value: Date | string | null): string | null {
  if (value === null) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const parts = BOGOTA_PARTS.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/** Una fila del archivo. `orders.total_amount` va SIEMPRE en centésimos (`Money`), también en COP. */
export function adminOrderCsvRow(row: AdminOrderSearchRow): CsvValue[] {
  const reason = isOrderAttentionReason(row.attention_reason) ? row.attention_reason : null;
  const since = reason === null ? null : bogotaDateTime(row.attention_since);
  return [
    bogotaDateTime(row.created_at),
    row.tenant_name,
    row.is_branch ? 'sí' : 'no',
    ORDER_VERTICAL_LABEL[row.vertical] ?? row.vertical,
    row.provider,
    row.provider_order_id,
    row.provider_booking_ref,
    row.order_number,
    ORDER_STATUS_LABEL[row.status] ?? row.status,
    row.sub_status,
    csvDecimal(row.total_amount, MONEY_EXPONENT),
    row.currency,
    row.seller_email,
    // Un motivo que no conocemos no se inventa, como en la consola.
    reason === null || since === null ? null : ATTENTION_REASON_LABEL[reason],
    since,
  ];
}

/** El archivo: encabezado y una fila por reserva, en el orden de la lista. */
export function adminOrdersCsv(rows: readonly AdminOrderSearchRow[]): string {
  return toCsv(ADMIN_ORDERS_CSV_HEADER, rows.map(adminOrderCsvRow));
}

/** `reservas-2026-10-13.csv`: el día de Bogotá en que se exportó. */
export function ordersExportFilename(now: Date): string {
  return `reservas-${todayIn(PLATFORM_TIME_ZONE, now)}.csv`;
}

/**
 * Los filtros como se aplicaron, para el rastro de la exportación. La búsqueda queda salvo que sea el
 * correo de un cliente: entonces sólo consta que se buscó por correo (el audit log no guarda datos de
 * clientes).
 */
export function exportedOrderFilters(filters: AdminOrdersFilters): Record<string, unknown> {
  const q = filters.q ?? null;
  const byEmail = q !== null && q.includes('@');
  return {
    tenantId: filters.tenantId ?? null,
    subtree: filters.subtree,
    vertical: filters.vertical ?? null,
    provider: filters.provider ?? null,
    statuses: filters.status ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
    q: byEmail ? null : q,
    ...(byEmail ? { qByClientEmail: true } : {}),
    attention: filters.attention ?? false,
  };
}
