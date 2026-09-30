/**
 * Vocabulario de `domain_events` propio de la vertical de hoteles. La reserva usa el de órdenes
 * (`orders/order-events.ts`) con `vertical: 'hotels'`; aquí va sólo lo que no es de una orden.
 *
 * Constantes y no literales sueltos por el mismo motivo que en órdenes: el panel de red consulta
 * por `event_type`, y un nombre mal escrito no falla, desaparece. El `payload` lleva vocabulario
 * cerrado —códigos, importes en unidades menores y monedas—, nunca PII ni texto del proveedor:
 * `domain_events` es append-only (docs/tbo/03 §2.9 regla 3 y §8.4).
 */
export const HOTEL_EVENTS = {
  /** Un PreBook devolvió otro precio u otras condiciones que las que se mostraron (RF-15). */
  offerRepriced: 'HotelOfferRepriced',
  /**
   * El proveedor rechazó por la CUENTA (sin saldo, bloqueada) y no por la tarifa (RF-23; 03 §6). Va
   * al tenant dueño de la cuenta, no al que vendía: una sub-agencia no lee los eventos de su
   * consolidador (0029), y este aviso no le toca resolverlo.
   */
  providerAccountIssue: 'ProviderAccountIssueDetected',
  /**
   * El vendedor confirmó que entiende que la tarifa no es reembolsable antes de reservarla (pedido
   * del founder del 2026-09-29, punto c): quién (`actor_user_id`), cuándo, el 100 % en el precio de
   * venta y la política que aceptó (su origen y la huella de las condiciones). Va sobre la orden.
   */
  nonRefundableAcknowledged: 'HotelNonRefundableAcknowledged',
} as const;

export type HotelEventType = (typeof HOTEL_EVENTS)[keyof typeof HOTEL_EVENTS];
