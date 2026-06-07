import type { Money } from '../actions';

const BOARD_LABELS: Record<string, string> = {
  RO: 'Solo alojamiento',
  BB: 'Desayuno',
  HB: 'Media pensión',
  FB: 'Pensión completa',
  AI: 'Todo incluido',
};

export function boardLabel(board: string): string {
  return BOARD_LABELS[board] ?? board;
}

export function formatMoney(m: Money | undefined): string {
  if (!m) return '—';
  const value = m.amountMinor / 100;
  try {
    return new Intl.NumberFormat('es', {
      style: 'currency',
      currency: m.currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${m.currency}`;
  }
}

const CANCEL_LABELS: Record<string, string> = {
  fully_refundable: 'Reembolsable',
  partially_refundable: 'Parcialmente reembolsable',
  non_refundable: 'No reembolsable',
};

export function cancellationLabel(status: string): string {
  return CANCEL_LABELS[status] ?? status;
}
