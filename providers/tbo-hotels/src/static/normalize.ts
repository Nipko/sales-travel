import type { TboGeoPoint } from './content.types';

/**
 * Normalización de los campos del contenido estático al tipo canónico de docs/tbo/05 §3.
 *
 * Funciones puras y sin lanzar: un dato ilegible vale `null` y el llamador decide qué nota deja.
 * Ninguna "arregla" un dato (una dirección sin separador, un apóstrofe perdido en origen): sólo
 * cambia su forma. Lo que no se puede leer con certeza no se adivina.
 */

// ───────────────────────── Texto ─────────────────────────

/** C0 y C1 salvo tabulador y saltos de línea: un NUL o un ESC en un texto de TBO no se muestran. */
// eslint-disable-next-line no-control-regex -- la clase existe justamente para quitarlos.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Texto de una línea (nombre, dirección, teléfono): espacios, tabuladores, saltos y NBSP colapsan a
 * un espacio. `max` recorta, no rechaza: un nombre largo no vale un hotel fuera del catálogo.
 */
export function normalizeTboText(value: string | number, max: number): string | null {
  const text = String(value).replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text.slice(0, max);
}

/** Quita los caracteres de control de un texto largo sin tocar sus saltos de línea. */
export function stripTboControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

// ───────────────────────── Estrellas ─────────────────────────

/** Enumeración `StarRating` (p. 69-70), comparada sin mayúsculas ni separadores. */
const STAR_WORDS: ReadonlyMap<string, number> = new Map([
  ['onestar', 1],
  ['twostar', 2],
  ['threestar', 3],
  ['fourstar', 4],
  ['fivestar', 5],
]);

export type TboStarsRead =
  | { readonly stars: number; readonly known: true }
  /** `known: true` con `null`: TBO dijo "sin clasificación" (`All`, `0`), no un valor raro. */
  | { readonly stars: null; readonly known: boolean };

function starsFromNumber(value: number): TboStarsRead {
  if (value === 0) return { stars: null, known: true };
  // Medias estrellas sí (`hotel_inventory.stars` es NUMERIC(2,1)); 3,3 no es una clasificación.
  if (Number.isFinite(value) && value >= 1 && value <= 5 && Number.isInteger(value * 2)) {
    return { stars: value, known: true };
  }
  return { stars: null, known: false };
}

/**
 * `HotelRating` → 1-5 (05 §3; CE-02; Q-68): `"ThreeStar"` (TBOHotelCodeList, p. 67) y `5`
 * (HotelDetails, p. 62) valen 3 y 5. `All` y `0` son "sin estrellas"; cualquier otra cosa también,
 * pero se marca como desconocida.
 */
export function normalizeTboStars(value: string | number): TboStarsRead {
  if (typeof value === 'number') return starsFromNumber(value);
  const text = value.trim();
  if (text.length === 0) return { stars: null, known: true };
  if (/^\d+(\.\d+)?$/.test(text)) return starsFromNumber(Number(text));
  const word = text.toLowerCase().replace(/[^a-z]/g, '');
  if (word === 'all') return { stars: null, known: true };
  const stars = STAR_WORDS.get(word);
  return stars === undefined ? { stars: null, known: false } : { stars, known: true };
}

// ───────────────────────── Coordenadas ─────────────────────────

const COORDINATE = /^[-+]?\d{1,3}(?:\.\d+)?$/;

export type TboMapRead =
  | { readonly location: TboGeoPoint; readonly issue?: undefined }
  | { readonly location: null; readonly issue?: 'MAP_INVALID' | 'MAP_ZERO' };

export type TboLatLngRead =
  | { readonly location: TboGeoPoint; readonly issue?: undefined }
  | { readonly location: null; readonly issue?: 'LAT_LNG_INVALID' | 'LAT_LNG_ZERO' };

type PointCheck = 'ok' | 'out-of-range' | 'zero';

/** Rango y `0|0`, igual para `Map` que para `Latitude`/`Longitude`. */
function checkPoint(lat: number, lng: number): PointCheck {
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return 'out-of-range';
  return lat === 0 && lng === 0 ? 'zero' : 'ok';
}

/** Un eje: número finito o string con la forma de `Map`. `undefined` si no es ninguno. */
function readAxis(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = value.trim();
  return COORDINATE.test(text) ? Number(text) : undefined;
}

function isBlank(value: string | number | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().length === 0);
}

/**
 * `Latitude` y `Longitude` de TBOHotelCodeList (sin documentar; producción, 2026-09-29) →
 * `{lat, lng}`, con número o string numérico en cada eje y las mismas reglas que `Map`: rango válido
 * y `0|0` es un dato vacío. Los dos ausentes o vacíos son ausencia, sin nota; uno solo, o uno que no
 * es número, es inválido. El llamador cae a `Map` cuando esto no da un punto.
 */
export function normalizeTboLatLng(
  latitude: string | number | undefined,
  longitude: string | number | undefined,
): TboLatLngRead {
  if (isBlank(latitude) && isBlank(longitude)) return { location: null };
  const lat = latitude === undefined ? undefined : readAxis(latitude);
  const lng = longitude === undefined ? undefined : readAxis(longitude);
  if (lat === undefined || lng === undefined) return { location: null, issue: 'LAT_LNG_INVALID' };
  const check = checkPoint(lat, lng);
  if (check === 'out-of-range') return { location: null, issue: 'LAT_LNG_INVALID' };
  if (check === 'zero') return { location: null, issue: 'LAT_LNG_ZERO' };
  return { location: { lat, lng } };
}

