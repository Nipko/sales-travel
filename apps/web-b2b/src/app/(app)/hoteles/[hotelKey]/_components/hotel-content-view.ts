/*
 * La ficha de un hotel (`GET /hotels/content/:providerCode/:hotelId`) del lado de la pantalla, sin
 * React: lectura defensiva de la respuesta y el HTML de la descripción convertido en bloques que
 * React pinta como texto (RNF-16).
 *
 * El API ya verifica que el HTML use sólo su lista blanca y que las imágenes sean `https`; aquí se
 * vuelve a comprobar, porque la pantalla no puede depender de que un API de otra versión lo haga.
 * Y el HTML NUNCA se inyecta: se lee etiqueta por etiqueta y se arma con elementos de React, que
 * escapan el texto. Lo que no es de la lista blanca se descarta y su texto queda como texto.
 */

export interface HotelContentSection {
  readonly label: string;
  readonly text: string;
}

export type HotelContentOrigin = 'catalog' | 'provider' | 'none';

/** Espejo de `HotelContentView` del API, ya verificado. */
export interface HotelContent {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly requestedLang: string;
  /** El idioma del texto que vino; `null` sin contenido. Distinto de `requestedLang` = respaldo. */
  readonly lang: string | null;
  readonly origin: HotelContentOrigin;
  readonly name: string | null;
  readonly stars: number | null;
  readonly address: string | null;
  readonly zipcode: string | null;
  readonly countryCode: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly descriptionHtml: string | null;
  readonly sections: readonly HotelContentSection[];
  readonly facilities: readonly string[];
  readonly attractionsHtml: string | null;
  /**
   * Las fotos. Al leer la respuesta, sólo URLs absolutas `https` del proveedor; lo que entrega
   * `hotelContentAction` a la pantalla ya son rutas del proxy propio ({@link withProxiedPhotos}).
   */
  readonly images: readonly string[];
  readonly phone: string | null;
  /** `http` o `https`: es un enlace, no un recurso embebido. */
  readonly websiteUrl: string | null;
  /** `HH:mm`. */
  readonly checkInTime: string | null;
  readonly checkOutTime: string | null;
}

// ───────────────────────── Lectura de la respuesta ─────────────────────────

/** Techos de la pantalla: los mismos del API, para que una respuesta rota no infle la página. */
const MAX_IMAGES = 100;
const MAX_FACILITIES = 300;
const MAX_SECTIONS = 50;

function textOrNull(value: unknown, max = 1_000): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length === 0 || text.length > max ? null : text;
}

function urlOf(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value.trim());
    return url.username || url.password ? undefined : url;
  } catch {
    return undefined;
  }
}

/**
 * Sólo imágenes `https`: una `http` quedaría bloqueada como contenido mixto y un `javascript:` o
 * un `data:` no son fotos de un hotel. Sale serializada por `URL`, sin repetidas.
 */
export function safeImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const url = urlOf(item);
    if (url?.protocol === 'https:' && out.size < MAX_IMAGES) out.add(url.href);
  }
  return [...out];
}

/** El sitio del hotel, sólo `http` o `https`: nunca un esquema que ejecute algo al hacer clic. */
export function safeWebsiteUrl(value: unknown): string | null {
  const url = urlOf(value);
  return url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:')
    ? url.href
    : null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function timeOrNull(value: unknown): string | null {
  return typeof value === 'string' && TIME_RE.test(value) ? value : null;
}

function starsOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5
    ? value
    : null;
}

function locationOrNull(value: unknown): HotelContent['location'] {
  if (typeof value !== 'object' || value === null) return null;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function sectionsOf(value: unknown): HotelContentSection[] {
  if (!Array.isArray(value)) return [];
  const out: HotelContentSection[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { label, text } = item as { label?: unknown; text?: unknown };
    const l = textOrNull(label, 120);
    const t = textOrNull(text, 20_000);
    if (l !== null && t !== null) out.push({ label: l, text: t });
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textOrNull(item, 200))
    .filter((item): item is string => item !== null)
    .slice(0, MAX_FACILITIES);
}

/** El HTML sólo si cumple la lista blanca; si no, nada: mejor sin descripción que con una rota. */
function htmlOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && isAllowlistedHtml(value)
    ? value
    : null;
}

const ORIGINS: readonly HotelContentOrigin[] = ['catalog', 'provider', 'none'];

