import { daysBetween } from '../../../../components/ui/date-range-picker';
import { stayDatesLabel } from './search-summary';

/*
 * Las fechas de la búsqueda de hoteles, sin React. El calendario manda `checkinDate` y
 * `checkoutDate` en campos ocultos, y un campo oculto no pasa por la validación del navegador: el
 * `required` de los dos `<input type="date">` de antes ya no frena nada. Esto es lo que frena el
 * envío antes del server action. "Hoy" es el día del calendario del vendedor (`todayIso`, local);
 * el servidor, que no sabe su huso, sólo rechaza lo que ya pasó en todas partes
 * (`earliestTodayIso`), así que todo lo que pasa este filtro también pasa aquel.
 */

/** Una estadía tiene al menos una noche. No hay tope: ningún proveedor ni el API lo declaran. */
export const MIN_STAY_NIGHTS = 1;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StayDatesProblem {
  /** Qué mitad del calendario tiene que tocar el vendedor: ahí va el foco. */
  readonly edge: 'start' | 'end';
  readonly message: string;
}

export function stayDatesProblem(
  checkin: string,
  checkout: string,
  today: string,
): StayDatesProblem | null {
  if (!ISO_DATE.test(checkin)) {
    return { edge: 'start', message: 'Elige las fechas de entrada y salida.' };
  }
  if (checkin < today) {
    return { edge: 'start', message: 'La fecha de entrada ya pasó. Elige otra.' };
  }
  if (!ISO_DATE.test(checkout)) return { edge: 'end', message: 'Elige la fecha de salida.' };
  if (daysBetween(checkin, checkout) < MIN_STAY_NIGHTS) {
    return {
      edge: 'end',
      message: 'La salida tiene que ser al menos una noche después de la entrada.',
    };
  }
  return null;
}

/**
 * Lo que se está buscando, en una línea, para la espera: «Cartagena, Colombia · 12 – 15 oct 2026
 * · 3 noches». Sale de lo que se ENVIÓ, no del formulario, que se puede seguir tocando.
 */
export function searchingEcho(data: {
  destinationLabel?: string;
  hotelIdsCount?: number;
  checkinDate: string;
  checkoutDate: string;
}): string {
  const parts: string[] = [];
  const destination = data.destinationLabel?.trim();
  if (destination) parts.push(destination);
  else if (data.hotelIdsCount) {
    parts.push(`${data.hotelIdsCount} hotel${data.hotelIdsCount === 1 ? '' : 'es'} por ID`);
  }
  if (ISO_DATE.test(data.checkinDate) && ISO_DATE.test(data.checkoutDate)) {
    const nights = daysBetween(data.checkinDate, data.checkoutDate);
    parts.push(stayDatesLabel(data.checkinDate, data.checkoutDate));
    if (nights > 0) parts.push(`${nights} noche${nights === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
