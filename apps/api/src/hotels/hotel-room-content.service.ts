import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelRoomContent,
  type HotelContentLanguage,
  type HotelProviderRegistration,
  type HotelRoomContentFetch,
} from '../providers/hotel-provider.types.js';
import { ProviderNotAvailableError } from '../providers/provider.types.js';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  HotelCatalogStore,
  type HotelRoomContentRow,
  type HotelRoomContentState,
} from './hotel-catalog.store.js';
import {
  HOTEL_CONTENT_CACHE,
  HOTEL_CONTENT_FALLBACK_LANG,
  HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS,
} from './hotel-content.service.js';
import { hotelImageProxyUrl } from './hotel-image-proxy.js';
import { UnknownHotelProviderError } from './hotel-provider-errors.js';
import {
  HOTEL_ROOM_CONTENT_SWITCH,
  type HotelRoomContentSwitch,
} from './hotel-room-content.config.js';

/**
 * Fotos, tamaño y descripción de cada habitación de un hotel (docs/tbo/05 §2.6.3; 08 RF-32; Q-65).
 * El founder no veía la diferencia entre "Standard" y "Deluxe": la tarifa trae el nombre de la
 * habitación y nada más.
 *
 * - **Del catálogo primero.** Lo que el proveedor respondió queda en `hotel_room_content` y en
 *   `hotel_room_content_fetch` (0070) con su fecha, y vale un tiempo según lo que fue
 *   ({@link HOTEL_ROOM_CONTENT_TTL_MS}): habitaciones, 30 días; el hotel sin contenido en ese idioma,
 *   7; un bloque que no se pudo leer, 1. Mientras vale, la ficha no sale al proveedor.
 * - **Bajo demanda.** Vencido o nunca pedido, se le pide al proveedor que sabe darlo (TBO
 *   `HotelDetails` con `IsRoomDetailRequired`) ese solo hotel: con la cuenta que la agencia tiene
 *   habilitada (respeta el `opt-in` y el apagado), por su circuito y en modo pasivo, por el cupo de
 *   fondo del limitador. Sin habitaciones en el idioma pedido se pide el inglés (05 CE-23: TBO
 *   contesta "No Hotels Found" en español para Colombia). Se GUARDA cada idioma por la función de
 *   0070, que valida cada habitación.
 * - **Nunca bloquea la ficha.** La respuesta espera a lo sumo {@link HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS};
 *   si no llegó, sale lo guardado aunque esté vencido o `pending` con `retryAfterMs`, y la llamada
 *   SIGUE y guarda para la próxima. Un fallo se recuerda 2 minutos (`hotels:room-content-failed`).
 * - **Sólo hoteles del catálogo.** Un código inventado en la URL no gasta el cupo de la cuenta del
 *   consolidador: sin fila en `hotel_inventory` la respuesta es `none` sin llamar.
 * - **Interruptor.** Con `HOTEL_ROOM_CONTENT=off` sale lo guardado, vencido o no, y si no hay nada
 *   `disabled`; nunca se llama al proveedor. El ACL de TBO tiene el suyo (`TBO_ROOM_DETAILS`).
 * - **Las fotos salen por el proxy propio** (`/api/hotels/images/…`), sólo de los dominios del
 *   proveedor; las que no se pueden servir se cuentan y no salen.
 *
 * Es catálogo de PLATAFORMA (05 §11), como el contenido del hotel: la caché de fallos no es por
 * tenant. Leer contenido estático no es un cambio de negocio: no emite eventos. En el log, sólo el
 * proveedor, el idioma y conteos: ni códigos de hotel ni contenido.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Cuánto vale lo que respondió el proveedor, según lo que fue. */
export const HOTEL_ROOM_CONTENT_TTL_MS = Object.freeze({
  rooms: 30 * DAY_MS,
  none: 7 * DAY_MS,
  unreadable: DAY_MS,
});

