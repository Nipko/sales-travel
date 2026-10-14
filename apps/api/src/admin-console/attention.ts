/**
 * Por qué una reserva necesita a una persona: el vocabulario cerrado de `admin_order_attention()`
 * (0075 §7). La base lo emite y la consola lo lee; un test de contrato (attention.sql-contract.test.ts)
 * exige que la migración use exactamente estas palabras y estos umbrales. Sin I/O.
 */

export const ORDER_ATTENTION_REASONS = [
  'review',
  'verifying-long',
  'create-stuck',
  'cancel-failed',
  'hold-conflict',
  'hold-orphan',
  'hcn-missing',
  'reconciliation',
] as const;

export type OrderAttentionReason = (typeof ORDER_ATTENTION_REASONS)[number];

/**
 * De lo más grave a lo menos: lo que tiene plata trabada o a la agencia esperando va primero. Cuando
 * una orden tiene varios motivos, se muestra el primero de esta lista (la muestra del Resumen, la
 * marca de la consola de Reservas).
 */
export const ATTENTION_PRIORITY: readonly OrderAttentionReason[] = [
  'hold-orphan',
  'hold-conflict',
  'cancel-failed',
  'review',
  'create-stuck',
  'reconciliation',
  'hcn-missing',
  'verifying-long',
];

/**
 * Los umbrales de 0075 §7, como los escribe la migración (`interval '…'`). Heurísticos: se afinan con
 * datos reales, cambiando la función y esta tabla juntas.
 */
export const ATTENTION_THRESHOLDS = {
  /** Sólo se miran las órdenes creadas en esta ventana. */
  window: '180 days',
  /** verifying-long: una verificación del hotel sin novedades por más que esto. */
  verifyingLong: '2 hours',
  /** create-stuck: una orden pending sin verificación en curso por más que esto. */
  createStuck: '30 minutes',
  /** hold-orphan: una retención held con la orden cerrada, creada hace más que esto. */
  holdOrphan: '1 hour',
  /** reconciliation: divergencias críticas de esta ventana. */
  reconciliation: '14 days',
} as const;

export function isOrderAttentionReason(value: unknown): value is OrderAttentionReason {
  return (ORDER_ATTENTION_REASONS as readonly unknown[]).includes(value);
}

/** El índice de prioridad de un motivo (menor = más grave). */
export function attentionRank(reason: OrderAttentionReason): number {
  return ATTENTION_PRIORITY.indexOf(reason);
}
