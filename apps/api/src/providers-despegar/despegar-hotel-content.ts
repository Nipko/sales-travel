import { createHash } from 'node:crypto';
import type {
  DespegarHotelContent,
  DespegarRoomTypeContent,
  LocalizedText,
} from '@sales-travel/despegar-hotels';
import type {
  HotelContentLanguage,
  HotelContentRecord,
  HotelProviderContent,
  HotelProviderRoomContent,
} from '../providers/hotel-provider.types.js';

/**
 * El contenido estático de Despegar (`/content-api/hotels`) en los contratos neutrales: la fila de
 * `hotel_content` (fotos de los resultados y ficha) y las habitaciones de `hotel_room_content`
 * (fotos por habitación). Funciones puras: el adaptador sólo pide y entrega.
 */

/**
 * Dominios desde los que Despegar sirve las fotos (CDN `media.staticontent.com`). La documentación
 * no publica ejemplos de URL: si aparece otro dominio en `hotel_content.images`, se agrega aquí.
 */
export const DESPEGAR_IMAGE_HOSTS: readonly string[] = Object.freeze([
  'staticontent.com',
  'despegar.com',
]);

/** Hoteles por llamada a `/content-api/hotels` (la API acepta hasta 100). */
export const DESPEGAR_CONTENT_BATCH_SIZE = 50;

const ROOM_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ROOM_NAME = 300;
const CONTENT_HASH_VERSION = 'despegar-content-v1';

export const toDespegarLanguage = (lang: HotelContentLanguage): 'EN' | 'ES' | 'PT' =>
  lang === 'en' ? 'EN' : lang === 'pt' ? 'PT' : 'ES';

/** El texto en el idioma pedido; si falta, en español o inglés antes que nada. */
function textIn(text: LocalizedText, lang: HotelContentLanguage): string | null {
  return text[lang] ?? text.es ?? text.en ?? text.pt ?? null;
}

/** Texto plano: el contrato no recibe marcado de Despegar. */
function plain(text: string | null): string | null {
  if (text === null) return null;
  const out = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out === '' ? null : out;
}

/** `"14:00:00"`, `"2:00 PM"`… → `HH:mm`; otra cosa, `null`. */
export function hhmm(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(raw.trim());
  if (m === null) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** El nombre de habitación normalizado como `normalizeRoomName` de la web. */
export function roomNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Las entidades que trae el texto de Despegar, a su carácter: luego se escapan una sola vez. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&(#39|apos);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d{1,6});/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}

/**
 * La descripción va a `descriptionHtml`, que la base valida (`hotel_catalog_html_ok`): fuera de
 * `<p><b><ul><li><br>` no admite `< > " ' &` sin escapar. «Bar & Grill», «hotel's» o un `&nbsp;`
 * rechazaban la fila entera (`hotels.content_batch.filas_rechazadas`) y el hotel se quedaba sin
 * descripción ni fotos de ese lote.
 */
function htmlText(text: string | null): string | null {
  const flat = plain(text);
  if (flat === null) return null;
  const out = decodeEntities(flat)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return out === '' ? null : out;
}

function descriptionOf(c: DespegarHotelContent, lang: HotelContentLanguage): string | null {
  return htmlText(textIn(c.information, lang));
}

export function despegarProviderContent(
  c: DespegarHotelContent,
  lang: HotelContentLanguage,
): HotelProviderContent {
  return {
    hotelId: c.id,
    lang,
    name: c.name ?? null,
    stars: c.stars ?? null,
    address: c.address ?? null,
    zipcode: c.zipcode ?? null,
    countryCode: null,
    location: c.location ?? null,
    descriptionHtml: descriptionOf(c, lang),
    sections: [],
    facilities: [],
    attractionsHtml: null,
    images: [...c.pictures],
    phone: c.phones[0] ?? null,
    websiteUrl: null,
    checkInTime: hhmm(c.checkInFrom),
    checkOutTime: hhmm(c.checkOutTo),
  };
}

export function despegarContentRecord(
  c: DespegarHotelContent,
  lang: HotelContentLanguage,
): HotelContentRecord {
  const view = despegarProviderContent(c, lang);
  const hashed = {
    name: view.name,
    descriptionHtml: view.descriptionHtml,
    sections: view.sections,
    facilities: view.facilities,
    attractionsHtml: view.attractionsHtml,
    images: view.images,
    phone: view.phone,
    websiteUrl: view.websiteUrl,
    checkInTime: view.checkInTime,
    checkOutTime: view.checkOutTime,
  };
  return {
    hotelId: c.id,
    lang,
    source: 'details',
    ...hashed,
    contentHash: createHash('sha256')
      .update(JSON.stringify([CONTENT_HASH_VERSION, hashed]), 'utf8')
      .digest('hex'),
  };
}

export function despegarRoomContent(
  room: DespegarRoomTypeContent,
  lang: HotelContentLanguage,
): HotelProviderRoomContent | undefined {
  const name = (plain(textIn(room.name, lang)) ?? '').slice(0, MAX_ROOM_NAME);
  const nameKey = roomNameKey(name);
  const roomKey = ROOM_KEY.test(room.id) && room.id !== '0' ? room.id : undefined;
  if (roomKey === undefined) return undefined;
  return {
    roomKey,
    roomRef: room.id,
    nameKey,
    name,
    sizeText: null,
    description: plain(textIn(room.description, lang)),
    images: [...room.pictures],
  };
}