/**
 * La respuesta del API, verificada campo por campo. `undefined` si ni siquiera es una ficha del
 * hotel pedido: entonces la pantalla dice que no pudo leerla.
 */
export function parseHotelContent(
  value: unknown,
  expected: { readonly provider: string; readonly hotelId: string },
): HotelContent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw['providerCode'] !== expected.provider || raw['hotelId'] !== expected.hotelId) {
    return undefined;
  }
  const origin = ORIGINS.find((o) => o === raw['origin']) ?? 'none';
  return {
    providerCode: expected.provider,
    hotelId: expected.hotelId,
    requestedLang: textOrNull(raw['requestedLang'], 8) ?? 'es',
    lang: textOrNull(raw['lang'], 8),
    origin,
    name: textOrNull(raw['name'], 300),
    stars: starsOrNull(raw['stars']),
    address: textOrNull(raw['address'], 500),
    zipcode: textOrNull(raw['zipcode'], 32),
    countryCode: textOrNull(raw['countryCode'], 2),
    location: locationOrNull(raw['location']),
    descriptionHtml: htmlOrNull(raw['descriptionHtml']),
    sections: sectionsOf(raw['sections']),
    facilities: stringsOf(raw['facilities']),
    attractionsHtml: htmlOrNull(raw['attractionsHtml']),
    images: safeImageUrls(raw['images']),
    phone: textOrNull(raw['phone'], 64),
    websiteUrl: safeWebsiteUrl(raw['websiteUrl']),
    checkInTime: timeOrNull(raw['checkInTime']),
    checkOutTime: timeOrNull(raw['checkOutTime']),
  };
}

/**
 * La ficha con sus fotos como rutas del proxy propio del panel (`/api/hotels/images/…`), en el
 * orden del proveedor y sin repetidas. Se hace en el servidor (la acción), así la URL del proveedor
 * no viaja al navegador: ni el del vendedor ni el de un cliente le piden nada al host de fotos del
 * proveedor, y la marca blanca no lo muestra. Una foto que el proxy no serviría (otro dominio) no
 * entra: el panel no pinta fotos de terceros por fuera del proxy (CSP `img-src 'self'`).
 */
export function withProxiedPhotos(
  content: HotelContent,
  toProxyPath: (src: string) => string | undefined,
): HotelContent {
  const photos = new Set<string>();
  for (const src of content.images) {
    const path = toProxyPath(src);
    if (path !== undefined) photos.add(path);
  }
  return { ...content, images: [...photos] };
}

// ───────────────────────── HTML de la lista blanca ─────────────────────────

/**
 * La gramática de salida del saneador del ACL: `p`, `br`, `b`, `ul` y `li` sin atributos, y las
 * cinco entidades con que escapa el texto. La misma comprobación que hace el API al servirlo.
 */
