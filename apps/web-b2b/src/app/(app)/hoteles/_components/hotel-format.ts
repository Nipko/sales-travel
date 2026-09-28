import type { HotelCancellation, HotelFee, HotelRoompack, Money } from '../actions';

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

/**
 * Régimen de UNA tarifa. La etiqueta del proveedor gana sobre el código: "Desayuno para 1
 * persona" cabe en `BB`, pero mostrarlo como "Desayuno" en una doble promete de más (RF-11).
 */
export function rateBoardLabel(pack: Pick<HotelRoompack, 'board' | 'boardLabel'>): string {
  const own = pack.boardLabel?.trim();
  return own ? own : boardLabel(pack.board);
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

/**
 * Importe de un suplemento en SU moneda. Con `amountText` (moneda sin 2 decimales) se muestra el
 * literal del proveedor: `amountMinor / 100` lo multiplicaría o dividiría por diez.
 */
export function formatFee(fee: Pick<HotelFee, 'amount' | 'amountText'>): string {
  return fee.amountText ? `${fee.amountText} ${fee.amount.currency}` : formatMoney(fee.amount);
}

const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * Fecha y hora LOCAL del hotel ("12 oct 2026, 14:00"), sin pasarla por la zona del navegador: el
 * proveedor no dice la zona, y convertirla sería mostrar una hora que el hotel no usa.
 */
export function formatHotelLocalDateTime(local: string): string {
  const m = LOCAL_DATE_TIME_RE.exec(local);
  if (!m) return local;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  if (Number.isNaN(date.getTime())) return local;
  const day = new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(date)
    .replace(/\./g, '');
  return `${day}, ${h}:${mi}`;
}

const CANCEL_LABELS: Record<string, string> = {
  fully_refundable: 'Reembolsable',
  partially_refundable: 'Parcialmente reembolsable',
  non_refundable: 'No reembolsable',
};

export function cancellationLabel(status: string): string {
  return CANCEL_LABELS[status] ?? status;
}

/** Cómo se lee la política de UNA tarifa en el listado. */
export interface CancellationView {
  readonly label: string;
  readonly refundable: boolean;
  /** Aclaración corta al lado de la etiqueta, o nada. */
  readonly note?: string;
}

/**
 * La política de una tarifa según de dónde salió (`policySource`, D-TBO-19 A).
 *
 * - Sin tramos (`none`): el proveedor sólo dijo si es reembolsable. No se afirma "parcialmente"
 *   ni "totalmente": sería inventar lo que no se vio. Los plazos se conocen al revisar la tarifa.
 * - De una búsqueda (`search-indicative`): tramos que el PreBook puede cambiar, así que van
 *   "sujetos a confirmación", y la hora del fin sin cargo es la local del hotel.
 * - Del PreBook (`prebook-final`): definitivas.
 * - Sin declarar (un proveedor que no informa el origen): como se mostraba hasta ahora.
 */
export function cancellationView(c: HotelCancellation): CancellationView {
  const refundable = c.refundable;
  if (c.policySource === 'none') {
    return {
      label: refundable ? 'Reembolsable' : 'No reembolsable',
      refundable,
      ...(refundable ? { note: 'plazos a confirmar' } : {}),
    };
  }

  const freeUntil =
    refundable && c.freeCancellationUntilLocal
      ? `Sin cargo hasta el ${formatHotelLocalDateTime(c.freeCancellationUntilLocal)}`
      : undefined;
  const label = freeUntil ?? cancellationLabel(c.status);

  if (c.policySource === 'search-indicative') {
    return {
      label,
      refundable,
      note: freeUntil ? 'hora local del hotel, sujeta a confirmación' : 'sujeta a confirmación',
    };
  }
  return { label, refundable, ...(freeUntil ? { note: 'hora local del hotel' } : {}) };
}
