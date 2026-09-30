import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import { z } from '@sales-travel/validation';
import { DatabaseService } from '../database/database.service.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelContent,
  supportsHotelContentBatch,
  type HotelContentBatch,
  type HotelContentLanguage,
  type HotelContentRecord,
  type HotelContentSection,
  type HotelProviderContent,
  type HotelProviderRegistration,
} from '../providers/hotel-provider.types.js';
import { ProviderNotAvailableError } from '../providers/provider.types.js';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { HotelCatalogStore, hotelRefKey, type HotelRef } from './hotel-catalog.store.js';
import { SlidingWindowBudget } from './hotel-content-budget.js';
import { pickMainImages, type HotelMainImage } from './hotel-image-proxy.js';
import { UnknownHotelProviderError } from './hotel-provider-errors.js';
import { catalogFactsOf } from './hotel-search.aggregate.js';

/**
 * Contenido de un hotel para su ficha: descripción, servicios, imágenes, horarios (docs/tbo/09
 * PR-3.6; 05 §4 y §6.3; 08 RF-32 y RNF-16).
 *
 * - **La ficha lee `hotel_content`, no lo escribe**: lo que trae del proveedor para UN hotel queda
 *   en la caché propia. Quien escribe el catálogo desde el API es el contenido por lote de los
 *   resultados ({@link HotelContentService.getContentBatch}), por la función de 0054 y con la huella
 *   del ACL, la misma del sync: dos escritores, una sola regla.
 * - **Respaldo en inglés.** Sin contenido en el idioma pedido sale el inglés, y la respuesta dice en
 *   qué idioma vino (`lang` contra `requestedLang`, y `langFallback`). Es el idioma en que llega el
 *   texto del listado de ciudad y el único que TBO tuvo para los hoteles de Colombia el 2026-09-30
 *   (05 §6.3 y CE-23). Las fotos no dependen del idioma: salen de la fila que las tenga.
 * - **Bajo demanda.** Sin contenido de detalle en el idioma pedido, a un proveedor que lo sabe dar
 *   (TBO `HotelDetails`) se le pide ese solo hotel con un plazo corto, por su circuito y con la
 *   cuenta que la agencia tiene habilitada, y lo que responde se guarda un rato en un `CachePort`
 *   propio. Si responde sin contenido y el catálogo no tiene el detalle en inglés, se le pide el
 *   inglés dentro del MISMO plazo. Si falla, la ficha sale con lo que haya en el catálogo: nunca con
 *   un error.
 * - **Sin contenido no es un error.** La ficha sale con lo que diga `hotel_inventory` (nombre,
 *   dirección, estrellas), sin imágenes ni descripción, y `origin: 'none'`.
 * - **Sólo HTML de la lista blanca e imágenes `https`**, vengan del catálogo o del proveedor. El
 *   saneo es del ACL al ingerir; aquí se VERIFICA con la gramática de su salida y lo que no la
 *   cumple no sale. Un HTML que alguien escribió a mano en la tabla, o un ACL futuro que amplíe su
 *   lista sin que la web lo sepa, no llega al `dangerouslySetInnerHTML` de nadie.
 *
 * El contenido es catálogo de PLATAFORMA (05 §11), igual que `hotel_content`: la caché no es por
 * tenant. Lo que sí es por tenant es salir al proveedor, que respeta el flag de `opt-in` y la cuenta
 * del registry como cualquier venta. Lo único que es de la CUENTA del proveedor es lo que ella
 * confirmó sin contenido (una semana, por idioma): se consulta con la cuenta ya resuelta, así lo que
 * contestó una cuenta no deja sin fotos a otra. Leer el contenido no es un cambio de negocio: no
 * emite eventos.
 */

/** Token DI del `CachePort` del contenido: una instancia propia, que no desaloja contextos. */
export const HOTEL_CONTENT_CACHE = 'HOTEL_CONTENT_CACHE';

/**
 * Token DI del `CachePort` de los hoteles confirmados sin contenido (una semana): otra instancia,
 * para que el ir y venir de las fichas (6 h) y de los negativos cortos no los desaloje primero —la
 * caché en memoria descarta por orden de llegada cuando se llena—. Sin él, la del contenido.
 */
export const HOTEL_CONTENT_NONE_CACHE = 'HOTEL_CONTENT_NONE_CACHE';

/** El idioma del texto del listado de ciudad (05 §6.3) y el del respaldo. */
export const HOTEL_CONTENT_FALLBACK_LANG: HotelContentLanguage = 'en';

/**
 * Plazo TOTAL de la lectura en el proveedor, cola del limitador incluida. La ficha se pinta con lo
 * que haya sin esperar más: el contenido acompaña a las tarifas, no las bloquea (principio 1).
 */
export const HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS = 6_000;

/**
 * Cuánto vale lo que respondió el proveedor. El contenido de un hotel cambia poco y el sync lo
 * termina escribiendo; una respuesta sin el hotel dice que el código no tiene contenido; un fallo se
 * recuerda poco, para que una ficha abierta diez veces no espere diez veces al proveedor caído.
 */
export const HOTEL_CONTENT_CACHE_TTL_S = Object.freeze({
  found: 6 * 60 * 60,
  empty: 60 * 60,
  failed: 2 * 60,
});

const KEY_PREFIX = 'hotels:content';
const BATCH_KEY_PREFIX = 'hotels:content-batch';
const NO_CONTENT_KEY_PREFIX = 'hotels:content-none';

/** Hoteles por petición del contenido por lote: una pantalla de resultados, de a tandas. */
export const HOTEL_CONTENT_BATCH_MAX_HOTELS = 24;

/**
 * Hoteles que UNA petición manda a buscar al proveedor, como mucho: dos lotes de HotelDetails. El
 * resto sale `pending` y la web los vuelve a pedir; así una pantalla con muchos hoteles sin foto no
 * encola de golpe decenas de llamadas en el cupo de la cuenta.
 */
export const HOTEL_CONTENT_BATCH_MAX_FETCH = 20;

/**
 * Cuánto espera la respuesta a que el proveedor conteste. Nadie espera mirando —las fotos llegan en
 * segundo plano—, pero una petición colgada ocupa una conexión del navegador. Lo que no llegó sale
 * `pending` y la llamada al proveedor SIGUE: lo que traiga se guarda y la próxima petición lo lee.
 */
export const HOTEL_CONTENT_BATCH_WAIT_MS = 9_000;

/** Plazo de cada lote en el proveedor, cola del limitador incluida. */
export const HOTEL_CONTENT_BATCH_FETCH_TIMEOUT_MS = 25_000;

