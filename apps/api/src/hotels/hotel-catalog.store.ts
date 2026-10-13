import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { HotelRoomContentOutcome } from '../database/database.types.js';
import {
  HOTEL_CONTENT_LANGUAGES,
  type HotelCatalogRecord,
  type HotelContentLanguage,
  type HotelContentRecord,
  type HotelProviderRoomContent,
} from '../providers/hotel-provider.types.js';

/**
 * Lo que el API lee y escribe del catálogo de hoteles para las fotos de los resultados, las
 * ciudades que se cargan al buscarlas (migración 0054; docs/tbo/05 §8.5) y el contenido por
 * habitación (0070; 05 §2.6.3).
 *
 * - Las tablas son de PLATAFORMA, sin tenant ni RLS (0041): se leen con `this.db.db`, como el resto
 *   del catálogo de `HotelsService`.
 * - Escribir es SÓLO por las funciones `SECURITY DEFINER` de 0054 y 0070, que validan cada campo y
 *   aplican las reglas del sync (huella, `listing` nunca sobre `details`, nunca desactivar). La app
 *   sigue sin `INSERT`/`UPDATE` sobre las tablas.
 * - Las consultas crudas llevan un comentario que las nombra (`/* hotel-catalog:… *\/`): así se las
 *   reconoce en un plan o en un log de consultas lentas sin leer el SQL.
 */

export interface HotelRef {
  readonly providerCode: string;
  readonly hotelId: string;
}

/**
 * Una fila con fotos del hotel pedido o de uno equivalente (`hotel_match` aceptado), en el orden
 * de preferencia: primero las del propio proveedor, después las de más fotos; `details` antes que
 * `listing`, y el idioma pedido antes que los otros.
 */
export interface HotelImageCandidate {
  readonly wantProvider: string;
  readonly wantHotel: string;
  /** El proveedor dueño de las fotos: sus dominios deciden si el proxy las sirve. */
  readonly providerCode: string;
  readonly imageCount: number;
  /** Las primeras cinco URLs, tal como están guardadas. */
  readonly firstImages: readonly unknown[];
}

/** Qué se sabe del contenido de un hotel pedido. */
export interface HotelContentState {
  /** Está en `hotel_inventory` de ese proveedor: sólo esos se piden al proveedor. */
  readonly inCatalog: boolean;
  /** Tiene contenido `details` en algún idioma: el proveedor ya respondió por él. */
  readonly hasDetails: boolean;
}

export interface HotelContentStoreResult {
  readonly inserted: number;
  readonly rewritten: number;
  readonly touched: number;
  readonly unchanged: number;
  readonly protected: number;
  readonly rejected: number;
}

/** Una ciudad del catálogo del proveedor, con lo que decide si se carga al buscarla. */
export interface HotelCatalogCity {
  readonly countryCode: string;
  /**
   * `hotel_count` en `NULL`: el sync nunca la cargó (la bajó E2A, o E3 falló). Se carga al
   * buscarla. Con `0` TBO ya dijo que está vacía; con más, ya tiene hoteles.
   */
  readonly neverLoaded: boolean;
}

export type HotelCityImportOutcome = 'unknown-city' | 'already-loaded' | 'loaded' | 'empty';

export interface HotelCityImportResult {
  readonly outcome: HotelCityImportOutcome;
  readonly activeHotels: number;
}

/** La última vez que se le pidió al proveedor el detalle por habitación de un hotel en un idioma. */
export interface HotelRoomContentFetchState {
  readonly outcome: HotelRoomContentOutcome;
  readonly roomCount: number;
  readonly fetchedAt: Date;
}

/** Qué sabe el catálogo de las habitaciones de UN hotel, en los idiomas pedidos. */
export interface HotelRoomContentState {
  /** Está en `hotel_inventory` de ese proveedor: sólo esos se piden al proveedor. */
  readonly inCatalog: boolean;
  /** Por idioma; un idioma ausente nunca se pidió. */
  readonly fetches: ReadonlyMap<HotelContentLanguage, HotelRoomContentFetchState>;
}

/** Una fila de `hotel_room_content` con los nombres del contrato, sin verificar. */
export interface HotelRoomContentRow {
  readonly lang: HotelContentLanguage;
  readonly roomKey: string;
  readonly roomRef: string | null;
  readonly nameKey: string | null;
  readonly name: string | null;
  readonly sizeText: string | null;
  readonly description: string | null;
  /** JSONB tal como lo devuelve `pg`: se verifica al servir. */
  readonly images: unknown;
}

export interface HotelRoomContentStoreResult {
  readonly stored: number;
  readonly rejected: number;
}