/**
 * Plazo de CADA llamada al proveedor, cola del limitador incluida. Más largo que lo que espera la
 * respuesta ({@link HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS}): lo que no llega a tiempo sigue y se guarda.
 */
export const HOTEL_ROOM_CONTENT_FETCH_TIMEOUT_MS = 20_000;

/** Cuándo conviene volver a preguntar por lo que quedó `pending`. */
export const HOTEL_ROOM_CONTENT_RETRY_AFTER_MS = 3_000;

/** Cuánto se recuerda un fallo: una ficha abierta diez veces no espera diez veces al proveedor. */
export const HOTEL_ROOM_CONTENT_FAILED_TTL_S = 2 * 60;

const FAILED_KEY_PREFIX = 'hotels:room-content-failed';
const FAILED = 'failed';

/** Techos de lo que sale, los mismos que acepta la función de 0070. */
const MAX_ROOMS = 100;
const MAX_IMAGES = 30;
const MAX_NAME = 300;
const MAX_SIZE_TEXT = 60;
const MAX_DESCRIPTION = 4_000;

const ROOM_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Superficie aceptada, en m²: fuera de esto el número es un error de unidad, no una habitación. */
const MIN_M2 = 5;
const MAX_M2 = 500;
const SQ_FT_TO_M2 = 0.092903;
const SIZE_M2 = /(\d+(?:[.,]\d+)?)\s*(m2|m²|sqm|sq\.?\s?m)/i;
const SIZE_FT = /(\d+(?:[.,]\d+)?)\s*(ft|ft2|ft²|sq\.?\s?ft|square feet)/i;

/**
 * Qué pasa con las habitaciones de un hotel:
 *
 * - `ready`: hay habitaciones con contenido en `rooms`.
 * - `none`: no hay nada que mostrar (el proveedor no lo tiene, no se le puede pedir o falló hace
 *   poco). La ficha queda como antes; no hay que insistir.
 * - `pending`: se está trayendo del proveedor: volver a pedir a los `retryAfterMs`.
 * - `disabled`: el interruptor está apagado y el catálogo no tiene nada guardado.
 */
export type HotelRoomContentStatus = 'ready' | 'none' | 'pending' | 'disabled';

export interface HotelRoomContentRequest {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly lang: HotelContentLanguage;
}

/** Una habitación tal como sale por HTTP. Todo texto es plano: la web lo escapa al pintar. */
export interface HotelRoomContentRoom {
  /** Identidad de la habitación en su hotel (el id del proveedor o `n-…`). */
  readonly roomKey: string;
  /** El id del proveedor, el mismo `roomTypeId` de la tarifa; `null` si no lo mandó. */
  readonly roomId: string | null;
  /** El nombre normalizado como `normalizeRoomName` de la web; `null` sin nombre. */
  readonly nameKey: string | null;
  readonly name: string | null;
  /** Tal como lo manda el proveedor (`"1830 ft"`). */
  readonly sizeText: string | null;
  /** El tamaño en m², convertido si vino en pies; `null` si no se pudo leer. */
  readonly sizeM2: number | null;
  readonly description: string | null;
  /** Rutas del proxy propio (`/api/hotels/images/<clave>`). */
  readonly images: readonly string[];
}

export interface HotelRoomContentView {
  readonly providerCode: string;
  readonly hotelId: string;
  readonly requestedLang: HotelContentLanguage;
  /** El de las habitaciones que salen; `null` sin habitaciones. Distinto de `requestedLang` = respaldo. */
  readonly lang: HotelContentLanguage | null;
  readonly langFallback: boolean;
  readonly status: HotelRoomContentStatus;
  /** Sólo con `pending`: en cuántos ms conviene volver a preguntar. */
  readonly retryAfterMs?: number;
  readonly rooms: readonly HotelRoomContentRoom[];
}

