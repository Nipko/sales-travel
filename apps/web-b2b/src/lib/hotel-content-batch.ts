import type { ApiResponse } from './api';

/*
 * `POST /api/hotels/content/batch` del panel → `POST /hotels/content/batch` del API: las fotos de
 * una pantalla de resultados, pedidas en segundo plano (estrategia de fotos del 2026-09-29).
 *
 * El cuerpo se rearma con lo que el API acepta —idioma y hasta 24 hoteles, cada uno con su
 * proveedor y su código— y lo que el navegador mande de más no llega. El API vuelve a validar con
 * Zod. La respuesta viaja tal cual: `items` con `status` (`ready`, `pending`, `none`), la foto por el
 * proxy propio y `retryAfterMs` si algo quedó `pending`.
 */

/** El tope del API (`HOTEL_CONTENT_BATCH_MAX_HOTELS`): más es un 400. */
export const HOTEL_CONTENT_BATCH_MAX_HOTELS = 24;

const PROVIDER_CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HOTEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LANGS = ['es', 'pt', 'en'] as const;
type Lang = (typeof LANGS)[number];

export interface HotelContentBatchRequest {
  readonly lang: Lang;
  readonly hotels: readonly { readonly providerCode: string; readonly hotelId: string }[];
}

/** El pedido del navegador rearmado, o `undefined` si no tiene la forma que el API acepta. */
export function parseHotelContentBatchRequest(raw: unknown): HotelContentBatchRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { lang, hotels } = raw as { lang?: unknown; hotels?: unknown };
  const language =
    lang === undefined ? 'es' : typeof lang === 'string' ? lang.trim().toLowerCase() : undefined;
  if (!LANGS.includes(language as Lang)) return undefined;
  if (!Array.isArray(hotels) || hotels.length === 0) return undefined;
  if (hotels.length > HOTEL_CONTENT_BATCH_MAX_HOTELS) return undefined;
  const out: { providerCode: string; hotelId: string }[] = [];
  for (const item of hotels) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { providerCode, hotelId } = item as { providerCode?: unknown; hotelId?: unknown };
    if (typeof providerCode !== 'string' || typeof hotelId !== 'string') return undefined;
    if (providerCode.length < 2 || providerCode.length > 40) return undefined;
    if (!PROVIDER_CODE_RE.test(providerCode) || !HOTEL_ID_RE.test(hotelId)) return undefined;
    out.push({ providerCode, hotelId });
  }
  return { lang: language as Lang, hotels: out };
}

export interface HotelContentBatchReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

const INVALID = 'No pudimos pedir las fotos de estos hoteles: la lista no tiene la forma esperada.';

export async function proxyHotelContentBatch(
  req: Request,
  call: ApiCall,
): Promise<HotelContentBatchReply> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: { statusCode: 400, error: 'Bad Request', message: INVALID } };
  }
  const body = parseHotelContentBatchRequest(raw);
  if (body === undefined) {
    return { status: 400, body: { statusCode: 400, error: 'Bad Request', message: INVALID } };
  }
  const res = await call('/hotels/content/batch', { method: 'POST', body: JSON.stringify(body) });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  return { status: res.status, body: { statusCode: res.status, message: res.message } };
}