/** Cuándo conviene volver a preguntar por lo que quedó `pending`. */
export const HOTEL_CONTENT_BATCH_RETRY_AFTER_MS = 3_000;

/**
 * Cuánto se recuerda lo que un lote no pudo dar: sin esto, cada pantalla de resultados volvería a
 * pedir los mismos hoteles.
 *
 * - `none`: el proveedor CONFIRMÓ que no tiene contenido del hotel en el idioma pedido y en el de
 *   respaldo. Se recuerda una semana POR CUENTA del proveedor y POR IDIOMA confirmado (el pedido y
 *   `en`): lo que contestó una cuenta no frena a otra, y un pedido en inglés o en portugués no dice
 *   nada del español. Un hotel se deja de pedir en un idioma cuando están confirmados ése y `en`.
 * - `empty`: el proveedor lo devolvió pero la base rechazó su fila, o respondió sin él sin
 *   confirmar que no lo tiene (p. ej. el idioma pedido sólo llegó en un lote vacío entero).
 * - `deferred`: quedó sin respuesta (tope o cupo de llamadas extra, una llamada extra que falló).
 * - `failed`: el lote entero falló.
 *
 * En la caché en memoria del proceso: un deploy la vacía y esos hoteles se vuelven a pedir una vez.
 * La de `none` es una instancia aparte ({@link HOTEL_CONTENT_NONE_CACHE}), pero también descarta lo
 * más viejo si llega a su techo de entradas.
 */
export const HOTEL_CONTENT_BATCH_CACHE_TTL_S = Object.freeze({
  none: 7 * 24 * 60 * 60,
  empty: 6 * 60 * 60,
  deferred: 2 * 60,
  failed: 2 * 60,
});

/**
 * Llamadas EXTRA por cuenta del proveedor y por minuto, en todo el proceso: las que parten un lote
 * que el proveedor contestó vacío entero (05 CE-23). Cada lote tiene además su propio tope en el
 * ACL. Van por el cupo de fondo de la cuenta (TBO: 1 por segundo), el mismo de la ficha bajo demanda
 * y de las lecturas de post-venta: 12 por minuto es a lo sumo un 20 % de ese cupo. El respaldo en
 * inglés (una llamada por lote) no cuenta aquí: es parte de pedir el lote, y sin él no hay fotos.
 */
export const HOTEL_CONTENT_EXTRA_CALLS_PER_MINUTE = 12;

/**
 * Qué pasa con las fotos de un hotel:
 *
 * - `ready`: hay foto y sale en `mainImage`.
 * - `pending`: se está trayendo del proveedor (o quedó para la próxima tanda): volver a pedir.
 * - `none`: no hay foto que mostrar por ahora (el proveedor no la tiene, no se le puede pedir o falló
 *   hace poco). La tarjeta muestra el marcador de "sin foto"; no hay que insistir.
 */
export type HotelContentBatchStatus = 'ready' | 'pending' | 'none';

export interface HotelContentBatchRequest {
  readonly lang: HotelContentLanguage;
  readonly hotels: readonly HotelRef[];
}

export interface HotelContentBatchItem {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly status: HotelContentBatchStatus;
  /** La foto principal por el proxy propio (`/api/hotels/images/…`); `null` si no hay. */
  readonly mainImage: HotelMainImage | null;
  /** Cuántas fotos tiene el contenido del que sale la principal. */
  readonly imageCount: number;
}

export interface HotelContentBatchView {
  readonly lang: HotelContentLanguage;
  readonly items: readonly HotelContentBatchItem[];
  /** Presente si algún hotel quedó `pending`: en cuántos ms conviene volver a preguntar. */
  readonly retryAfterMs?: number;
}

const BatchNegativeSchema = z.enum(['empty', 'deferred', 'failed']);
type BatchNegative = z.infer<typeof BatchNegativeSchema>;

/** El valor de la clave de un hotel confirmado sin contenido en un idioma, con una cuenta. */
const NO_CONTENT = 'none';

/** La cuenta de un proveedor que no declara `accountRef`: todas sus llamadas son de la misma. */
const NO_ACCOUNT_REF = '-';

/** Por debajo de esto no se sale a pedir el respaldo bajo demanda: no llegaría. */
const ON_DEMAND_MIN_REMAINING_MS = 1_000;

/** Techos de lo que sale: una ficha no necesita más, y una fila rota no infla la respuesta. */
const MAX_IMAGES = 100;
const MAX_SECTIONS = 50;
const MAX_FACILITIES = 300;
const MAX_URL_LENGTH = 2_048;
const MAX_TEXT_LENGTH = 1_000;

/** De dónde salió el contenido de la ficha. */
export type HotelContentOrigin = 'catalog' | 'provider' | 'none';

export interface HotelContentRequest {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly lang: HotelContentLanguage;
}

/**
 * La ficha de un hotel de UN proveedor. Nombre y dirección son los del proveedor nombrado en la
 * ruta, que es el que vende la tarifa (05 §4, invariante de reserva).
 */
export interface HotelContentView {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly requestedLang: HotelContentLanguage;
  /** El del contenido que sale; `null` sin contenido. Distinto de `requestedLang` = respaldo. */
  readonly lang: HotelContentLanguage | null;
  /**
   * El texto vino en otro idioma que el pedido (hoy, el respaldo en inglés): la UI decide si lo
   * dice. `false` sin contenido.
   */
  readonly langFallback: boolean;
  readonly origin: HotelContentOrigin;
  readonly name: string | null;
  readonly stars: number | null;
  readonly address: string | null;
  readonly zipcode: string | null;
  readonly countryCode: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  /** Sólo `p`, `br`, `b`, `ul` y `li`, sin atributos, y texto escapado. */
  readonly descriptionHtml: string | null;
  /** Texto plano: se escapa al pintar. */
  readonly sections: readonly HotelContentSection[];
  readonly facilities: readonly string[];
  readonly attractionsHtml: string | null;
  /** URLs absolutas `https`. */
  readonly images: readonly string[];
  readonly phone: string | null;
  /** `http` o `https`: es un enlace, no un recurso embebido. */
  readonly websiteUrl: string | null;
  /** `HH:mm`. */
  readonly checkInTime: string | null;
  readonly checkOutTime: string | null;
}

type HotelFacts = Pick<
  HotelContentView,
  'name' | 'stars' | 'address' | 'zipcode' | 'countryCode' | 'location'
>;

type ContentBody = Pick<
  HotelContentView,
  | 'descriptionHtml'
  | 'sections'
  | 'facilities'
  | 'attractionsHtml'
  | 'images'
  | 'phone'
  | 'websiteUrl'
  | 'checkInTime'
  | 'checkOutTime'