/**
 * Cómo terminó pedir UN idioma al proveedor:
 *
 * - `stored`: respondió y se guardó (`stored` = habitaciones guardadas).
 * - `failed`: falló ahora o hace poco (la caché de fallos).
 * - `unreachable`: no se le pudo preguntar (sin cuenta o sin `opt-in`, circuito abierto, sin el
 *   puerto). No se recuerda: depende de la agencia o ya responde al instante.
 * - `switched-off`: el proveedor dice que hoy no puede pedir el detalle por habitación.
 */
type LangFetch =
  | { readonly kind: 'stored'; readonly stored: number }
  | { readonly kind: 'failed' | 'unreachable' | 'switched-off' };

/** Cómo terminaron las llamadas de una ficha. */
interface Refresh {
  readonly last: LangFetch['kind'];
  /** Se guardó algo: lo que sale se vuelve a leer del catálogo. */
  readonly storedAny: boolean;
}

/** Qué hay que pedirle al proveedor. */
interface Plan {
  /** El idioma pedido está vencido o nunca se pidió. */
  readonly requested: boolean;
  /** El inglés: siempre, sólo si el pedido no trae habitaciones, o nunca. */
  readonly fallback: 'always' | 'if-empty' | 'never';
}

/** Sólo el nombre de la clase: el mensaje de un error de transporte puede citar la URL de la cuenta. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

function langsOf(lang: HotelContentLanguage): HotelContentLanguage[] {
  return lang === HOTEL_CONTENT_FALLBACK_LANG ? [lang] : [lang, HOTEL_CONTENT_FALLBACK_LANG];
}

function failedKey(providerCode: string, hotelId: string, lang: HotelContentLanguage): string {
  return `${FAILED_KEY_PREFIX}:${providerCode}:${hotelId}:${lang}`;
}

function flightKey(providerCode: string, hotelId: string, lang: HotelContentLanguage): string {
  return `${providerCode} ${hotelId} ${lang}`;
}

/** Vigente: respondió hace menos de lo que vale su resultado. */
function isFresh(state: HotelRoomContentState, lang: HotelContentLanguage, now: number): boolean {
  const fetch = state.fetches.get(lang);
  if (fetch === undefined) return false;
  return now - fetch.fetchedAt.getTime() < HOTEL_ROOM_CONTENT_TTL_MS[fetch.outcome];
}

/**
 * Qué falta pedir. El idioma pedido, si venció. El inglés, si el pedido no tiene habitaciones
 * vigentes y el inglés tampoco está vigente: si el pedido hay que traerlo, sólo cuando vuelva sin
 * habitaciones.
 */
function planOf(
  lang: HotelContentLanguage,
  state: HotelRoomContentState,
  rows: readonly HotelRoomContentRow[],
  now: number,
): Plan {
  const requested = !isFresh(state, lang, now);
  if (lang === HOTEL_CONTENT_FALLBACK_LANG) return { requested, fallback: 'never' };
  const roomsInLang = rows.some((r) => r.lang === lang);
  if ((!requested && roomsInLang) || isFresh(state, HOTEL_CONTENT_FALLBACK_LANG, now)) {
    return { requested, fallback: 'never' };
  }
  return { requested, fallback: requested ? 'if-empty' : 'always' };
}

function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length === 0 || text.length > max ? null : text;
}

/** El número de un tamaño, con coma o punto decimal. */
function numberOf(text: string): number {
  return Number(text.replace(',', '.'));
}

/**
 * El tamaño en m² de un texto libre del proveedor: en m² tal cual; en pies cuadrados, convertido y
 * redondeado (p. 57: `"1830 ft"`, sin unidad documentada, Q-65 c). Fuera de 5..500, `null`.
 */