/** Tope de `hotel_catalog_store_room_contents`. */
export const HOTEL_ROOM_CONTENT_MAX_ROOMS = 100;

const ROOM_OUTCOMES: ReadonlySet<string> = new Set(['rooms', 'none', 'unreadable']);

function isContentLanguage(value: unknown): value is HotelContentLanguage {
  return (HOTEL_CONTENT_LANGUAGES as readonly unknown[]).includes(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Medio par UTF-16 sin su otra mitad. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Texto que `jsonb` acepta. Postgres rechaza la llamada ENTERA ante un medio par UTF-16 suelto
 * (22P02) o un `\u0000` (22P05), y un recorte por largo en el ACL puede partir un emoji en dos: sin
 * esto, ese hotel fallaría al guardar en cada intento y se le volvería a pedir al proveedor cada
 * vez que vence la caché de fallos, sin quedar nunca anotado.
 */
function jsonbText(value: string): string {
  return value.replace(LONE_SURROGATE, '').replaceAll('\u0000', '');
}

function jsonbTextOrNull(value: string | null): string | null {
  return value === null ? null : jsonbText(value);
}

/** Filas por llamada a `hotel_catalog_store_contents` (su tope es 50). */
const CONTENT_STORE_CHUNK = 50;

export const HOTEL_CITY_IMPORT_MAX_HOTELS = 20_000;

const IMPORT_OUTCOMES: ReadonlySet<string> = new Set([
  'unknown-city',
  'already-loaded',
  'loaded',
  'empty',
]);

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Un conteo de la base (`int` o, si viniera como texto, `bigint`); lo ilegible cuenta 0. */
function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class HotelCatalogStore {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Fotos candidatas de cada hotel pedido: las suyas y las de los hoteles equivalentes de otros
   * proveedores (`hotel_match` aceptado, RF-34), ya en orden de preferencia. Con varios
   * proveedores, la tarjeta usa la mejor foto disponible del MISMO hotel.
   */
  async imageCandidates(
    refs: readonly HotelRef[],
    lang: HotelContentLanguage,
  ): Promise<HotelImageCandidate[]> {
    if (refs.length === 0) return [];
    const providers = refs.map((r) => r.providerCode);
    const hotels = refs.map((r) => r.hotelId);
    const result = await sql<{
      want_provider: string;
      want_hotel: string;
      provider_code: string;
      image_count: number | string;
      first_images: unknown;
    }>`/* hotel-catalog:main-images */
      WITH wanted AS (
        SELECT DISTINCT w.provider_code, w.hotel_id
          FROM unnest(${providers}::text[], ${hotels}::text[]) AS w(provider_code, hotel_id)
      ), members AS (
        SELECT w.provider_code AS want_provider, w.hotel_id AS want_hotel,
               w.provider_code, w.hotel_id, 0 AS rank
          FROM wanted w
        UNION
        SELECT w.provider_code, w.hotel_id, other.provider_code, other.hotel_id, 1
          FROM wanted w
          JOIN hotel_match own
            ON own.provider_code = w.provider_code
           AND own.hotel_id = w.hotel_id
           AND own.status = 'accepted'
          JOIN hotel_match other
            ON other.canonical_hotel_id = own.canonical_hotel_id
           AND other.status = 'accepted'
         WHERE (other.provider_code, other.hotel_id) <> (w.provider_code, w.hotel_id)
      )
      SELECT m.want_provider, m.want_hotel, c.provider_code,
             jsonb_array_length(c.images) AS image_count,
             jsonb_path_query_array(c.images, '$[0 to 4]') AS first_images
        FROM members m
        JOIN hotel_content c
          ON c.provider_code = m.provider_code
         AND c.hotel_id = m.hotel_id
       WHERE jsonb_typeof(c.images) = 'array'
         AND jsonb_array_length(c.images) > 0
       ORDER BY m.want_provider, m.want_hotel, m.rank,
                (c.source = 'details') DESC,
                jsonb_array_length(c.images) DESC,
                (c.lang = ${lang}) DESC,
                c.provider_code, c.hotel_id, c.lang`.execute(this.db.db);
    return result.rows.map((row) => ({
      wantProvider: row.want_provider,
      wantHotel: row.want_hotel,
      providerCode: row.provider_code,
      imageCount: count(row.image_count),
      firstImages: Array.isArray(row.first_images) ? (row.first_images as unknown[]) : [],
    }));
  }

  /** Si cada hotel está en el catálogo de su proveedor y si ya tiene contenido `details`. */
  async contentState(refs: readonly HotelRef[]): Promise<Map<string, HotelContentState>> {
    const out = new Map<string, HotelContentState>();
    const result = await sql<{
      provider_code: string;
      hotel_id: string;
      in_catalog: boolean;
      has_details: boolean;
    }>`/* hotel-catalog:content-state */
      SELECT w.provider_code, w.hotel_id,
             EXISTS (SELECT 1 FROM hotel_inventory h
                      WHERE h.provider_code = w.provider_code AND h.hotel_id = w.hotel_id)
               AS in_catalog,
             EXISTS (SELECT 1 FROM hotel_content c
                      WHERE c.provider_code = w.provider_code AND c.hotel_id = w.hotel_id
                        AND c.source = 'details')
               AS has_details
        FROM unnest(${refs.map((r) => r.providerCode)}::text[],
                    ${refs.map((r) => r.hotelId)}::text[]) AS w(provider_code, hotel_id)`.execute(
      this.db.db,
    );
    for (const row of result.rows) {
      out.set(hotelRefKey(row.provider_code, row.hotel_id), {
        inCatalog: row.in_catalog === true,
        hasDetails: row.has_details === true,
      });
    }
    return out;
  }

  /** Guarda contenido por `hotel_catalog_store_contents` (0054), de a 50 filas. */
  async storeContents(
    providerCode: string,
    records: readonly HotelContentRecord[],
  ): Promise<HotelContentStoreResult> {
    const total = {
      inserted: 0,
      rewritten: 0,
      touched: 0,
      unchanged: 0,
      protected: 0,
      rejected: 0,
    };
    for (const chunk of chunks(records, CONTENT_STORE_CHUNK)) {
      const result = await sql<Record<keyof HotelContentStoreResult, number | string>>`
        /* hotel-catalog:store-contents */
        SELECT * FROM hotel_catalog_store_contents(${providerCode}, ${JSON.stringify(chunk)}::jsonb)`.execute(
        this.db.db,
      );
      for (const row of result.rows) {
        for (const key of Object.keys(total) as (keyof HotelContentStoreResult)[]) {
          total[key] += count(row[key]);
        }
      }
    }
    return total;
  }

  /**
   * Si el hotel está en el catálogo de su proveedor y qué respondió el proveedor la última vez que
   * se le pidieron sus habitaciones, por idioma (`hotel_room_content_fetch`, 0070). Una sola
   * consulta: una fila por idioma pedido.
   */
  async roomContentState(
    providerCode: string,
    hotelId: string,
    langs: readonly HotelContentLanguage[],
  ): Promise<HotelRoomContentState> {
    const result = await sql<{
      lang: string;
      in_catalog: boolean;
      outcome: string | null;
      room_count: number | string | null;
      fetched_at: Date | string | null;
    }>`/* hotel-catalog:room-content-state */
      SELECT w.lang,
             EXISTS (SELECT 1 FROM hotel_inventory h
                      WHERE h.provider_code = ${providerCode} AND h.hotel_id = ${hotelId})
               AS in_catalog,
             f.outcome, f.room_count, f.fetched_at
        FROM unnest(${[...langs]}::text[]) AS w(lang)
        LEFT JOIN hotel_room_content_fetch f
          ON f.provider_code = ${providerCode} AND f.hotel_id = ${hotelId} AND f.lang = w.lang`.execute(
      this.db.db,
    );
    const fetches = new Map<HotelContentLanguage, HotelRoomContentFetchState>();
    let inCatalog = false;
    for (const row of result.rows) {
      inCatalog ||= row.in_catalog === true;
      if (!isContentLanguage(row.lang) || row.outcome === null || !ROOM_OUTCOMES.has(row.outcome)) {
        continue;
      }
      const fetchedAt = row.fetched_at === null ? undefined : new Date(row.fetched_at);
      if (fetchedAt === undefined || Number.isNaN(fetchedAt.getTime())) continue;
      fetches.set(row.lang, {
        outcome: row.outcome as HotelRoomContentOutcome,
        roomCount: count(row.room_count),
        fetchedAt,
      });
    }
    return { inCatalog, fetches };
  }

  /** Las habitaciones guardadas del hotel en esos idiomas, en el orden del proveedor. */
  async roomContents(
    providerCode: string,
    hotelId: string,
    langs: readonly HotelContentLanguage[],
  ): Promise<HotelRoomContentRow[]> {
    const result = await sql<{
      lang: string;
      room_id: string;
      room_ref: string | null;
      name_key: string | null;
      name: string | null;
      size_text: string | null;
      description: string | null;
      images: unknown;
    }>`/* hotel-catalog:room-contents */
      SELECT c.lang, c.room_id, c.room_ref, c.name_key, c.name, c.size_text, c.description,
             c.images
        FROM hotel_room_content c
       WHERE c.provider_code = ${providerCode} AND c.hotel_id = ${hotelId}
         AND c.lang = ANY(${[...langs]}::text[])
       ORDER BY c.lang, c.position, c.room_id`.execute(this.db.db);
    const out: HotelRoomContentRow[] = [];
    for (const row of result.rows) {
      if (!isContentLanguage(row.lang) || typeof row.room_id !== 'string') continue;
      out.push({
        lang: row.lang,
        roomKey: row.room_id,
        roomRef: stringOrNull(row.room_ref),
        nameKey: stringOrNull(row.name_key),
        name: stringOrNull(row.name),
        sizeText: stringOrNull(row.size_text),
        description: stringOrNull(row.description),
        images: row.images,
      });
    }
    return out;
  }

  /**
   * Reemplaza las habitaciones del hotel en ese idioma y anota qué respondió el proveedor, por
   * `hotel_catalog_store_room_contents` (0070). Las habitaciones van recortadas a su tope, sólo con
   * `rooms` y con texto que `jsonb` acepta; las que la función no acepta vuelven contadas en
   * `rejected`. Lanza si el hotel no está en el catálogo de ese proveedor.
   */
  async storeRoomContents(
    providerCode: string,
    hotelId: string,
    lang: HotelContentLanguage,
    outcome: HotelRoomContentOutcome,
    rooms: readonly HotelProviderRoomContent[],
  ): Promise<HotelRoomContentStoreResult> {
    const payload =
      outcome === 'rooms'
        ? rooms.slice(0, HOTEL_ROOM_CONTENT_MAX_ROOMS).map((room) => ({
            roomKey: jsonbText(room.roomKey),
            roomRef: jsonbTextOrNull(room.roomRef),
            nameKey: jsonbText(room.nameKey),
            name: jsonbText(room.name),
            sizeText: jsonbTextOrNull(room.sizeText),
            description: jsonbTextOrNull(room.description),
            images: room.images.map(jsonbText),
          }))
        : [];
    const result = await sql<{ stored: number | string; rejected: number | string }>`
      /* hotel-catalog:store-room-contents */
      SELECT * FROM hotel_catalog_store_room_contents(${providerCode}, ${hotelId}, ${lang}, ${outcome}, ${JSON.stringify(payload)}::jsonb)`.execute(
      this.db.db,
    );
    const [row] = result.rows;
    return { stored: count(row?.stored), rejected: count(row?.rejected) };
  }

  /** La ciudad del catálogo del proveedor, o `undefined` si no la conoce. */
  async city(providerCode: string, cityCode: string): Promise<HotelCatalogCity | undefined> {
    const result = await sql<{ country_code: string; hotel_count: number | null }>`
      /* hotel-catalog:city */
      SELECT c.country_code::text AS country_code, c.hotel_count
        FROM hotel_provider_city c
       WHERE c.provider_code = ${providerCode} AND c.provider_city_code = ${cityCode}`.execute(
      this.db.db,
    );
    const [row] = result.rows;
    if (row === undefined) return undefined;
    return {
      countryCode: String(row.country_code).trim().toUpperCase(),
      neverLoaded: row.hotel_count === null,
    };
  }

  /** Carga los hoteles de una ciudad sin hoteles activos por `hotel_catalog_import_city` (0054). */
  async importCity(
    providerCode: string,
    cityCode: string,
    hotels: readonly HotelCatalogRecord[],
  ): Promise<HotelCityImportResult> {
    const rows = hotels.slice(0, HOTEL_CITY_IMPORT_MAX_HOTELS).map((h) => ({
      hotelId: h.hotelId,
      name: h.name,
      stars: h.stars,
      latitude: h.location?.lat ?? null,
      longitude: h.location?.lng ?? null,
      address: h.address,
      zipcode: h.zipcode,
      countryCode: h.countryCode,
    }));
    const result = await sql<{ outcome: string; active_hotels: number | string }>`
      /* hotel-catalog:import-city */
      SELECT * FROM hotel_catalog_import_city(${providerCode}, ${cityCode}, ${JSON.stringify(rows)}::jsonb)`.execute(
      this.db.db,
    );
    const [row] = result.rows;
    const outcome = row?.outcome;
    return {
      outcome:
        outcome !== undefined && IMPORT_OUTCOMES.has(outcome)
          ? (outcome as HotelCityImportOutcome)
          : 'unknown-city',
      activeHotels: count(row?.active_hotels),
    };
  }
}

/** Clave de un hotel de un proveedor. El separador no puede aparecer en un código de proveedor. */
export function hotelRefKey(providerCode: string, hotelId: string): string {
  return `${providerCode} ${hotelId}`;
}