const ALLOWED_MARKUP = /<\/?(?:p|b|ul|li)>|<br>|&(?:amp|lt|gt|quot|#39);/g;
const FORBIDDEN_IN_TEXT = /[<>"'&]/;

export function isAllowlistedHtml(html: string): boolean {
  return !FORBIDDEN_IN_TEXT.test(html.replace(ALLOWED_MARKUP, ''));
}

export type RichInline =
  | { readonly kind: 'text'; readonly text: string; readonly bold: boolean }
  | { readonly kind: 'break' };

export type RichBlock =
  | { readonly kind: 'paragraph'; readonly inlines: readonly RichInline[] }
  | { readonly kind: 'list'; readonly items: readonly (readonly RichInline[])[] };

const ENTITIES: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

/** Una sola pasada: un `&amp;lt;` es el texto `&lt;`, no un `<`. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Recorta los saltos y espacios de los bordes de un bloque: sin ellos no cambia lo que se lee. */
function trimInlines(inlines: RichInline[]): RichInline[] {
  const out = [...inlines];
  const blank = (i: RichInline | undefined) =>
    i !== undefined && (i.kind === 'break' || i.text.trim() === '');
  while (blank(out[0])) out.shift();
  while (blank(out[out.length - 1])) out.pop();
  const first = out[0];
  if (first?.kind === 'text') out[0] = { ...first, text: first.text.trimStart() };
  const last = out[out.length - 1];
  if (last?.kind === 'text') out[out.length - 1] = { ...last, text: last.text.trimEnd() };
  return out;
}

/**
 * El HTML saneado de la ficha como bloques de texto: párrafos y listas con negritas y saltos.
 * Nunca se inyecta como HTML. Una etiqueta fuera de la lista blanca no entra —si llegara, sólo
 * queda su texto—, las listas anidadas se aplanan y el texto suelto va en su propio párrafo.
 */
export function parseRichText(html: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  let inlines: RichInline[] = [];
  let items: RichInline[][] | undefined;
  let bold = false;

  const flushInlines = () => {
    const trimmed = trimInlines(inlines);
    inlines = [];
    if (trimmed.length === 0) return;
    if (items !== undefined) items.push(trimmed);
    else blocks.push({ kind: 'paragraph', inlines: trimmed });
  };
  const closeList = () => {
    flushInlines();
    if (items !== undefined && items.length > 0) blocks.push({ kind: 'list', items });
    items = undefined;
  };

  for (const match of html.matchAll(/<\/?[a-zA-Z][^<>]*>|[^<]+|</g)) {
    const token = match[0];
    const tag = /^<(\/?)([a-zA-Z]+)[^<>]*>$/.exec(token);
    if (tag === null) {
      const text = decodeEntities(token).replace(/\s+/g, ' ');
      if (text.trim() !== '' || inlines.length > 0) inlines.push({ kind: 'text', text, bold });
      continue;
    }
    const closing = tag[1] === '/';
    switch (tag[2]?.toLowerCase()) {
      case 'p':
        // Un párrafo dentro de una viñeta sigue siendo esa viñeta.
        if (items === undefined) flushInlines();
        break;
      case 'br':
        inlines.push({ kind: 'break' });
        break;
      case 'b':
        bold = !closing;
        break;
      case 'ul':
        if (closing) closeList();
        else if (items === undefined) {
          flushInlines();
          items = [];
        }
        break;
      case 'li':
        if (items === undefined) {
          flushInlines();
          items = [];
        }
        flushInlines();
        break;
      default:
        break;
    }
  }
  closeList();
  return blocks;
}

// ───────────────────────── Presentación ─────────────────────────

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'inglés',
  es: 'español',
  pt: 'portugués',
};

/** El aviso de idioma cuando el texto vino en otro, o nada. */
export function contentLanguageNote(
  content: Pick<HotelContent, 'lang' | 'requestedLang'>,
): string | undefined {
  if (content.lang === null || content.lang === content.requestedLang) return undefined;
  const name = LANGUAGE_NAMES[content.lang] ?? content.lang;
  return `La descripción de este hotel está disponible sólo en ${name}.`;
}

/**
 * Las secciones que el vendedor tiene que ver antes de vender: depósito, documento o cargo por
 * persona extra van en "CheckIn Instructions" (docs/tbo/05 §4) y se leen junto a los horarios.
 */
const ARRIVAL_SECTION_RE = /check[\s-]?in|special instructions|instrucciones/i;

export function splitSections(sections: readonly HotelContentSection[]): {
  arrival: HotelContentSection[];
  other: HotelContentSection[];
} {
  const arrival: HotelContentSection[] = [];
  const other: HotelContentSection[] = [];
  for (const s of sections) (ARRIVAL_SECTION_RE.test(s.label) ? arrival : other).push(s);
  return { arrival, other };
}

/** Hay algo que contar del hotel además de su nombre: fotos, descripción, servicios o alrededores. */
export function hasDescriptiveContent(content: HotelContent): boolean {
  return (
    content.images.length > 0 ||
    content.descriptionHtml !== null ||
    content.sections.length > 0 ||
    content.facilities.length > 0 ||
    content.attractionsHtml !== null
  );
}

/** Horarios o instrucciones de llegada. */
export function hasArrivalInfo(content: HotelContent): boolean {
  return (
    content.checkInTime !== null ||
    content.checkOutTime !== null ||
    splitSections(content.sections).arrival.length > 0
  );
}

export function hasContactInfo(content: HotelContent): boolean {
  return content.phone !== null || content.websiteUrl !== null;
}

/** Enlace a un mapa externo con las coordenadas del hotel; se abre aparte, no se embebe. */
export function mapsUrl(location: { readonly lat: number; readonly lng: number }): string {
  const q = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Dirección en una línea, con el código postal si no está ya en ella. */
export function addressLine(content: Pick<HotelContent, 'address' | 'zipcode'>): string | null {
  const address = content.address;
  const zip = content.zipcode;
  if (address === null) return zip;
  return zip !== null && !address.includes(zip) ? `${address} (${zip})` : address;
}