export function roomSizeM2(sizeText: string | null): number | null {
  if (sizeText === null) return null;
  const m2 = SIZE_M2.exec(sizeText);
  let value: number | undefined;
  if (m2?.[1] !== undefined) {
    value = numberOf(m2[1]);
  } else {
    const ft = SIZE_FT.exec(sizeText);
    if (ft?.[1] !== undefined) value = Math.round(numberOf(ft[1]) * SQ_FT_TO_M2);
  }
  if (value === undefined || !Number.isFinite(value)) return null;
  return value >= MIN_M2 && value <= MAX_M2 ? value : null;
}

/** Lo que se descartó al servir, para contarlo en el log sin volcar el contenido. */
interface Dropped {
  rooms: number;
  images: number;
}

/**
 * Una fila del catálogo como habitación de la respuesta. La base ya validó al guardar; aquí se
 * VERIFICA igual, como la ficha del hotel: lo que alguien escribió a mano no llega a la web.
 */
function roomOf(
  row: HotelRoomContentRow,
  hosts: readonly string[],
  dropped: Dropped,
): HotelRoomContentRoom | undefined {
  if (!ROOM_KEY.test(row.roomKey) || row.roomKey === '0') {
    dropped.rooms += 1;
    return undefined;
  }
  const roomId =
    row.roomRef !== null && ROOM_KEY.test(row.roomRef) && row.roomRef !== '0' ? row.roomRef : null;
  const sizeText = textOf(row.sizeText, MAX_SIZE_TEXT);
  const description = textOf(row.description, MAX_DESCRIPTION);
  const images = new Set<string>();
  for (const src of Array.isArray(row.images) ? (row.images as unknown[]) : []) {
    const url = hotelImageProxyUrl(src, hosts);
    if (url === undefined) {
      dropped.images += 1;
      continue;
    }
    if (images.size < MAX_IMAGES) images.add(url);
  }
  return {
    roomKey: row.roomKey,
    roomId,
    nameKey: textOf(row.nameKey, MAX_NAME),
    name: textOf(row.name, MAX_NAME),
    sizeText,
    sizeM2: roomSizeM2(sizeText),
    description: description !== null && /[<>]/.test(description) ? null : description,
    images: [...images],
  };
}

/**
 * Espera `work` hasta `ms` y sigue: `undefined` si no terminó, y lo que no terminó continúa solo.
 * El temporizador no retiene el proceso (`unref`): un apagado no espera a unas fotos.
 */
