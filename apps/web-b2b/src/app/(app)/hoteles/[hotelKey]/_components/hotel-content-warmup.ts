import type { HotelProviderHotelRef } from '../../_components/hotel-key';
import {
  PHOTO_MAX_ATTEMPTS,
  clampPhotoRetry,
  photoRefKey,
  requestPhotoBatch,
  type PhotoBatchOutcome,
  type PhotoRef,
  type PhotoTarget,
} from '../../_components/hotel-photos';
import type { HotelContentResult } from '../actions';
import { contentToShow } from './hotel-detail-view';

/*
 * El contenido de la ficha bajo demanda cuando la lectura de la ficha no lo trajo (estrategia de
 * fotos del 2026-09-29).
 *
 * `GET /hotels/content/…` ya le pide el hotel al proveedor si el catálogo no tiene su detalle, pero
 * con un plazo corto (la ficha no espera) y sin guardarlo. Si vuelve sin fotos y no fue el
 * proveedor quien dijo que no las tiene, la pantalla pide ese hotel por el contenido por lote
 * (`POST /api/hotels/content/batch`), que le pide `HotelDetails` con un plazo largo por el cupo de
 * fondo y el circuito, lo GUARDA en `hotel_content` y responde `ready`, `pending` (volver a
 * preguntar) o `none`. Con algo `ready`, la ficha se vuelve a leer, ya del catálogo. Nada de esto
 * frena las tarifas ni el resto de la ficha, y los reintentos están acotados.
 */

/**
 * Qué hoteles de la clave vale la pena pedir: los que respondieron su ficha sin fotos y sin que
 * el proveedor haya dicho que no las tiene (`origin: 'provider'`). Nada si la ficha que se muestra
 * ya tiene fotos o si la del primero falló (la pantalla ofrece reintentar). El servidor decide el
 * resto: un proveedor que no da contenido o un hotel que ya tiene su detalle salen `none` sin
 * llamar a nadie.
 */
export function refsToWarm(
  refs: readonly HotelProviderHotelRef[],
  content: HotelContentResult | undefined,
): PhotoRef[] {
  const shown = contentToShow(refs, content);
  if (shown === undefined || shown.images.length > 0) return [];
  const seen = new Set<string>();
  const out: PhotoRef[] = [];
  for (const outcome of content?.outcomes ?? []) {
    const c = outcome.content;
    if (c === undefined || c.images.length > 0 || c.origin === 'provider') continue;
    const ref = { providerCode: outcome.ref.provider, hotelId: outcome.ref.hotelId };
    const key = photoRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * La ficha releída, si sirve: con la del primer hotel de la clave. Si la relectura falló, la que
 * ya se mostraba: una relectura que falla no puede borrar lo que el vendedor ya estaba viendo.
 */
export function rereadContent(
  refs: readonly HotelProviderHotelRef[],
  previous: HotelContentResult,
  next: HotelContentResult | undefined,
): HotelContentResult {
  const primary = refs[0]?.provider;
  const hasPrimary = next?.outcomes.some(
    (o) => o.ref.provider === primary && o.content !== undefined,
  );
  return next !== undefined && hasPrimary === true ? next : previous;
}

export type WarmOutcome = 'ready' | 'none';

export interface WarmDeps {
  readonly request?: (
    batch: readonly PhotoTarget[],
    signal: AbortSignal,
  ) => Promise<PhotoBatchOutcome>;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly maxAttempts?: number;
}

/** Espera `ms` o hasta que se corte: nunca lanza. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pide el contenido de esos hoteles hasta que alguno esté `ready` (y entonces conviene releer la
 * ficha), todos digan `none` o se agoten los intentos. Un fallo de red, un 429 o un 5xx se
 * reintentan; lo demás (un 400, la sesión vencida) no se arregla insistiendo. Nunca lanza.
 */
export async function warmHotelContent(
  refs: readonly PhotoRef[],
  signal: AbortSignal,
  deps: WarmDeps = {},
): Promise<WarmOutcome> {
  const request = deps.request ?? requestPhotoBatch;
  const sleep = deps.sleep ?? abortableSleep;
  const maxAttempts = deps.maxAttempts ?? PHOTO_MAX_ATTEMPTS;
  let waiting = [...refs];
  for (let attempt = 1; waiting.length > 0 && attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) return 'none';
    let outcome: PhotoBatchOutcome;
    try {
      outcome = await request([{ key: 'detalle', refs: waiting }], signal);
    } catch {
      outcome = { ok: false, retryable: true };
    }
    if (signal.aborted) return 'none';

    let retryAfterMs: number | undefined;
    if (outcome.ok) {
      const { items } = outcome.reply;
      if (waiting.some((r) => items.get(photoRefKey(r))?.status === 'ready')) return 'ready';
      waiting = waiting.filter((r) => items.get(photoRefKey(r))?.status === 'pending');
      retryAfterMs = outcome.reply.retryAfterMs;
    } else {
      if (!outcome.retryable) return 'none';
      retryAfterMs = outcome.retryAfterMs;
    }
    if (waiting.length === 0 || attempt === maxAttempts) break;
    await sleep(clampPhotoRetry(retryAfterMs), signal);
  }
  return 'none';
}