> & {
  readonly lang: HotelContentLanguage;
  readonly name: string | null;
};

interface Chosen {
  readonly origin: Exclude<HotelContentOrigin, 'none'>;
  readonly body: ContentBody;
  readonly facts?: HotelFacts;
}

/** Lo que se descartó al verificar, para contarlo en el log sin volcar el contenido. */
interface Dropped {
  html: number;
  images: number;
  website: number;
}

/** Contenido de cualquier origen con los nombres de campo del contrato, antes de verificar. */
interface RawContent {
  readonly name: unknown;
  readonly descriptionHtml: unknown;
  readonly sections: unknown;
  readonly facilities: unknown;
  readonly attractionsHtml: unknown;
  readonly images: unknown;
  readonly phone: unknown;
  readonly websiteUrl: unknown;
  readonly checkInTime: unknown;
  readonly checkOutTime: unknown;
}

const NO_FACTS: HotelFacts = Object.freeze({
  name: null,
  stars: null,
  address: null,
  zipcode: null,
  countryCode: null,
  location: null,
});

/**
 * Lo que guarda la caché. Se valida al leer, como el contexto de búsqueda: el día que viva en Redis,
 * un valor de otra versión no llega a la ficha. El contenido se vuelve a verificar al salir.
 */
const CachedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), content: z.record(z.unknown()) }),
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('failed') }),
]);
type Cached = z.infer<typeof CachedSchema>;

// ───────────────────────── Verificación (RNF-16) ─────────────────────────

/**
 * La gramática de salida del saneador del ACL: sus cinco etiquetas, sin atributos, y las cinco
 * entidades con que escapa el texto. Quitadas esas, no puede quedar ningún `<`, `>`, comilla ni
 * `&`. Es una comprobación lineal, sin retroceso: la API comparte el hilo con las ventas.
 */
const ALLOWED_MARKUP = /<\/?(?:p|b|ul|li)>|<br>|&(?:amp|lt|gt|quot|#39);/g;
const FORBIDDEN_IN_TEXT = /[<>"'&]/;

/** El HTML sólo usa la lista blanca: `p`, `br`, `b`, `ul` y `li`, sin atributos, y texto escapado. */
export function isAllowlistedHtml(html: string): boolean {
  return !FORBIDDEN_IN_TEXT.test(html.replace(ALLOWED_MARKUP, ''));
}

function textOf(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length === 0 || text.length > max ? null : text;
}

function htmlOf(value: unknown, dropped: Dropped): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  if (isAllowlistedHtml(value)) return value;
  dropped.html += 1;
  return null;
}

/** Una URL absoluta sin usuario ni contraseña embebidos, o `undefined`. */
function urlOf(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(text);
    return url.username.length > 0 || url.password.length > 0 ? undefined : url;
  } catch {
    return undefined;
  }
}

/**
 * Sólo `https`: una `http` quedaría bloqueada como contenido mixto en el panel (05 §4), y
 * reescribirla sería adivinar que el host la sirve. Sale serializada por `URL`, que escapa
 * comillas y espacios antes de que lleguen a un atributo.
 */
function imagesOf(value: unknown, dropped: Dropped): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const url = urlOf(item);
    if (url?.protocol !== 'https:') {
      dropped.images += 1;
      continue;
    }
    if (out.size < MAX_IMAGES) out.add(url.href);
  }
  return [...out];
}

function websiteOf(value: unknown, dropped: Dropped): string | null {
  if (value === null || value === undefined) return null;
  const url = urlOf(value);
  if (url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:')) return url.href;
  dropped.website += 1;
  return null;
}

function sectionsOf(value: unknown): HotelContentSection[] {
  if (!Array.isArray(value)) return [];
  const out: HotelContentSection[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { label, text } = item as { label?: unknown; text?: unknown };
    const l = textOf(label, 120);
    const t = textOf(text, 20_000);
    if (l !== null && t !== null) out.push({ label: l, text: t });
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textOf(item, 200))
    .filter((item): item is string => item !== null)
    .slice(0, MAX_FACILITIES);
}

/** `TIME` de Postgres (`'15:00:00'`) o `HH:mm` del proveedor → `HH:mm`. */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

function timeOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = TIME.exec(value.trim());
  return match === null ? null : `${match[1]}:${match[2]}`;
}

function bodyOf(raw: RawContent, lang: HotelContentLanguage, dropped: Dropped): ContentBody {
  return {
    lang,
    name: textOf(raw.name, 300),
    descriptionHtml: htmlOf(raw.descriptionHtml, dropped),
    sections: sectionsOf(raw.sections),
    facilities: stringsOf(raw.facilities),
    attractionsHtml: htmlOf(raw.attractionsHtml, dropped),
    images: imagesOf(raw.images, dropped),
    phone: textOf(raw.phone, 64),
    websiteUrl: websiteOf(raw.websiteUrl, dropped),
    checkInTime: timeOf(raw.checkInTime),
    checkOutTime: timeOf(raw.checkOutTime),
  };
}

function countryOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Nombre, estrellas, dirección y ubicación, validados con la misma regla que la tarjeta del
 * listado (`catalogFactsOf`): un dato que no cumple el contrato de la oferta no sale.
 */
function factsOf(
  hotelId: string,
  row: {
    readonly name: unknown;
    readonly stars: unknown;
    readonly address: unknown;
    readonly zipcode: unknown;
    readonly countryCode: unknown;
    readonly latitude: unknown;
    readonly longitude: unknown;
  },
): HotelFacts {
  const facts = catalogFactsOf({
    hotel_id: hotelId,
    name: stringOrNull(row.name),
    // NUMERIC llega como texto de la base y como número del proveedor.
    stars: numberOrNull(row.stars) ?? stringOrNull(row.stars),
    address: stringOrNull(row.address),
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
  });
  return {
    ...NO_FACTS,
    ...facts,
    zipcode: textOf(row.zipcode, 32),
    countryCode: countryOf(row.countryCode),
  };
}

/** Cada dato de `primary`, y de `secondary` sólo donde `primary` no lo tiene. */
function mergeFacts(primary: HotelFacts, secondary: HotelFacts | undefined): HotelFacts {
  if (secondary === undefined) return primary;
  return {
    name: primary.name ?? secondary.name,
    stars: primary.stars ?? secondary.stars,
    address: primary.address ?? secondary.address,
    zipcode: primary.zipcode ?? secondary.zipcode,
    countryCode: primary.countryCode ?? secondary.countryCode,
    location: primary.location ?? secondary.location,
  };
}

