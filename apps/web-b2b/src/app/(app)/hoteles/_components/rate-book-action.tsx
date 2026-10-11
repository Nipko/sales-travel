import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/cn';
import { formatMoney } from './hotel-format';
import type { HotelRateRow } from './hotel-rate-view';

/*
 * Reservar una tarifa, la misma acción en la tarjeta del listado y en el detalle del hotel: lleva
 * al checkout, que la revalida con el proveedor (PR-6.3). Sólo las tarifas que se revalidan por el
 * PreBook neutral: las de un proveedor que reserva por su flujo propio (Despegar, D-TBO-08 A) no
 * tienen checkout en el panel, y se dice.
 */

/** El texto de una tarifa que el panel todavía no puede llevar al checkout. */
export const RATE_NOT_BOOKABLE_NOTE = 'Esta tarifa todavía no se puede reservar desde el panel.';

export function RateBookAction({
  row,
  bookable,
  expired,
  unavailableForAgency,
  onBook,
  hotelName,
  className,
}: {
  row: HotelRateRow;
  bookable: boolean;
  expired: boolean;
  /** No reembolsable y la agencia no las puede reservar: ya lo dice la etiqueta de la fila. */
  unavailableForAgency: boolean;
  onBook: () => void;
  /**
   * En el listado, el hotel de la tarifa: el lector de pantalla que recorre los botones de la página
   * oye varios «Reservar» de varios hoteles. En el detalle sobra: todos son del mismo hotel.
   */
  hotelName?: string;
  className?: string;
}) {
  if (unavailableForAgency) return null;
  if (!bookable) {
    return (
      <p className={cn('text-[11px] text-[var(--color-fg-muted)]', className)}>
        {RATE_NOT_BOOKABLE_NOTE}
      </p>
    );
  }
  return (
    <div className={cn('flex justify-end pt-1', className)}>
      <Button
        type="button"
        size="sm"
        className="w-full sm:w-auto"
        disabled={expired}
        onClick={onBook}
      >
        Reservar
        <span className="sr-only">
          : {row.board}, {row.rooms}, {formatMoney(row.sale)}
          {hotelName ? `, en ${hotelName}` : null}
        </span>
      </Button>
    </div>
  );
}
