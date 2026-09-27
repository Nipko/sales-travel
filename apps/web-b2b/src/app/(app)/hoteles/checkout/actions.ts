'use server';

import { api } from '../../../../lib/api';
import { parseOfferReference } from '../_components/hotel-rate-selection';
import {
  isRetryablePrebookStatus,
  parsePrebook,
  type HotelPrebook,
} from './_components/prebook-view';

/*
 * El PreBook de la tarifa elegida (U-09): `POST /hotels/prebook` con el cuerpo neutral y nada más
 * (RF-08 CA-4). La referencia llega del navegador y se vuelve a validar acá: una acción del
 * servidor es un endpoint más. Precio, ocupación, fechas y nacionalidad los pone el API con el
 * contexto de la búsqueda.
 */

export type PrebookActionResult =
  | {
      readonly ok: true;
      readonly prebook: HotelPrebook;
      /** Cuándo llegó la respuesta (epoch en ms, reloj del servidor): el vencimiento corre con él. */
      readonly receivedAt: number;
    }
  | {
      readonly ok: false;
      /** Ya en el idioma del vendedor: lo humaniza el API. */
      readonly error: string;
      /** Repetir el mismo PreBook puede servir; si no, se vuelve al hotel. */
      readonly retryable: boolean;
    };

const INVALID_REFERENCE =
  'No reconocemos la tarifa elegida. Volvé al hotel y elegila de nuevo desde sus tarifas.';

const INCOMPLETE =
  'La revalidación de la tarifa llegó incompleta, así que no se puede reservar con ella. Probá de nuevo.';

export async function prebookRateAction(reference: unknown): Promise<PrebookActionResult> {
  const ref = parseOfferReference(reference);
  if (ref === undefined) return { ok: false, error: INVALID_REFERENCE, retryable: false };

  // Los tres campos, nombrados uno por uno: lo que el navegador mande de más no viaja.
  const body = { providerCode: ref.providerCode, searchId: ref.searchId, offerRef: ref.offerRef };
  const res = await api<unknown>('/hotels/prebook', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return {
      ok: false,
      error: res.error.message,
      retryable: isRetryablePrebookStatus(res.error.status),
    };
  }

  const prebook = parsePrebook(res.data);
  // Otro proveedor del que se pidió no es esta tarifa: no se ofrece reservarla.
  if (prebook === undefined || prebook.providerCode !== ref.providerCode) {
    return { ok: false, error: INCOMPLETE, retryable: true };
  }
  return { ok: true, prebook, receivedAt: Date.now() };
}
