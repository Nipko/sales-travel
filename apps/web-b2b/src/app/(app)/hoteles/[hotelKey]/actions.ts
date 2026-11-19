'use server';

import { api } from '../../../../lib/api';
import { hotelImageProxyUrl } from '../../../../lib/hotel-image-proxy';
import type { HotelAccountEnvironment, HotelOffer } from '../actions';
import { decodeHotelKey, type HotelProviderHotelRef } from '../_components/hotel-key';
import {
  parseHotelContent,
  withProxiedPhotos,
  type HotelContent,
} from './_components/hotel-content-view';

/*
 * Lecturas del detalle de un hotel: la ficha de cada proveedor que lo vende. Las tarifas de la
 * estadía (D-TBO-19 A) van por `POST /api/hotels/rates`, un pedido por proveedor: el cliente de
 * Next despacha las acciones del servidor de a una y las de un proveedor esperarían a las del otro.
 *
 * La clave llega del navegador y se vuelve a validar aquí: una acción del servidor es un endpoint
 * más. Cada proveedor se pide por separado y en paralelo, y el fallo de uno no tapa lo que
 * respondió el otro.
 */

/** El panel está en español; el API responde el inglés como respaldo y lo dice en `lang`. */
const CONTENT_LANG = 'es';

export interface HotelContentOutcome {
  readonly ref: HotelProviderHotelRef;
  readonly content?: HotelContent;
  readonly error?: string;
}

export interface HotelContentResult {
  readonly ok: boolean;
  /** Una por proveedor, en el orden de la clave. */
  readonly outcomes: readonly HotelContentOutcome[];
  readonly error?: string;
}

export interface HotelRatesOutcome {
  readonly ref: HotelProviderHotelRef;
  readonly offer?: HotelOffer;
  /** El entorno de la cuenta que dio las tarifas, si el proveedor lo declara. */
  readonly accountEnvironment?: HotelAccountEnvironment;
  readonly error?: string;
}

export interface HotelDetailRatesResult {
  /** Respondió al menos un proveedor, con tarifas o sin ellas. */
  readonly ok: boolean;
  readonly outcomes: readonly HotelRatesOutcome[];
  /** Cuándo llegó la respuesta (epoch en ms): cambia en cada consulta. */
  readonly receivedAt?: number;
  /**
   * Quien financia a la agencia le bloqueó las tarifas no reembolsables (0055): se marcan como no
   * disponibles y no se ofrece reservarlas. Ausente si no se pudo leer: el PreBook decide igual.
   */
  readonly nonRefundableBlocked?: boolean;
  readonly error?: string;
}

const INVALID_KEY = 'No reconocemos ese hotel. Ábrelo desde los resultados de una búsqueda.';

function pathOf(ref: HotelProviderHotelRef): string {
  return `/hotels/content/${encodeURIComponent(ref.provider)}/${encodeURIComponent(ref.hotelId)}?lang=${CONTENT_LANG}`;
}

/**
 * La ficha de cada proveedor del hotel. Sin contenido, el API responde la ficha vacía, no un error.
 * Las fotos salen como rutas del proxy propio: la URL del proveedor no llega al navegador.
 */
export async function hotelContentAction(hotelKey: string): Promise<HotelContentResult> {
  const refs = typeof hotelKey === 'string' ? decodeHotelKey(hotelKey) : undefined;
  if (refs === undefined) return { ok: false, outcomes: [], error: INVALID_KEY };

  const outcomes = await Promise.all(
    refs.map(async (ref): Promise<HotelContentOutcome> => {
      const res = await api<unknown>(pathOf(ref));
      if (!res.ok) return { ref, error: res.error.message };
      const content = parseHotelContent(res.data, ref);
      return content === undefined
        ? { ref, error: 'La ficha del hotel llegó incompleta.' }
        : { ref, content: withProxiedPhotos(content, hotelImageProxyUrl) };
    }),
  );
  return { ok: outcomes.some((o) => o.content !== undefined), outcomes };
}
