'use server';

import { api } from '../../../../lib/api';
import type { HotelOffer } from '../actions';
import { decodeHotelKey, type HotelProviderHotelRef } from '../_components/hotel-key';
import { parseStay } from '../_components/hotel-search-handoff';
import { parseHotelContent, type HotelContent } from './_components/hotel-content-view';

/*
 * Lecturas del detalle de un hotel: la ficha de cada proveedor que lo vende y sus tarifas para la
 * estadía de la búsqueda (D-TBO-19 A: al abrir el hotel se vuelve a buscar sólo ese hotel, con las
 * políticas "sujetas a confirmación").
 *
 * La clave y la estadía llegan del navegador y se vuelven a validar aquí: una acción del servidor
 * es un endpoint más. Cada proveedor se pide por separado y en paralelo, y el fallo de uno no
 * tapa lo que respondió el otro.
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

const INVALID_KEY = 'No reconocemos ese hotel. Abrilo desde los resultados de una búsqueda.';

function pathOf(ref: HotelProviderHotelRef): string {
  return `/hotels/content/${encodeURIComponent(ref.provider)}/${encodeURIComponent(ref.hotelId)}?lang=${CONTENT_LANG}`;
}

/** La ficha de cada proveedor del hotel. Sin contenido, el API responde la ficha vacía, no un error. */
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
        : { ref, content };
    }),
  );
  return { ok: outcomes.some((o) => o.content !== undefined), outcomes };
}

function isOffer(value: unknown): value is HotelOffer {
  if (typeof value !== 'object' || value === null) return false;
  const { hotelId, roompacks } = value as { hotelId?: unknown; roompacks?: unknown };
  return typeof hotelId === 'string' && Array.isArray(roompacks);
}

/**
 * Las tarifas del hotel en cada proveedor que lo vende, para la estadía de la búsqueda. Es una
 * búsqueda nueva: sus tarifas tienen su propio vencimiento y su propia referencia de reserva.
 */
export async function hotelRatesAction(
  hotelKey: string,
  stay: unknown,
): Promise<HotelDetailRatesResult> {
  const refs = typeof hotelKey === 'string' ? decodeHotelKey(hotelKey) : undefined;
  if (refs === undefined) return { ok: false, outcomes: [], error: INVALID_KEY };
  const parsed = parseStay(stay);
  if (parsed === undefined) {
    return {
      ok: false,
      outcomes: [],
      error: 'Faltan los datos de la búsqueda. Buscá de nuevo desde Hoteles.',
    };
  }

  const permission = api<unknown>('/hotels/booking-permissions');
  const outcomes = await Promise.all(
    refs.map(async (ref): Promise<HotelRatesOutcome> => {
      const body: Record<string, unknown> = {
        hotelId: ref.hotelId,
        provider: ref.provider,
        checkinDate: parsed.checkinDate,
        checkoutDate: parsed.checkoutDate,
        rooms: parsed.rooms,
        guestNationality: parsed.guestNationality,
      };
      if (parsed.refundableOnly) body.refundableOnly = true;
      // La moneda del listado: sin ella el detalle buscaría en la de la agencia (D-TBO-15).
      if (parsed.currency !== undefined) body.currency = parsed.currency;
      const res = await api<unknown>('/hotels/detail', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ref, error: res.error.message };
      return isOffer(res.data)
        ? { ref, offer: res.data }
        : { ref, error: 'La respuesta del proveedor llegó incompleta.' };
    }),
  );
  const blocked = nonRefundableBlockedOf(await permission);
  return {
    ok: outcomes.some((o) => o.offer !== undefined),
    outcomes,
    receivedAt: Date.now(),
    ...(blocked ? { nonRefundableBlocked: true } : {}),
  };
}

/** `GET /hotels/booking-permissions`: sólo un `blocked` explícito marca las tarifas. */
function nonRefundableBlockedOf(res: Awaited<ReturnType<typeof api<unknown>>>): boolean {
  if (!res.ok || typeof res.data !== 'object' || res.data === null) return false;
  const rates = (res.data as { nonRefundableRates?: unknown }).nonRefundableRates;
  return (
    typeof rates === 'object' &&
    rates !== null &&
    (rates as { effective?: unknown }).effective === 'blocked'
  );
}