/** Sólo el nombre de la clase: el mensaje de un error de transporte puede citar la URL de la cuenta. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

// ───────────────────────── Servicio ─────────────────────────

/** Una fila de `hotel_content` tal como la devuelve `pg`: JSONB ya parseado, `TIME` como texto. */
interface ContentRow {
  readonly lang: string;
  readonly source: string;
  readonly name: string | null;
  readonly description_html: string | null;
  readonly sections: unknown;
  readonly facilities: unknown;
  readonly attractions_html: string | null;
  readonly images: unknown;
  readonly phone: string | null;
  readonly website_url: string | null;
  readonly check_in_time: string | null;
  readonly check_out_time: string | null;
}

@Injectable()
export class HotelContentService {
  private readonly logger = new Logger(HotelContentService.name);

  /**
   * Lecturas al proveedor en vuelo, por clave de caché: dos vendedores que abren la misma ficha a
   * la vez esperan UNA llamada, no dos. El cupo de contenido de la cuenta es de una a la vez.
   */
  private readonly inFlight = new Map<string, Promise<Cached | undefined>>();

  /**
   * Lotes de contenido en vuelo, por hotel e idioma: dos pantallas de resultados que piden el mismo
   * hotel a la vez esperan UN lote, no dos. Se borra al terminar, haya salido bien o no.
   */
  private readonly batchInFlight = new Map<string, Promise<void>>();

  /** Tope por minuto de las llamadas extra de los lotes, por cuenta del proveedor. */
  private readonly extraCalls = new SlidingWindowBudget(
    HOTEL_CONTENT_EXTRA_CALLS_PER_MINUTE,
    60_000,
  );

  private readonly catalog: HotelCatalogStore;

