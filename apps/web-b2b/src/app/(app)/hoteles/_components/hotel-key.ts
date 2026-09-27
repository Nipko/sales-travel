import type { HotelOffer } from '../actions';

/*
 * La clave de un hotel en la URL del detalle (`/hoteles/<clave>`).
 *
 * Dice con qué id conoce al hotel CADA proveedor que lo vende: la ficha y las tarifas se piden por
 * proveedor, y una tarjeta agrupada (RF-34) reúne el mismo hotel de varios. Va codificada y no en
 * claro porque la barra de direcciones es algo que el vendedor ve y copia en un WhatsApp: con la
 * divulgación en "Ocultar", `tbo-hotels` en la URL diría lo que la pastilla calla (RF-40). No es
 * una barrera de seguridad —el API manda `provider.name` en cada tarifa, por diseño—, es la misma
 * regla de presentación.
 */

/** Con qué id conoce un proveedor al hotel. Espejo de `HotelProviderHotel` del contrato neutral. */
export interface HotelProviderHotelRef {
  readonly provider: string;
  readonly hotelId: string;
}

/** Los mismos formatos que valida el API: la clave no puede llevar algo que la ruta rechace. */
const PROVIDER_CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HOTEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Una tarjeta reúne un hotel por proveedor; más que esto no es una clave nuestra. */
export const MAX_HOTEL_KEY_PROVIDERS = 4;
const SEPARATOR = '~';

function isRef(ref: HotelProviderHotelRef): boolean {
  return (
    ref.provider.length >= 2 &&
    ref.provider.length <= 40 &&
    PROVIDER_CODE_RE.test(ref.provider) &&
    HOTEL_ID_RE.test(ref.hotelId)
  );
}

function isValidList(refs: readonly HotelProviderHotelRef[]): boolean {
  if (refs.length === 0 || refs.length > MAX_HOTEL_KEY_PROVIDERS) return false;
  const providers = new Set(refs.map((r) => r.provider));
  return providers.size === refs.length && refs.every(isRef);
}

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(key: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return undefined;
  const padded = key.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return undefined;
  }
}

/** La clave de la URL, o `undefined` si la lista no es válida: sin clave no hay enlace. */
export function encodeHotelKey(refs: readonly HotelProviderHotelRef[]): string | undefined {
  if (!isValidList(refs)) return undefined;
  return toBase64Url(refs.map((r) => `${r.provider}${SEPARATOR}${r.hotelId}`).join(SEPARATOR));
}

/**
 * Los hoteles de una clave, en su orden: el primero es el que puso nombre y fotos en la tarjeta.
 * `undefined` ante cualquier cosa que no sea una clave nuestra: nada de adivinar.
 */
export function decodeHotelKey(key: string): HotelProviderHotelRef[] | undefined {
  const raw = fromBase64Url(key);
  if (raw === undefined || raw.length === 0) return undefined;
  const parts = raw.split(SEPARATOR);
  if (parts.length % 2 !== 0) return undefined;
  const refs: HotelProviderHotelRef[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    refs.push({ provider: parts[i] ?? '', hotelId: parts[i + 1] ?? '' });
  }
  return isValidList(refs) ? refs : undefined;
}

/**
 * Con qué id conoce cada proveedor al hotel de una tarjeta. Agrupada, lo dice `providerHotels`;
 * de un solo proveedor, el de sus tarifas. Sin detalle —lista vacía— si las tarifas no dicen de
 * dónde son (un API anterior a la búsqueda multi-proveedor) o dicen dos proveedores sin
 * `providerHotels`: no se sabría con qué id pedírselo a cada uno.
 */
export function hotelRefsOf(
  offer: Pick<HotelOffer, 'hotelId' | 'roompacks' | 'providerHotels'>,
): HotelProviderHotelRef[] {
  if (offer.providerHotels !== undefined && offer.providerHotels.length > 0) {
    return offer.providerHotels.map((h) => ({ provider: h.provider, hotelId: h.hotelId }));
  }
  const providers = new Set(
    offer.roompacks.map((p) => p.provider?.name).filter((name): name is string => !!name),
  );
  const [provider] = providers;
  return providers.size === 1 && provider !== undefined
    ? [{ provider, hotelId: offer.hotelId }]
    : [];
}
