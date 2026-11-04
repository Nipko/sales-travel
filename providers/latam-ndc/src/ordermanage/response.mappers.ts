import type {
  AirlineLocator,
  OrderCancelResult,
  OrderView,
  TicketDocument,
  TicketDocumentStatus,
  TicketingDeadline,
} from '@sales-travel/domain';
import { LatamApiError, LatamBusinessError } from '../errors';
import { arr, latamErrors, latamWarnings, money, pick, text, type LatamMessage } from '../xml';

export const ORDER_RETRIEVE_PATH = '/ndc/v192/order/retrieve';

/** «Order Id not found» (`[portal:/ndc/order-retrieve]`). El único error que sí es «no existe». */
export const LATAM_ORDER_NOT_FOUND = '404107001';
/** «At least one of your items have been voided» / «Your order is Voided». */
export const LATAM_VOIDED_WARNING = '111';

/**
 * Estados de LATAM (`[portal:/ndc/order-create]`, tabla StatusCode) → los de la plataforma
 * (`orders.status`: pending | confirmed | ticketed | cancelled | failed).
 *
 * - `OPENED`: creada sin pago, o pago en proceso → `confirmed` (reservada, falta emitir).
 * - `FROZEN`: el pago falló; la reserva sigue y se puede reintentar con otro medio → `confirmed`.
 * - `CLOSED`: pagada y emitida → `ticketed`, salvo que la lectura diga que se anuló (aviso 111) o
 *   que todos sus tiquetes estén anulados o reembolsados → `cancelled`.
 *
 * Antes el valor de LATAM pasaba tal cual y `orders.service` guardaba `CLOSED` en la orden: para
 * la plataforma una orden emitida seguía «sin emitir», con «Cancelar» a la vista.
 */
export type LatamOrderStatus = 'confirmed' | 'ticketed' | 'cancelled';

export function normalizeLatamOrderStatus(
  statusCode: string | undefined,
  documents: readonly TicketDocument[],
  warnings: readonly LatamMessage[],
): LatamOrderStatus | undefined {
  const code = statusCode?.trim().toUpperCase();
  if (!code) return undefined;
  if (code === 'OPENED' || code === 'FROZEN') return 'confirmed';
  if (code === 'CLOSED') {
    const voided = warnings.some((w) => w.code === LATAM_VOIDED_WARNING && /voided/i.test(w.desc));
    const allDead =
      documents.length > 0 &&
      documents.every((d) => d.status === 'VOIDED' || d.status === 'REFUNDED');
    return voided || allDead ? 'cancelled' : 'ticketed';
  }
  if (code.includes('CANCEL') || code.includes('VOID')) return 'cancelled';
  return undefined;
}

export function mapOrderRetrieveResponse(raw: unknown, trackId?: string): OrderView {
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderRetrieveRS');
  if (!root) throw new LatamApiError(200, 'respuesta sin IATA_OrderViewRS', ORDER_RETRIEVE_PATH);

  const errors = latamErrors(root);
  if (errors.length > 0) {
    // Sólo «no existe» es una lectura válida. Cualquier otro error es una lectura FALLIDA: antes
    // se devolvía `found: false` y `verifyCreationById` degradaba a `pending` una reserva viva.
    if (errors.every((e) => e.code === LATAM_ORDER_NOT_FOUND)) {
      return {
        found: false,
        airlineLocators: [],
        warnings: errors.map((e) => `${e.code}: ${e.desc}`),
      };
    }
    throw new LatamBusinessError(errors, ORDER_RETRIEVE_PATH, trackId);
  }

  const response = pick(root, 'Response');
  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) throw new LatamApiError(200, 'OrderViewRS sin Order', ORDER_RETRIEVE_PATH);

  return mapOrderView(response, order);
}

/** Lectura común de un `OrderViewRS` (retrieve, pago, cambio). */
export function mapOrderView(response: unknown, order: Record<string, unknown>): OrderView {
  const orderId = text(order.OrderID);
  const warnings = latamWarnings(response);
  const documents = ticketDocuments(response);
  const status = normalizeLatamOrderStatus(text(order.StatusCode), documents, warnings);

  const airlineLocators: AirlineLocator[] = [];
  const bookingId = text(pick(order.BookingRef, 'BookingID'));
  // El `BookingRef` de la orden es el localizador de 6 letras; el del TicketDocInfo repite el OrderID.
  if (bookingId && bookingId !== orderId && /^[A-Z0-9]{5,8}$/.test(bookingId)) {
    airlineLocators.push({ carrierCode: 'LA', locator: bookingId });
  }

  const ticketingDeadline = paymentTimeLimit(order);

  return {
    found: true,
    ...(orderId ? { orderId } : {}),
    // `pnr` sigue siendo el OrderID: es la llave de la postventa. El localizador va arriba.
    ...(orderId ? { pnr: orderId } : {}),
    ...(status ? { status } : {}),
    ...(documents.length > 0 ? { ticketNumbers: documents.map((d) => d.number) } : {}),
    documents,
    airlineLocators,
    ...(ticketingDeadline ? { ticketingDeadline } : {}),
    warnings: warnings.map((w) => `${w.code}: ${w.desc}`),
  };
}