/**
 * `Map` es `"lat|lon"` (p. 62, 69) → `{lat, lng}` con rangos válidos. `"0|0"` no es un hotel en el
 * golfo de Guinea sino un dato vacío (INFERIDO, 05 §3): con él, el centroide de la ciudad y el
 * dedupe por distancia se irían al mar. Un texto vacío es ausencia, no un error.
 */
export function normalizeTboMap(value: string): TboMapRead {
  const text = value.trim();
  if (text.length === 0) return { location: null };
  const parts = text.split('|').map((part) => part.trim());
  const [latText, lngText] = parts;
  if (
    parts.length !== 2 ||
    latText === undefined ||
    lngText === undefined ||
    !COORDINATE.test(latText) ||
    !COORDINATE.test(lngText)
  ) {
    return { location: null, issue: 'MAP_INVALID' };
  }
  const lat = Number(latText);
  const lng = Number(lngText);
  const check = checkPoint(lat, lng);
  if (check === 'out-of-range') return { location: null, issue: 'MAP_INVALID' };
  if (check === 'zero') return { location: null, issue: 'MAP_ZERO' };
  return { location: { lat, lng } };
}

// ───────────────────────── País ─────────────────────────

/**
 * `CountryCode` de un hotel: Integer en la tabla, ISO2 en los ejemplos (`"US"`, `"EG"`; p. 62,
 * 68). Sólo pasa la forma ISO2; con otra cosa el llamador usa el país de la ciudad (05 §3).
 */
export function normalizeTboCountryCode(value: string | number): string | null {
  const code = String(value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

// ───────────────────────── Horarios ─────────────────────────

const CHECK_TIME = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(?:([AaPp])\.?\s*[Mm]\.?)?$/;

/**
 * `CheckInTime` y `CheckOutTime` → `HH:mm` en 24 horas (05 §3): `"3:00 PM"` → `15:00` y
 * `"12:00 PM"` → `12:00` (p. 62). Sin AM/PM hacen falta los minutos: `"3"` a secas es ambiguo.
 */
export function normalizeTboCheckTime(value: string): string | null {
  const match = CHECK_TIME.exec(value.trim());
  if (match === null) return null;
  const [, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (meridiem === undefined) {
    if (minuteText === undefined || hour > 23) return null;
  } else {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ───────────────────────── URLs ─────────────────────────

const MAX_URL_LENGTH = 2_048;

function parseUrl(value: string): URL | undefined {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(text);
    // Una URL con usuario o contraseña embebidos no se reproduce en ninguna pantalla.
    return url.username.length > 0 || url.password.length > 0 ? undefined : url;
  } catch {
    return undefined;
  }
}

/**
 * Imagen: sólo URL absoluta `https` (RNF-16). Una `http://` quedaría bloqueada como contenido mixto
 * en el panel (05 §4) y reescribirla a `https` sería adivinar que el host la sirve. Sale en la forma
 * serializada de `URL`, que escapa comillas y espacios antes de que lleguen a un atributo.
 */
export function normalizeTboImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = parseUrl(value);
  return url?.protocol === 'https:' ? url.href : null;
}

/** Web del hotel: un enlace, no un recurso embebido, así que también `http` (p. 69). */
export function normalizeTboWebsiteUrl(value: string): string | null {
  const url = parseUrl(value);
  return url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:')
    ? url.href
    : null;
}

// ───────────────────────── Listas ─────────────────────────

/**
 * `HotelFacilities` e `Images`: array en los ejemplos (p. 60-62, 68-69), String en la tabla. Si
 * llega un string se parte por comas (INFERIDO, 05 §3). Los elementos que no son texto ni número se
 * devuelven aparte para que el llamador los cuente.
 */
export function toTboTextList(value: string | readonly unknown[]): {
  readonly items: readonly string[];
  readonly dropped: number;
} {
  if (typeof value === 'string') return { items: value.split(','), dropped: 0 };
  const items: string[] = [];
  let dropped = 0;
  for (const item of value) {
    if (typeof item === 'string') items.push(item);
    else if (typeof item === 'number' && Number.isFinite(item)) items.push(String(item));
    else dropped += 1;
  }
  return { items, dropped };
}

/** `Array.isArray` no estrecha un `readonly unknown[]` de una unión: lo deja en `any[]`. */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Clave de `Attractions` de HotelDetails: `"1) "`, `"2) "` (p. 61). */
function leadingNumber(key: string): number | undefined {
  const match = /^\s*(\d+)/.exec(key);
  return match === null ? undefined : Number(match[1]);
}

/**
 * `Attractions` → un único HTML (05 §3; CE-10).
 *
 * - Array (TBOHotelCodeList): es UN HTML cortado en cada coma, y se une con `","`. Lo prueba el
 *   propio ejemplo: los trozos terminan en "New York" y "Teterboro" y siguen con " NY (…)" y
 *   " NJ (TEB)" (p. 67-68).
 * - Objeto (HotelDetails): los valores en el orden numérico de sus claves `"1) "`, `"2) "`; sin
 *   número, en el orden en que llegaron.
 * - String: tal cual.
 *
 * Los trozos que no son texto se descartan y se cuentan.
 */
export function joinTboAttractions(value: string | readonly unknown[] | Record<string, unknown>): {
  readonly html: string;
  readonly dropped: number;
} {
  if (typeof value === 'string') return { html: value, dropped: 0 };
  if (isList(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    return { html: parts.join(','), dropped: value.length - parts.length };
  }
  const entries = Object.entries(value).map(([key, part], position) => ({
    order: leadingNumber(key),
    position,
    part,
  }));
  entries.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.position - b.position,
  );
  const parts = entries
    .map((entry) => entry.part)
    .filter((part): part is string => typeof part === 'string');
  // Cada valor es un bloque entero, no un trozo cortado: un espacio los separa sin pegar palabras.
  return { html: parts.join(' '), dropped: entries.length - parts.length };
}
