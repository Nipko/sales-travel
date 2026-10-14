/**
 * Por qué una reserva necesita a una persona: el vocabulario cerrado de `admin_order_attention()`
 * (0075 §7, apps/api/src/admin-console/attention.ts) y cómo se nombra cada motivo. Sin I/O.
 *
 * Lo comparten el Resumen ("Reservas con problemas") y la consola de Reservas de la red: si cada
 * pantalla tuviera su mapa, la tarjeta diría "Cancelación fallida" y la fila de la misma reserva otra
 * cosa. Un motivo que esta versión no conoce se ignora.
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

/** De lo más grave a lo menos, como ATTENTION_PRIORITY del API. */
export const ATTENTION_REASON_PRIORITY: readonly OrderAttentionReason[] = [
  'hold-orphan',
  'hold-conflict',
  'cancel-failed',
  'review',
  'create-stuck',
  'reconciliation',
  'hcn-missing',
  'verifying-long',
];

/** Lo que tiene plata trabada o una cancelación que no salió: urgente. */
export const CRITICAL_REASONS: ReadonlySet<OrderAttentionReason> = new Set([
  'hold-orphan',
  'hold-conflict',
  'cancel-failed',
]);

export function isOrderAttentionReason(value: unknown): value is OrderAttentionReason {
  return (ORDER_ATTENTION_REASONS as readonly unknown[]).includes(value);
}
