import type { OrderPayResult } from '@sales-travel/domain';
import { mapOrderView } from '../ordermanage/response.mappers';
import { latamErrors, pick, text } from '../xml';

/**
 * `OrderViewRS` del pago (`/order/change/payment`, `[portal:/ndc/order-change-pay-later]`).
 *
 * El estado se traduce al de la plataforma (ver `normalizeLatamOrderStatus`):
 * - `CLOSED` → pagada y emitida → `ticketed`.
 * - `FROZEN` → LATAM rechazó el pago: NO es éxito, aunque la orden siga viva para reintentar.
 * - `OPENED` → pago todavía en proceso → `confirmed`, con aviso para releer.
 *
 * Antes `status` llevaba `CLOSED` tal cual y `orders.service` lo guardaba en `orders.status`.
 */
export function mapOrderChangePaymentResponse(raw: unknown): OrderPayResult {
  const root = pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderChangeRS');
  if (!root) {
    return {
      success: false,
      warnings: ['No root element in OrderChange response.'],
      error: 'Respuesta inválida de LATAM',
    };
  }

  const errors = latamErrors(root);
  if (errors.length > 0) {
    const msg = errors.map((e) => `LATAM error ${e.code}: ${e.desc}`).join(' | ');
    return { success: false, warnings: [msg], error: msg };
  }

  const response = pick(root, 'Response');
  const order = pick(response, 'Order') as Record<string, unknown> | undefined;
  if (!order) {
    return { success: false, warnings: ['No Order element.'], error: 'Respuesta vacía de LATAM' };
  }

  const view = mapOrderView(response, order);
  const rawStatus = text(order.StatusCode)?.toUpperCase();

  if (rawStatus === 'FROZEN') {
    return {
      success: false,
      ...(view.orderId ? { orderId: view.orderId } : {}),
      status: 'confirmed',
      warnings: view.warnings,
      error:
        'LATAM rechazó el pago. La reserva sigue activa: puedes intentar con otro medio de pago.',
    };
  }

  const warnings = [...view.warnings];
  if (rawStatus === 'OPENED') {
    warnings.push('El pago sigue en proceso en LATAM. Consulta el estado en unos minutos.');
  }

  return {
    success: true,
    ...(view.orderId ? { orderId: view.orderId } : {}),
    ...(view.status ? { status: view.status } : {}),
    warnings,
  };
}