async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HotelRoomContentService {
  private readonly logger = new Logger(HotelRoomContentService.name);

  /**
   * Llamadas en vuelo por proveedor, hotel e idioma: dos vendedores que abren la misma ficha a la
   * vez esperan UNA llamada, no dos. Se borra al terminar, haya salido bien o no.
   */
  private readonly inFlight = new Map<string, Promise<LangFetch>>();

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly catalog: HotelCatalogStore,
    private readonly breaker: CircuitBreakerService,
    @Inject(HOTEL_CONTENT_CACHE) private readonly cache: CachePort,
    @Inject(HOTEL_ROOM_CONTENT_SWITCH) private readonly roomSwitch: HotelRoomContentSwitch,
  ) {}

  async getRoomContent(
    tenantId: string,
    request: HotelRoomContentRequest,
  ): Promise<HotelRoomContentView> {
    const { providerCode, hotelId, lang } = request;
    const registration = this.registry.registered().find((r) => r.code === providerCode);
    if (registration === undefined) throw new UnknownHotelProviderError(providerCode);
    // Sólo el proveedor cuyo contenido sale del catálogo tiene contenido por habitación que pedir
    // (TBO). Los demás ni consultan la base.
    if (registration.searchProfile.contentFromCatalog !== true) {
      return this.view(request, registration, [], 'none');
    }

    const langs = langsOf(lang);
    const [state, rows] = await Promise.all([
      this.catalog.roomContentState(providerCode, hotelId, langs),
      this.catalog.roomContents(providerCode, hotelId, langs),
    ]);
    if (!state.inCatalog) return this.view(request, registration, [], 'none');
    if (this.roomSwitch === 'off') return this.view(request, registration, rows, 'disabled');

    const plan = planOf(lang, state, rows, Date.now());
    if (!plan.requested && plan.fallback === 'never') {
      return this.view(request, registration, rows, 'none');
    }

    const refresh = await settledWithin(
      this.refresh(tenantId, request, plan),
      HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS,
    );
    // Plazo vencido: lo guardado aunque esté vencido, o volver a preguntar en un rato.
    if (refresh === undefined) return this.view(request, registration, rows, 'pending');
    const latest = refresh.storedAny
      ? await this.catalog.roomContents(providerCode, hotelId, langs)
      : rows;
    return this.view(
      request,
      registration,
      latest,
      refresh.last === 'switched-off' ? 'disabled' : 'none',
    );
  }

  /**
   * Pide lo que dice el plan: el idioma pedido y, si hace falta, el inglés. Si el pedido falló o no
   * se le pudo preguntar, no se pide el inglés: nada indica que vaya a llegar. Nunca lanza.
   */
  private async refresh(
    tenantId: string,
    request: HotelRoomContentRequest,
    plan: Plan,
  ): Promise<Refresh> {
    const { providerCode, hotelId, lang } = request;
    let storedAny = false;
    let roomsInLang = false;
    if (plan.requested) {
      const fetched = await this.fetchLang(tenantId, providerCode, hotelId, lang);
      if (fetched.kind !== 'stored') return { last: fetched.kind, storedAny };
      storedAny = true;
      roomsInLang = fetched.stored > 0;
    }
    if (plan.fallback === 'always' || (plan.fallback === 'if-empty' && !roomsInLang)) {
      const fetched = await this.fetchLang(
        tenantId,
        providerCode,
        hotelId,
        HOTEL_CONTENT_FALLBACK_LANG,
      );
      return { last: fetched.kind, storedAny: storedAny || fetched.kind === 'stored' };
    }
    return { last: 'stored', storedAny };
  }

  /** UN idioma, con una sola llamada en vuelo por clave. */
  private fetchLang(
    tenantId: string,
    providerCode: string,
    hotelId: string,
    lang: HotelContentLanguage,
  ): Promise<LangFetch> {
    const key = flightKey(providerCode, hotelId, lang);
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const run = this.fetchAndStore(tenantId, providerCode, hotelId, lang).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, run);
    return run;
  }

  /**
   * Pide y guarda. Un fallo del proveedor o de la base se recuerda {@link HOTEL_ROOM_CONTENT_FAILED_TTL_S}
   * y se escribe en el log con el proveedor, el idioma y el nombre del error. Nunca lanza.
   */
  private async fetchAndStore(
    tenantId: string,
    providerCode: string,
    hotelId: string,
    lang: HotelContentLanguage,
  ): Promise<LangFetch> {
    const key = failedKey(providerCode, hotelId, lang);
    try {
      if ((await this.cache.get<unknown>(key)) === FAILED) return { kind: 'failed' };
      return await this.callAndStore(tenantId, providerCode, hotelId, lang);
    } catch (err) {
      this.logger.warn(
        `hotels.room_content.fallo provider=${providerCode} lang=${lang} error=${errorName(err)}`,
      );
      await this.cache.set(key, FAILED, HOTEL_ROOM_CONTENT_FAILED_TTL_S).catch(() => undefined);
      return { kind: 'failed' };
    }
  }

  /**
   * UNA llamada al proveedor, con la cuenta que la agencia tiene habilitada y por su circuito, y lo
   * que responde se guarda. Pasiva para el circuito, como la ficha del hotel: un HotelDetails lento
   * no corta las búsquedas de la red, y uno que responde no cierra un circuito que abrió un Search
   * caído. Lanza lo que lanza el proveedor o la base: quien llama lo recuerda como fallo.
   */
  private async callAndStore(
    tenantId: string,
    providerCode: string,
    hotelId: string,
    lang: HotelContentLanguage,
  ): Promise<LangFetch> {
    let resolved;
    try {
      resolved = await this.registry.byCodeForSale(tenantId, providerCode);
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(
          `hotels.room_content.proveedor_no_resuelto provider=${providerCode} error=${errorName(err)}`,
        );
      }
      return { kind: 'unreachable' };
    }
    const { adapter, circuit } = resolved;
    if (!supportsHotelRoomContent(adapter)) return { kind: 'unreachable' };

    let answer: HotelRoomContentFetch;
    try {
      answer = await this.breaker.execute(
        providerCode,
        () =>
          adapter.fetchHotelRoomContent(
            hotelId,
            lang,
            { tenantId },
            {
              timeoutMs: HOTEL_ROOM_CONTENT_FETCH_TIMEOUT_MS,
              signal: AbortSignal.timeout(HOTEL_ROOM_CONTENT_FETCH_TIMEOUT_MS),
            },
          ),
        { ...circuit, scope: 'sales', passive: true },
      );
    } catch (err) {
      // El circuito abierto o el kill-switch ya responden al instante: no hay nada que recordar.
      if (err instanceof BreakerRejectionError) return { kind: 'unreachable' };
      throw err;
    }
    if (answer.outcome === 'unavailable') return { kind: 'switched-off' };

    const rooms = answer.outcome === 'rooms' ? answer.rooms.slice(0, MAX_ROOMS) : [];
    const result = await this.catalog.storeRoomContents(
      providerCode,
      hotelId,
      lang,
      answer.outcome,
      rooms,
    );
    // La línea con que se cierra Q-65 sin mirar valores: qué respondió y cuánto entró.
    this.logger.log(
      `hotels.room_content.traido provider=${providerCode} lang=${lang} outcome=${answer.outcome} rooms=${rooms.length} stored=${result.stored} rejected=${result.rejected}`,
    );
    return { kind: 'stored', stored: result.stored };
  }

  // ───────────────────────── Respuesta ─────────────────────────

  /**
   * Las habitaciones del idioma pedido o, si no tiene, las del inglés. Sin ninguna, `empty`; con
   * habitaciones, `ready` aunque la llamada haya quedado `pending` o el interruptor esté apagado:
   * lo guardado se muestra.
   */
  private view(
    request: HotelRoomContentRequest,
    registration: HotelProviderRegistration,
    rows: readonly HotelRoomContentRow[],
    empty: Exclude<HotelRoomContentStatus, 'ready'>,
  ): HotelRoomContentView {
    const hosts = registration.searchProfile.imageHosts ?? [];
    const dropped: Dropped = { rooms: 0, images: 0 };
    let rooms: HotelRoomContentRoom[] = [];
    let lang: HotelContentLanguage | null = null;
    for (const candidate of langsOf(request.lang)) {
      rooms = rows
        .filter((r) => r.lang === candidate)
        .slice(0, MAX_ROOMS)
        .map((r) => roomOf(r, hosts, dropped))
        .filter((r): r is HotelRoomContentRoom => r !== undefined);
      if (rooms.length > 0) {
        lang = candidate;
        break;
      }
    }
    if (dropped.rooms + dropped.images > 0) {
      // Sólo cuántos y de qué proveedor: el contenido puede ser justo lo que no se debe volcar.
      this.logger.warn(
        `hotels.room_content.descartado provider=${request.providerCode} rooms=${dropped.rooms} images=${dropped.images}`,
      );
    }
    const status: HotelRoomContentStatus = lang === null ? empty : 'ready';
    return {
      providerCode: request.providerCode,
      hotelId: request.hotelId,
      requestedLang: request.lang,
      lang,
      langFallback: lang !== null && lang !== request.lang,
      status,
      ...(status === 'pending' ? { retryAfterMs: HOTEL_ROOM_CONTENT_RETRY_AFTER_MS } : {}),
      rooms,
    };
  }
}