  /** Los hoteles confirmados sin contenido: {@link HOTEL_CONTENT_NONE_CACHE}. */
  private readonly noneCache: CachePort;

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly db: DatabaseService,
    private readonly breaker: CircuitBreakerService,
    @Inject(HOTEL_CONTENT_CACHE) private readonly cache: CachePort,
    @Optional() catalog?: HotelCatalogStore,
    @Optional() @Inject(HOTEL_CONTENT_NONE_CACHE) noneCache?: CachePort,
  ) {
    this.catalog = catalog ?? new HotelCatalogStore(db);
    this.noneCache = noneCache ?? cache;
  }

  async getContent(tenantId: string, request: HotelContentRequest): Promise<HotelContentView> {
    const { providerCode, hotelId, lang } = request;
    const registration = this.registry.registered().find((r) => r.code === providerCode);
    if (registration === undefined) throw new UnknownHotelProviderError(providerCode);

    const langs =
      lang === HOTEL_CONTENT_FALLBACK_LANG ? [lang] : [lang, HOTEL_CONTENT_FALLBACK_LANG];
    const [rows, inventory] = await Promise.all([
      this.catalogContent(providerCode, hotelId, langs),
      this.catalogFacts(providerCode, hotelId),
    ]);
    const dropped: Dropped = { html: 0, images: 0, website: 0 };
    const stored = (wanted: HotelContentLanguage): Chosen | undefined => {
      const row = rows.find((r) => r.lang === wanted);
      return row === undefined
        ? undefined
        : { origin: 'catalog', body: bodyOf(rawOfRow(row), wanted, dropped) };
    };

    const hasDetails = (wanted: HotelContentLanguage): boolean =>
      rows.some((r) => r.lang === wanted && r.source === 'details');
    let chosen: Chosen | undefined = hasDetails(lang) ? stored(lang) : undefined;
    // Sólo el proveedor que no trae contenido en su disponibilidad tiene `hotel_content`, y sólo a
    // él se le pide en el momento: a los demás ni se les resuelve la cuenta. Y sólo por un hotel
    // de su catálogo: la ficha se abre desde una búsqueda, que sólo trae hoteles del catálogo, y
    // un código inventado en la URL no puede gastar el cupo de la cuenta del consolidador. Un hotel
    // que la cuenta de la agencia ya confirmó sin contenido en ese idioma tampoco se vuelve a pedir
    // (`callProvider`, con la cuenta ya resuelta).
    if (
      chosen === undefined &&
      inventory !== undefined &&
      registration.searchProfile.contentFromCatalog === true
    ) {
      // Un solo plazo para el idioma pedido y el respaldo: la ficha no espera dos veces.
      const deadline = Date.now() + HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS;
      const answer = await this.fromProvider(tenantId, providerCode, hotelId, lang);
      const fetched = onDemandOf(answer, hotelId, lang, dropped);
      // Una respuesta sin nada que mostrar no le gana al texto en inglés del catálogo.
      if (fetched !== undefined && hasContent(fetched.body)) {
        chosen = fetched;
      } else if (
        (answer?.kind === 'empty' || answer?.kind === 'found') &&
        lang !== HOTEL_CONTENT_FALLBACK_LANG &&
        !hasDetails(HOTEL_CONTENT_FALLBACK_LANG)
      ) {
        // El proveedor respondió sin contenido en el idioma pedido (TBO: "No Hotels Found", 05
        // CE-23) y el catálogo no tiene el detalle en inglés: se le pide el respaldo. Si falló o
        // no se le pudo preguntar, no: nada indica que el inglés vaya a llegar.
        const fallback = onDemandOf(
          await this.fromProvider(
            tenantId,
            providerCode,
            hotelId,
            HOTEL_CONTENT_FALLBACK_LANG,
            deadline,
          ),
          hotelId,
          HOTEL_CONTENT_FALLBACK_LANG,
          dropped,
        );
        if (fallback !== undefined && hasContent(fallback.body)) chosen = fallback;
      }
    }
    // En inglés, `stored(lang)` ya es el respaldo: si falta, el segundo intento también falta.
    chosen ??= stored(lang) ?? stored(HOTEL_CONTENT_FALLBACK_LANG);

    if (dropped.html + dropped.images + dropped.website > 0) {
      // Sólo cuántos y de qué proveedor: el contenido puede ser justo lo que no se debe volcar.
      this.logger.warn(
        `hotels.content.descartado provider=${providerCode} html=${dropped.html} images=${dropped.images} website=${dropped.website}`,
      );
    }
    return this.view(request, inventory ?? NO_FACTS, chosen);
  }

  // ───────────────────────── Contenido por lote (fotos de los resultados) ─────────────────────────

  /**
   * La foto principal de cada hotel de una pantalla de resultados (estrategia de fotos del
   * 2026-09-29). Los resultados salen al instante sin esperar esto: la web lo pide en segundo plano
   * para los hoteles que llegaron sin foto, y las fotos aparecen a medida que llegan.
   *
   * 1. Lo que el catálogo ya tiene sale enseguida, del hotel o de uno equivalente de otro proveedor
   *    (`hotel_match` aceptado, RF-34): con varios proveedores, la mejor foto del MISMO hotel.
   * 2. Lo que falta se le pide al proveedor que sabe darlo (TBO `HotelDetails`, lotes de 10), sólo
   *    por hoteles de SU catálogo que todavía no tienen contenido de detalle, con la cuenta que la
   *    agencia tiene habilitada, por el cupo de fondo del limitador y por su circuito —pasivo: un
   *    HotelDetails lento no corta las búsquedas de la red—. Lo que responde se GUARDA en
   *    `hotel_content` (0054) con la huella del sync, y la respuesta lo devuelve.
   * 3. Nunca bloquea: la respuesta espera a lo sumo {@link HOTEL_CONTENT_BATCH_WAIT_MS}; lo que no
   *    llegó sale `pending`, y la llamada sigue y guarda para la próxima.
   *
   * Nada de esto es un cambio de negocio: no emite eventos. En el log, sólo códigos y conteos.
   */
  async getContentBatch(
    tenantId: string,
    request: HotelContentBatchRequest,
  ): Promise<HotelContentBatchView> {
    const { lang } = request;
    const registrations = new Map(this.registry.registered().map((r) => [r.code, r]));
    const refs = uniqueRefs(request.hotels).slice(0, HOTEL_CONTENT_BATCH_MAX_HOTELS);
    const known = refs.filter((r) => registrations.has(r.providerCode));
    const hostsOf = (code: string): readonly string[] =>
      registrations.get(code)?.searchProfile.imageHosts ?? [];

    let images = pickMainImages(await this.catalog.imageCandidates(known, lang), hostsOf);
    const withoutImage = known.filter((r) => !images.has(hotelRefKey(r.providerCode, r.hotelId)));
    const fetchable = await this.fetchableRefs(withoutImage, lang, registrations);
    const fetchNow = fetchable.slice(0, HOTEL_CONTENT_BATCH_MAX_FETCH);
    const deferred = new Set(
      fetchable
        .slice(HOTEL_CONTENT_BATCH_MAX_FETCH)
        .map((r) => hotelRefKey(r.providerCode, r.hotelId)),
    );

    const pending = new Set<string>();
    if (fetchNow.length > 0) {
      const done = new Set<string>();
      await settleWithin(
        this.fetchAndStore(tenantId, fetchNow, lang, done),
        HOTEL_CONTENT_BATCH_WAIT_MS,
      );
      for (const r of fetchNow) {
        const key = hotelRefKey(r.providerCode, r.hotelId);
        if (!done.has(key)) pending.add(key);
      }
      if (done.size > 0) {
        images = pickMainImages(await this.catalog.imageCandidates(known, lang), hostsOf);
      }
    }

    const items = refs.map((r): HotelContentBatchItem => {
      const key = hotelRefKey(r.providerCode, r.hotelId);
      const image = images.get(key);
      if (image !== undefined) {
        return {
          providerCode: r.providerCode,
          hotelId: r.hotelId,
          status: 'ready',
          mainImage: { url: image.url },
          imageCount: image.count,
        };
      }
      return {
        providerCode: r.providerCode,
        hotelId: r.hotelId,
        status: pending.has(key) || deferred.has(key) ? 'pending' : 'none',
        mainImage: null,
        imageCount: 0,
      };
    });
    return {
      lang,
      items,
      ...(items.some((i) => i.status === 'pending')
        ? { retryAfterMs: HOTEL_CONTENT_BATCH_RETRY_AFTER_MS }
        : {}),
    };
  }

  /**
   * De los hoteles sin foto, los que vale la pena pedir: de un proveedor cuyo contenido sale del
   * catálogo, en SU catálogo (un código inventado no gasta el cupo de la cuenta del consolidador),
   * sin contenido de detalle todavía en NINGÚN idioma (si ya lo tiene y no trae fotos, el proveedor
   * no las tiene: las fotos no dependen del idioma) y sin un "no tiene" o un fallo reciente en la
   * caché. Lo confirmado sin contenido se filtra después, con la cuenta de la agencia resuelta
   * ({@link fetchProvider}): es de la cuenta, no de la plataforma.
   */
  private async fetchableRefs(
    refs: readonly HotelRef[],
    lang: HotelContentLanguage,
    registrations: ReadonlyMap<string, HotelProviderRegistration>,
  ): Promise<HotelRef[]> {
    const candidates = refs.filter(
      (r) => registrations.get(r.providerCode)?.searchProfile.contentFromCatalog === true,
    );
    if (candidates.length === 0) return [];
    const state = await this.catalog.contentState(candidates);
    const out: HotelRef[] = [];
    for (const r of candidates) {
      const known = state.get(hotelRefKey(r.providerCode, r.hotelId));
      if (known === undefined || !known.inCatalog || known.hasDetails) continue;
      const negative = BatchNegativeSchema.safeParse(
        await this.cache.get<unknown>(batchKey(r, lang)),
      );
      if (negative.success) continue;
      out.push(r);
    }
    return out;
  }

  /**
   * Pide y guarda el contenido de esos hoteles, por proveedor y en lotes de su tamaño. Marca en
   * `done` cada hotel cuyo lote terminó (bien o mal). Nunca lanza: un proveedor que no se puede
   * resolver, un circuito abierto o un lote que falla dejan a sus hoteles sin foto, no a la
   * respuesta sin las demás.
   */
  private async fetchAndStore(
    tenantId: string,
    refs: readonly HotelRef[],
    lang: HotelContentLanguage,
    done: Set<string>,
  ): Promise<void> {
    const byProvider = new Map<string, string[]>();
    for (const r of refs) {
      const ids = byProvider.get(r.providerCode) ?? [];
      ids.push(r.hotelId);
      byProvider.set(r.providerCode, ids);
    }
    await Promise.all(
      [...byProvider].map(([code, ids]) => this.fetchProvider(tenantId, code, ids, lang, done)),
    );
  }

  private async fetchProvider(
    tenantId: string,
    providerCode: string,
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    done: Set<string>,
  ): Promise<void> {
    const markDone = (ids: readonly string[]): void => {
      for (const id of ids) done.add(hotelRefKey(providerCode, id));
    };
    let resolved;
    try {
      resolved = await this.registry.byCodeForSale(tenantId, providerCode);
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(
          `hotels.content_batch.proveedor_no_resuelto provider=${providerCode} error=${errorName(err)}`,
        );
      }
      markDone(hotelIds);
      return;
    }
    const { adapter, circuit } = resolved;
    if (!supportsHotelContentBatch(adapter)) {
      markDone(hotelIds);
      return;
    }
    const account = accountScopeOf(providerCode, circuit?.accountRef);

    const waits: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const id of hotelIds) {
      // La cuenta ya confirmó que no lo tiene, en este idioma y en inglés: no se vuelve a pedir.
      if (await this.knownWithoutContent(account, id, lang)) {
        markDone([id]);
        continue;
      }
      const running = this.batchInFlight.get(batchFlightKey(providerCode, id, lang));
      if (running === undefined) fresh.push(id);
      else waits.push(running.finally(() => markDone([id])));
    }
    const size = Math.max(1, adapter.contentBatchSize);
    for (let i = 0; i < fresh.length; i += size) {
      const chunk = fresh.slice(i, i + size);
      const run = this.fetchChunk(account, chunk, lang, () =>
        this.breaker.execute(
          providerCode,
          () =>
            adapter.fetchHotelContents(
              chunk,
              lang,
              { tenantId },
              {
                timeoutMs: HOTEL_CONTENT_BATCH_FETCH_TIMEOUT_MS,
                signal: AbortSignal.timeout(HOTEL_CONTENT_BATCH_FETCH_TIMEOUT_MS),
                allowExtraCall: () => this.extraCalls.tryTake(account.key),
              },
            ),
          { ...circuit, scope: 'sales', passive: true },
        ),
      ).finally(() => {
        markDone(chunk);
        for (const id of chunk) this.batchInFlight.delete(batchFlightKey(providerCode, id, lang));
      });
      for (const id of chunk) this.batchInFlight.set(batchFlightKey(providerCode, id, lang), run);
      waits.push(run);
    }
    await Promise.all(waits);
  }

  /**
   * UN lote: lo pide, guarda lo que vuelve y recuerda lo que no. Nunca lanza. Escribe UNA línea
   * `info` con lo que resolvió, sólo con conteos (sin códigos de hotel ni contenido).
   */
  private async fetchChunk(
    account: AccountScope,
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    call: () => Promise<HotelContentBatch>,
  ): Promise<void> {
    const { providerCode } = account;
    let batch: HotelContentBatch;
    try {
      batch = await call();
    } catch (err) {
      // El circuito abierto o el kill-switch ya responden al instante: no hay nada que recordar.
      if (err instanceof BreakerRejectionError) return;
      this.logger.warn(
        `hotels.content_batch.lote_fallo provider=${providerCode} lang=${lang} hotels=${hotelIds.length} error=${errorName(err)}`,
      );
      await this.rememberBatch(providerCode, hotelIds, lang, 'failed');
      return;
    }
    const requested = new Set(hotelIds);
    // Sólo lo pedido, en el idioma pedido o en el de respaldo: un código que no se pidió no escribe
    // su contenido, y un idioma que nadie pidió tampoco.
    const accepted = new Set<HotelContentLanguage>([lang, HOTEL_CONTENT_FALLBACK_LANG]);
    const contents = batch.contents.filter((c) => requested.has(c.hotelId) && accepted.has(c.lang));
    const returned = new Set(contents.map((c) => c.hotelId));
    const confirmedNone = new Set(
      batch.missingHotelIds.filter((id) => requested.has(id) && !returned.has(id)),
    );
    const unresolved = new Set(
      (batch.unresolvedHotelIds ?? []).filter(
        (id) => requested.has(id) && !returned.has(id) && !confirmedNone.has(id),
      ),
    );
    // Lo que el proveedor no devolvió ni nombró en ninguna lista: respondió sin él, pero sin
    // confirmar que no lo tiene. "No volvió", como siempre.
    const unnamed = hotelIds.filter(
      (id) => !returned.has(id) && !confirmedNone.has(id) && !unresolved.has(id),
    );
    this.logBatch(providerCode, lang, hotelIds.length, contents, {
      confirmedNone: confirmedNone.size,
      unconfirmed: unnamed.length,
      unresolved: unresolved.size,
      batch,
    });
    let rejected = 0;
    try {
      ({ rejected } = await this.catalog.storeContents(providerCode, contents));
      if (rejected > 0) {
        this.logger.warn(
          `hotels.content_batch.filas_rechazadas provider=${providerCode} rejected=${rejected}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `hotels.content_batch.guardar_fallo provider=${providerCode} error=${errorName(err)}`,
      );
      await this.rememberBatch(providerCode, hotelIds, lang, 'failed');
      return;
    }
    // Una fila que la base rechazó deja al hotel sin `details`: sin recordarlo, cada pantalla de
    // resultados volvería a pedirlo al proveedor y a gastar su cupo en un contenido que no entra.
    const unstorable =
      rejected > 0 ? await this.stillWithoutDetails(providerCode, [...returned], lang) : [];
    const nothingToShow = [...unnamed, ...unstorable];
    if (nothingToShow.length > 0) {
      await this.rememberBatch(providerCode, nothingToShow, lang, 'empty');
    }
    if (unresolved.size > 0) {
      await this.rememberBatch(providerCode, [...unresolved], lang, 'deferred');
    }
    if (confirmedNone.size > 0) await this.rememberNoContent(account, [...confirmedNone], lang);
  }

  /**
   * La línea de diagnóstico de un lote: pedidos, encontrados por idioma, sin contenido confirmado,
   * sin confirmar, sin resolver, llamadas (las de respaldo y las extra) y lo que se vio del
   * proveedor (`breakers`: los que solos dejan vacío el lote, H2; `untrusted`: respuestas con
   * elementos descartados). Sólo conteos: ni códigos ni contenido.
   */
  private logBatch(
    providerCode: string,
    lang: HotelContentLanguage,
    requested: number,
    contents: readonly HotelContentRecord[],
    counts: {
      readonly confirmedNone: number;
      readonly unconfirmed: number;
      readonly unresolved: number;
      readonly batch: HotelContentBatch;
    },
  ): void {
    const { batch } = counts;
    const langs =
      lang === HOTEL_CONTENT_FALLBACK_LANG ? [lang] : [lang, HOTEL_CONTENT_FALLBACK_LANG];
    const found = langs
      .map((l) => {
        const hotels = new Set(contents.filter((c) => c.lang === l).map((c) => c.hotelId));
        return `found_${l}=${hotels.size}`;
      })
      .join(' ');
    const fallback = batch.calls !== undefined && batch.calls.fallback > 0 ? 'yes' : 'no';
    const calls =
      batch.calls === undefined
        ? ''
        : ` calls=${batch.calls.total} fallback_calls=${batch.calls.fallback} extra_calls=${batch.calls.isolation}`;
    const seen =
      batch.diagnostics === undefined
        ? ''
        : ` breakers=${batch.diagnostics.batchBreakers} untrusted=${batch.diagnostics.untrustedResponses}`;
    this.logger.log(
      `hotels.content_batch.lote provider=${providerCode} lang=${lang} requested=${requested} ${found} none=${counts.confirmedNone} unconfirmed=${counts.unconfirmed} unresolved=${counts.unresolved} fallback=${fallback}${calls}${seen}`,
    );
  }

  /**
   * ¿La cuenta ya confirmó que no tiene contenido del hotel en este idioma? Para un lote o una ficha
   * en `es` o `pt` hace falta además el inglés: sin él, el respaldo todavía puede dar las fotos.
   */
  private async knownWithoutContent(
    account: AccountScope,
    hotelId: string,
    lang: HotelContentLanguage,
    alsoFallback = true,
  ): Promise<boolean> {
    const langs =
      alsoFallback && lang !== HOTEL_CONTENT_FALLBACK_LANG
        ? [lang, HOTEL_CONTENT_FALLBACK_LANG]
        : [lang];
    for (const l of langs) {
      if ((await this.noneCache.get<unknown>(noContentKey(account, hotelId, l))) !== NO_CONTENT) {
        return false;
      }
    }
    return true;
  }

  /** Confirmados en el idioma pedido y en inglés: se recuerdan los dos, con la cuenta. */
  private async rememberNoContent(
    account: AccountScope,
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
  ): Promise<void> {
    const langs = new Set<HotelContentLanguage>([lang, HOTEL_CONTENT_FALLBACK_LANG]);
    await Promise.all(
      hotelIds.flatMap((hotelId) =>
        [...langs].map((l) =>
          this.noneCache.set(
            noContentKey(account, hotelId, l),
            NO_CONTENT,
            HOTEL_CONTENT_BATCH_CACHE_TTL_S.none,
          ),
        ),
      ),
    );
  }

  /**
   * De esos hoteles, los que siguen sin contenido `details` en el catálogo. Si no se puede saber,
   * ninguno: todos esperan el plazo corto de un fallo. Nunca lanza.
   */
  private async stillWithoutDetails(
    providerCode: string,
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
  ): Promise<string[]> {
    if (hotelIds.length === 0) return [];
    try {
      const state = await this.catalog.contentState(
        hotelIds.map((hotelId) => ({ providerCode, hotelId })),
      );
      return hotelIds.filter((id) => state.get(hotelRefKey(providerCode, id))?.hasDetails !== true);
    } catch (err) {
      this.logger.warn(
        `hotels.content_batch.estado_no_disponible provider=${providerCode} error=${errorName(err)}`,
      );
      await this.rememberBatch(providerCode, hotelIds, lang, 'failed');
      return [];
    }
  }

  private async rememberBatch(
    providerCode: string,
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    kind: BatchNegative,
  ): Promise<void> {
    await Promise.all(
      hotelIds.map((hotelId) =>
        this.cache.set(
          batchKey({ providerCode, hotelId }, lang),
          kind,
          HOTEL_CONTENT_BATCH_CACHE_TTL_S[kind],
        ),
      ),
    );
  }

  // ───────────────────────── Catálogo ─────────────────────────

  private async catalogContent(
    providerCode: string,
    hotelId: string,
    langs: readonly HotelContentLanguage[],
  ): Promise<ContentRow[]> {
    return this.db.db
      .selectFrom('hotel_content')
      .select([
        'lang',
        'source',
        'name',
        'description_html',
        'sections',
        'facilities',
        'attractions_html',
        'images',
        'phone',
        'website_url',
        'check_in_time',
        'check_out_time',
      ])
      .where('provider_code', '=', providerCode)
      .where('hotel_id', '=', hotelId)
      .where('lang', 'in', [...langs])
      .execute();
  }

  /**
   * La fila de `hotel_inventory`, activa o no: un hotel dado de baja conserva su ficha para las
   * reservas ya hechas y sus vouchers (05 §6.5). `undefined`: el catálogo no conoce el código.
   */
  private async catalogFacts(
    providerCode: string,
    hotelId: string,
  ): Promise<HotelFacts | undefined> {
    const row = await this.db.db
      .selectFrom('hotel_inventory')
      .select(['name', 'stars', 'address', 'zipcode', 'country_code', 'latitude', 'longitude'])
      .where('provider_code', '=', providerCode)
      .where('hotel_id', '=', hotelId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return factsOf(hotelId, {
      name: row.name,
      stars: row.stars,
      address: row.address,
      zipcode: row.zipcode,
      countryCode: row.country_code,
      latitude: row.latitude,
      longitude: row.longitude,
    });
  }

  // ───────────────────────── Bajo demanda ─────────────────────────

  /**
   * Lo que el proveedor respondió para el hotel, de la caché o de una llamada. `undefined` si no se
   * le pudo o no se le debía preguntar.
   */
  private async fromProvider(
    tenantId: string,
    providerCode: string,
    hotelId: string,
    lang: HotelContentLanguage,
    deadline?: number,
  ): Promise<Cached | undefined> {
    const key = `${KEY_PREFIX}:${providerCode}:${hotelId}:${lang}`;
    const hit = CachedSchema.safeParse(await this.cache.get<unknown>(key));
    if (hit.success) return hit.data;

    let pending = this.inFlight.get(key);
    if (pending === undefined) {
      // Sin plazo es la primera llamada: el plazo entero. El respaldo usa lo que quedó.
      const timeoutMs =
        deadline === undefined
          ? HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS
          : Math.min(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS, deadline - Date.now());
      if (timeoutMs < ON_DEMAND_MIN_REMAINING_MS) return undefined;
      pending = this.callProvider(tenantId, providerCode, hotelId, lang, key, timeoutMs).finally(
        () => this.inFlight.delete(key),
      );
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  /**
   * UNA llamada al proveedor, con la cuenta que la agencia tiene habilitada y por su circuito.
   *
   * Pasiva para el circuito: es una lectura secundaria con un plazo nuestro, más corto que el del
   * proveedor, y un `HotelDetails` lento no puede cortar las búsquedas de toda la red; tampoco
   * uno que responde puede cerrar el circuito que un Search caído abrió. El circuito sí la frena:
   * con el proveedor apagado, abierto o la cuenta suspendida no sale.
   *
   * `undefined` y sin caché lo que depende de la agencia (sin cuenta, `opt-in` apagado) o del
   * circuito, que ya responde al instante.
   */
  private async callProvider(
    tenantId: string,
    providerCode: string,
    hotelId: string,
    lang: HotelContentLanguage,
    key: string,
    timeoutMs: number,
  ): Promise<Cached | undefined> {
    let resolved;
    try {
      resolved = await this.registry.byCodeForSale(tenantId, providerCode);
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(
          `hotels.content.proveedor_no_resuelto provider=${providerCode} error=${errorName(err)}`,
        );
      }
      return undefined;
    }
    const { adapter, circuit } = resolved;
    if (!supportsHotelContent(adapter)) return undefined;
    // Lo que ESTA cuenta ya confirmó sin contenido en este idioma no se vuelve a pedir: sale como
    // una respuesta vacía, sin llamada y sin caché (la marca ya dura lo suyo).
    const account = accountScopeOf(providerCode, circuit?.accountRef);
    if (await this.knownWithoutContent(account, hotelId, lang, false)) return { kind: 'empty' };

    let content: HotelProviderContent | null;
    try {
      content = await this.breaker.execute(
        providerCode,
        () =>
          adapter.fetchHotelContent(
            hotelId,
            lang,
            { tenantId },
            { timeoutMs, signal: AbortSignal.timeout(timeoutMs) },
          ),
        { ...circuit, scope: 'sales', passive: true },
      );
    } catch (err) {
      if (err instanceof BreakerRejectionError) return undefined;
      this.logger.warn(
        `hotels.content.bajo_demanda_fallo provider=${providerCode} lang=${lang} error=${errorName(err)}`,
      );
      return this.remember(key, { kind: 'failed' }, HOTEL_CONTENT_CACHE_TTL_S.failed);
    }
    if (content === null) {
      return this.remember(key, { kind: 'empty' }, HOTEL_CONTENT_CACHE_TTL_S.empty);
    }
    return this.remember(
      key,
      { kind: 'found', content: { ...content } },
      HOTEL_CONTENT_CACHE_TTL_S.found,
    );
  }

  private async remember(key: string, value: Cached, ttlSeconds: number): Promise<Cached> {
    await this.cache.set(key, value, ttlSeconds);
    return value;
  }

  // ───────────────────────── Respuesta ─────────────────────────

  private view(
    request: HotelContentRequest,
    inventory: HotelFacts,
    chosen: Chosen | undefined,
  ): HotelContentView {
    const facts = mergeFacts(inventory, chosen?.facts);
    const body = chosen?.body;
    return {
      providerCode: request.providerCode,
      hotelId: request.hotelId,
      requestedLang: request.lang,
      lang: body?.lang ?? null,
      langFallback: body !== undefined && body.lang !== request.lang,
      origin: chosen?.origin ?? 'none',
      ...facts,
      name: facts.name ?? body?.name ?? null,
      descriptionHtml: body?.descriptionHtml ?? null,
      sections: body?.sections ?? [],
      facilities: body?.facilities ?? [],
      attractionsHtml: body?.attractionsHtml ?? null,
      images: body?.images ?? [],
      phone: body?.phone ?? null,
      websiteUrl: body?.websiteUrl ?? null,
      checkInTime: body?.checkInTime ?? null,
      checkOutTime: body?.checkOutTime ?? null,
    };
  }
}

function batchKey(ref: HotelRef, lang: HotelContentLanguage): string {
  return `${BATCH_KEY_PREFIX}:${ref.providerCode}:${ref.hotelId}:${lang}`;
}

/**
 * Con qué cuenta del proveedor sale una llamada: la huella que declara el proveedor (`accountRef`,
 * que cambia al rotar la credencial), nunca el tenant. Los hoteles confirmados sin contenido y el
 * cupo de llamadas extra son de la cuenta: lo que contestó una no frena a otra.
 */
interface AccountScope {
  readonly providerCode: string;
  readonly key: string;
}

function accountScopeOf(providerCode: string, accountRef: string | undefined): AccountScope {
  return { providerCode, key: `${providerCode}@${accountRef ?? NO_ACCOUNT_REF}` };
}

/** Por cuenta e idioma: la cuenta confirmó que el hotel no tiene contenido en ese idioma. */
function noContentKey(account: AccountScope, hotelId: string, lang: HotelContentLanguage): string {
  return `${NO_CONTENT_KEY_PREFIX}:${account.key}:${hotelId}:${lang}`;
}

function batchFlightKey(providerCode: string, hotelId: string, lang: HotelContentLanguage): string {
  return `${providerCode} ${hotelId} ${lang}`;
}

/** Sin repetidos y en el orden en que llegaron. */
function uniqueRefs(refs: readonly HotelRef[]): HotelRef[] {
  const seen = new Set<string>();
  const out: HotelRef[] = [];
  for (const r of refs) {
    const key = hotelRefKey(r.providerCode, r.hotelId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerCode: r.providerCode, hotelId: r.hotelId });
  }
  return out;
}

/**
 * Espera `work` hasta `ms` y sigue: lo que no terminó continúa solo. El temporizador no retiene el
 * proceso (`unref`), así un apagado no espera a unas fotos.
 */
async function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work.catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Un campo de un valor que puede no ser un objeto. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

function hasContent(body: ContentBody): boolean {
  return (
    body.descriptionHtml !== null ||
    body.attractionsHtml !== null ||
    body.sections.length > 0 ||
    body.facilities.length > 0 ||
    body.images.length > 0
  );
}

/**
 * Lo que respondió el proveedor, verificado igual que lo del catálogo. El idioma es el que pidió
 * el servidor: es el que se le mandó al proveedor.
 */
function onDemandOf(
  cached: Cached | undefined,
  hotelId: string,
  lang: HotelContentLanguage,
  dropped: Dropped,
): Chosen | undefined {
  if (cached?.kind !== 'found') return undefined;
  const c = cached.content;
  const raw: RawContent = {
    name: c['name'],
    descriptionHtml: c['descriptionHtml'],
    sections: c['sections'],
    facilities: c['facilities'],
    attractionsHtml: c['attractionsHtml'],
    images: c['images'],
    phone: c['phone'],
    websiteUrl: c['websiteUrl'],
    checkInTime: c['checkInTime'],
    checkOutTime: c['checkOutTime'],
  };
  return {
    origin: 'provider',
    body: bodyOf(raw, lang, dropped),
    facts: factsOf(hotelId, {
      name: c['name'],
      stars: c['stars'],
      address: c['address'],
      zipcode: c['zipcode'],
      countryCode: c['countryCode'],
      latitude: field(c['location'], 'lat'),
      longitude: field(c['location'], 'lng'),
    }),
  };
}

/** La fila con los nombres de campo del contrato. */
function rawOfRow(row: ContentRow): RawContent {
  return {
    name: row.name,
    descriptionHtml: row.description_html,
    sections: row.sections,
    facilities: row.facilities,
    attractionsHtml: row.attractions_html,
    images: row.images,
    phone: row.phone,
    websiteUrl: row.website_url,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
  };
}
