'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { HotelFacts } from '../[hotelKey]/_components/hotel-rate-detail-view';
import {
  checkoutHref,
  offerReferenceOf,
  rateSelectionOf,
  saveRateSelection,
} from './hotel-rate-selection';
import type { HotelRateRow } from './hotel-rate-view';
import { newSearchToken, type HotelStay } from './hotel-search-handoff';

/*
 * Elegir una tarifa para reservarla, desde la tarjeta del listado o desde el detalle del hotel:
 * se guarda la elección con un identificador nuevo y se va al checkout, que la revalida con el
 * PreBook antes de cargar los huéspedes. Cada clic, un identificador: dos pestañas no se pisan.
 */

export const RATE_SAVE_FAILED_MESSAGE =
  'No pudimos guardar la tarifa elegida en este navegador. Revisa que no esté en modo privado o sin espacio e intenta de nuevo.';

export interface UseBookRateOptions {
  /** El hotel, para volver a él desde el checkout. Sin clave no hay a dónde volver. */
  readonly hotelKey?: string;
  /** La búsqueda desde la que se eligió, si la hubo. */
  readonly searchToken?: string;
  /** La estadía que se cotizó: el checkout carga los huéspedes por habitación con ella. */
  readonly stay?: HotelStay;
  /** El ajuste de divulgación con el que respondió la búsqueda (RF-40). */
  readonly showProvider: boolean;
  /** Nombre y dirección que el vendedor ve en pantalla. */
  readonly shownFacts?: HotelFacts;
  /** Con qué nombre y dirección conoce al hotel el proveedor que vende la tarifa. */
  readonly factsFor?: (providerCode: string) => HotelFacts | undefined;
}

export interface BookRate {
  readonly canBook: (row: HotelRateRow) => boolean;
  readonly book: (row: HotelRateRow) => void;
}

export function useBookRate({
  hotelKey,
  searchToken,
  stay,
  showProvider,
  shownFacts,
  factsFor,
}: UseBookRateOptions): BookRate {
  const router = useRouter();

  const canBook = (row: HotelRateRow): boolean =>
    hotelKey !== undefined && stay !== undefined && offerReferenceOf(row.pack) !== undefined;

  const book = (row: HotelRateRow): void => {
    if (hotelKey === undefined || stay === undefined) return;
    const seller = row.pack.provider?.name;
    const selection = rateSelectionOf({
      pack: row.pack,
      sale: row.sale,
      hotelKey,
      searchToken,
      stay,
      showProviderInResults: showProvider,
      sellerFacts: seller === undefined ? undefined : factsFor?.(seller),
      shownFacts,
      nowMs: Date.now(),
    });
    if (selection === undefined) return;
    const token = newSearchToken();
    if (!saveRateSelection(token, selection)) {
      toast.error(RATE_SAVE_FAILED_MESSAGE);
      return;
    }
    router.push(checkoutHref(token));
  };

  return { canBook, book };
}