/**
 * Tiquetes de `Response/TicketDocInfo[]/Ticket` —al lado de `Order`, no dentro: buscarlos dentro
 * de `Order` dejaba la lista siempre vacía—. El estado sale de los cupones
 * (`[portal:/ndc/order-retrieve]`, tabla CouponStatusCode).
 */
function ticketDocuments(response: unknown): TicketDocument[] {
  const docs: TicketDocument[] = [];
  const seen = new Set<string>();
  for (const info of arr(pick(response, 'TicketDocInfo'))) {
    for (const ticket of arr(pick(info, 'Ticket'))) {
      const number = text(pick(ticket, 'TicketNumber'))?.replace(/\D/g, '');
      if (!number || !/^\d{10,16}$/.test(number) || seen.has(number)) continue;
      seen.add(number);
      const coupons = arr(pick(ticket, 'Coupon'))
        .map((c) => text(pick(c, 'CouponStatusCode'))?.trim().toUpperCase())
        .filter((c): c is string => Boolean(c));
      const docType = text(pick(ticket, 'TicketDocTypeCode'))?.toUpperCase();
      docs.push({
        number,
        kind: docType === 'EMD' || docType === 'J' || docType === 'Y' ? 'EMD' : 'TICKET',
        status: couponStatus(coupons),
        ...(coupons[0] && /^[A-Z0-9]+$/.test(coupons[0]) ? { providerStatusCode: coupons[0] } : {}),
      });
    }
  }
  return docs;
}

function couponStatus(coupons: readonly string[]): TicketDocumentStatus {
  if (coupons.length === 0) return 'UNKNOWN';
  if (coupons.every((c) => c === 'VOID')) return 'VOIDED';
  if (coupons.every((c) => c === 'RFND' || c === 'RF')) return 'REFUNDED';
  if (coupons.every((c) => c === 'EXCH' || c === 'E')) return 'EXCHANGED';
  const live = ['OK', 'OPEN', 'USED', 'CKIN', 'CTRL', 'ACTL', 'PRTD', 'SUSP'];
  if (coupons.some((c) => live.includes(c))) return 'ISSUED';
  return 'UNKNOWN';
}

/**
 * `PaymentTimeLimitDateTime` del OrderItem: hasta cuándo se puede pagar una reserva sin pago.
 * LATAM lo da en UTC y puede tardar ~20 min en aparecer (`[portal:/ndc/order-retrieve]`).
 * Se toma el más temprano entre los ítems.
 */
function paymentTimeLimit(order: Record<string, unknown>): TicketingDeadline | undefined {
  const candidates = [order, ...arr<Record<string, unknown>>(order.OrderItem)]
    .map((n) => text(n.PaymentTimeLimitDateTime))
    .filter((v): v is string => Boolean(v))
    .map((v) => /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(v))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const first = candidates[0];
  if (!first?.[1]) return undefined;
  return { date: first[1], ...(first[2] ? { time: first[2] } : {}), zone: 'UTC' };
}

/**
 * `OrderCancelRS`. La respuesta exitosa NO trae `Order`: el VOID devuelve
 * `Response/OrderCancelProcessing` + `OrderRefID` y el reembolso `Response/OrderRefID` +
 * `TicketDocInfo` (`[portal:/ndc/order-void]`, `[portal:/ndc/order-cancel]`). Exigir `Order`
 * hacía que toda cancelación exitosa se reportara como fallida.
 */
export function mapOrderCancelResponse(raw: unknown): OrderCancelResult {
  const root = pick(raw, 'IATA_OrderCancelRS', 'OrderCancelRS', 'IATA_OrderViewRS', 'OrderViewRS');
  if (!root) {
    return {
      success: false,
      warnings: ['No root element in OrderCancel response.'],
      error: 'Respuesta inválida de LATAM',
    };
  }

  const errors = latamErrors(root);
  if (errors.length > 0) {
    const msg = errors.map((e) => `LATAM error ${e.code}: ${e.desc}`).join(' | ');
    return { success: false, warnings: [msg], error: msg };
  }

  const response = pick(root, 'Response');
  const confirmed =
    text(pick(response, 'OrderRefID')) ??
    text(pick(pick(response, 'Order'), 'OrderID')) ??
    (pick(response, 'OrderCancelProcessing') ? 'processed' : undefined);
  if (!confirmed) {
    return {
      success: false,
      warnings: ['OrderCancelRS sin OrderRefID.'],
      error: 'Respuesta vacía de LATAM',
    };
  }

  const refunds = arr(pick(response, 'TicketDocInfo'))
    .flatMap((info) => arr(pick(info, 'PaymentInfo')))
    .filter((p) => text(pick(p, 'PaymentStatusCode'))?.toUpperCase() === 'REFUNDED')
    .map((p) => money(pick(p, 'Amount')))
    .filter((m): m is NonNullable<typeof m> => m !== null);
  const currency = refunds[0]?.currency;
  const refundAmount =
    currency && refunds.every((r) => r.currency === currency)
      ? { amountMinor: refunds.reduce((s, r) => s + r.amountMinor, 0), currency }
      : undefined;

  return { success: true, ...(refundAmount ? { refundAmount } : {}), warnings: [] };
}
