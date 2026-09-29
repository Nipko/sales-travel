import type { output, ZodTypeAny } from 'zod';
import type {
  TboCatalogHotel,
  TboContentLanguage,
  TboContentSource,
  TboHotelContent,
} from './content.types';
import {
  classifyTboFacility,
  sanitizeTboHtml,
  splitTboDescriptionSections,
  tboHtmlToText,
} from './html-sanitizer';
import {
  joinTboAttractions,
  normalizeTboCheckTime,
  normalizeTboCountryCode,
  normalizeTboImageUrl,
  normalizeTboLatLng,
  normalizeTboMap,
  normalizeTboStars,
  normalizeTboText,
  normalizeTboWebsiteUrl,
  toTboTextList,
} from './normalize';
import type { TboStaticObserver } from './observer';
import {
  TboAttractionsFieldSchema,
  TboCoordinateFieldSchema,
  TboListFieldSchema,
  TboRatingFieldSchema,
  TboStaticCodeSchema,
  TboTextFieldSchema,
} from './response.schema';

/**
 * Un hotel de TBOHotelCodeList (p. 66-69) o de HotelDetails (p. 58-62) → su fila de catálogo y su
 * contenido (docs/tbo/05 §3-§4, §7). Los dos métodos comparten los campos y se contradicen en sus
 * tipos (CE-01, CE-02, CE-10), así que se leen con el mismo código.
 *
 * Cada campo se lee por separado y uno ilegible se ignora con una nota: el hotel sigue. Las claves
 * se buscan sin distinguir mayúsculas porque la tabla y el ejemplo no coinciden
 * (`HotelWebsiteURL` / `HotelWebsiteUrl`, CE-09).
 */

/** Techos de texto: recortan, no descartan. Holgados frente a lo observado (p. 62, 67-69). */
const MAX_NAME = 300;
const MAX_ADDRESS = 500;
const MAX_ZIPCODE = 20;
const MAX_PHONE = 50;
const MAX_FACILITIES = 200;
const MAX_IMAGES = 100;

export interface TboHotelRecordScope {
  readonly observer: TboStaticObserver;
  /** Ruta del elemento para los issues (`Hotels.3`), sin valores. */
  readonly at: string;
  readonly hotelId: string;
  readonly lang: TboContentLanguage;
  readonly source: TboContentSource;
  /**
   * `listing`: el `CityCode` de la request, que manda sobre cualquier `CityId` de la respuesta
   * (05 §2.5). `details`: `undefined`, y la ciudad sale de `CityId`.
   */
  readonly requestCityCode?: string;
  /** País con que se pidió la ciudad: respaldo de un `CountryCode` inválido (05 §3). */
  readonly fallbackCountryCode?: string;
  /**
   * Leer `Latitude`/`Longitude` antes que `Map`. Sólo TBOHotelCodeList, que las manda sin que el PDF
   * las documente (producción, 2026-09-29); en HotelDetails no hay evidencia y no se leen.
   */
  readonly latitudeLongitude?: boolean;
}

export interface TboHotelRecord {
  readonly hotel: TboCatalogHotel;
  readonly content: TboHotelContent;
  /** Trajo algo de contenido además del catálogo: descripción, servicios, atracciones… */
  readonly hasContent: boolean;
}

type Lookup = { readonly found: false } | { readonly found: true; readonly value: unknown };

class RecordReader {
  constructor(
    private readonly record: Readonly<Record<string, unknown>>,
    private readonly scope: TboHotelRecordScope,
  ) {}

  /**
   * La clave exacta primero; si no, la única que coincide sin distinguir mayúsculas. Dos claves que
   * sólo difieren en mayúsculas son ambiguas y el campo se ignora: elegir una sería adivinar.
   */
  lookup(...names: readonly string[]): Lookup {
    for (const name of names) {
      if (Object.hasOwn(this.record, name)) return { found: true, value: this.record[name] };
    }
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const matches = Object.keys(this.record).filter((key) => wanted.has(key.toLowerCase()));
    const [key] = matches;
    if (key === undefined) return { found: false };
    const field = names[0] ?? key;
    if (matches.length > 1) {
      this.scope.observer.note('FIELD_INVALID', `${this.scope.at}.${field}:ambiguous_casing`);
      return { found: false };
    }
    this.scope.observer.note('CASING_VARIANT', `${this.scope.at}.${field}:casing_variant`);
    return { found: true, value: this.record[key] };
  }

  /** El campo según su esquema; ausente o `null` es `undefined` sin nota, otro tipo lleva nota. */
  field<S extends ZodTypeAny>(schema: S, ...names: readonly string[]): output<S> | undefined {
    const lookup = this.lookup(...names);
    if (!lookup.found || lookup.value === undefined || lookup.value === null) return undefined;
    const parsed = schema.safeParse(lookup.value);
    if (parsed.success) return parsed.data as output<S>;
    this.scope.observer.note('FIELD_INVALID', `${this.scope.at}.${names[0] ?? '?'}:invalid_type`);
    return undefined;
  }

  text(name: string, max: number): string | null {
    const value = this.field(TboTextFieldSchema, name);
    return value === undefined ? null : normalizeTboText(value, max);
  }

  note(...args: Parameters<TboStaticObserver['note']>): void {
    this.scope.observer.note(...args);
  }
}

function readStars(reader: RecordReader, at: string): number | null {
  const raw = reader.field(TboRatingFieldSchema, 'HotelRating');
  if (raw === undefined) return null;
  const read = normalizeTboStars(raw);
  if (!read.known) reader.note('STARS_UNKNOWN', `${at}.HotelRating:unknown_value`);
  return read.stars;
}

/**
 * `Latitude`/`Longitude` si la operación las trae y dan un punto válido; si no, `Map` (05 §3). Una
 * pareja inválida o `0|0` deja su nota y cede a `Map`, que puede dejar la suya.
 */
function readLocation(
  reader: RecordReader,
  scope: TboHotelRecordScope,
): TboCatalogHotel['location'] {
  const { at } = scope;
  if (scope.latitudeLongitude === true) {
    const read = normalizeTboLatLng(
      reader.field(TboCoordinateFieldSchema, 'Latitude'),
      reader.field(TboCoordinateFieldSchema, 'Longitude'),
    );
    if (read.location !== null) return read.location;
    if (read.issue !== undefined) {
      reader.note(read.issue, `${at}.Latitude:${read.issue.toLowerCase()}`);
    }
  }
  const raw = reader.field(TboTextFieldSchema, 'Map');
  if (raw === undefined) return null;
  const read = normalizeTboMap(String(raw));
  if (read.issue !== undefined) reader.note(read.issue, `${at}.Map:${read.issue.toLowerCase()}`);
  return read.location;
}

function readCountry(reader: RecordReader, scope: TboHotelRecordScope): string | null {
  const raw = reader.field(TboTextFieldSchema, 'CountryCode');
  const code = raw === undefined ? null : normalizeTboCountryCode(raw);
  if (code !== null) return code;
  if (raw !== undefined) reader.note('COUNTRY_INVALID', `${scope.at}.CountryCode:invalid_string`);
  if (scope.fallbackCountryCode === undefined) return null;
  reader.note('COUNTRY_FROM_CITY');
  return scope.fallbackCountryCode;
}

function readCityCode(reader: RecordReader, scope: TboHotelRecordScope): string | null {
  if (scope.requestCityCode !== undefined) return scope.requestCityCode;
  return reader.field(TboStaticCodeSchema, 'CityId') ?? null;
}

interface SafeHtml {
  readonly html: string | null;
  readonly text: string | null;
}

function safeHtml(reader: RecordReader, raw: string | undefined, at: string): SafeHtml {
  if (raw === undefined) return { html: null, text: null };
  const sanitized = sanitizeTboHtml(raw);
  if (sanitized.removed > 0) reader.note('HTML_SANITIZED', `${at}:sanitized`);
  const text = tboHtmlToText(sanitized.html);
  // Un HTML que sólo trae espacios o etiquetas vacías no es contenido.
  return text === null ? { html: null, text: null } : { html: sanitized.html, text };
}

interface Facilities {
  readonly available: string[];
  readonly unavailable: string[];
}

/** `HotelFacilities`, separando los negados y sin repetir (sin distinguir mayúsculas). */
function readFacilities(reader: RecordReader, at: string): Facilities {
  const raw = reader.field(TboListFieldSchema, 'HotelFacilities');
  const out: Facilities = { available: [], unavailable: [] };
  if (raw === undefined) return out;
  const list = toTboTextList(raw);
  if (list.dropped > 0) reader.note('FIELD_INVALID', `${at}.HotelFacilities:invalid_item`);
  const seen = new Set<string>();
  for (const item of list.items) {
    const facility = classifyTboFacility(item);
    if (facility === undefined) continue;
    const key = `${facility.available ? '+' : '-'}${facility.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (facility.available) {
      if (out.available.length < MAX_FACILITIES) out.available.push(facility.label);
    } else {
      reader.note('FACILITY_NEGATED');
      if (out.unavailable.length < MAX_FACILITIES) out.unavailable.push(facility.label);
    }
  }
  return out;
}

function readImages(reader: RecordReader, at: string): string[] {
  const raw = reader.field(TboListFieldSchema, 'Images');
  if (raw === undefined) return [];
  const images: string[] = [];
  const candidates = typeof raw === 'string' ? toTboTextList(raw).items : raw;
  for (const candidate of candidates) {
    const url = normalizeTboImageUrl(candidate);
    if (url === null) {
      reader.note('IMAGE_DROPPED', `${at}.Images:not_https_url`);
      continue;
    }
    if (!images.includes(url) && images.length < MAX_IMAGES) images.push(url);
  }
  return images;
}

function readWebsite(reader: RecordReader, at: string): string | null {
  // La tabla dice `HotelWebsiteURL` y el ejemplo `HotelWebsiteUrl` (p. 66, 69; CE-09).
  const raw = reader.field(TboTextFieldSchema, 'HotelWebsiteUrl', 'HotelWebsiteURL');
  if (raw === undefined) return null;
  const url = normalizeTboWebsiteUrl(String(raw));
  if (url === null && String(raw).trim().length > 0) {
    reader.note('WEBSITE_DROPPED', `${at}.HotelWebsiteUrl:not_http_url`);
  }
  return url;
}

function readCheckTime(reader: RecordReader, name: string, at: string): string | null {
  const raw = reader.field(TboTextFieldSchema, name);
  if (raw === undefined || String(raw).trim().length === 0) return null;
  const time = normalizeTboCheckTime(String(raw));
  if (time === null) reader.note('CHECK_TIME_INVALID', `${at}.${name}:unparseable`);
  return time;
}

function readAttractions(reader: RecordReader, at: string): SafeHtml {
  const raw = reader.field(TboAttractionsFieldSchema, 'Attractions');
  if (raw === undefined) return { html: null, text: null };
  const joined = joinTboAttractions(raw);
  if (joined.dropped > 0) reader.note('FIELD_INVALID', `${at}.Attractions:invalid_item`);
  return safeHtml(reader, joined.html, `${at}.Attractions`);
}

/**
 * Lee un elemento cuyo `HotelCode` ya validó el mapper. Nunca lanza: lo que no se entiende queda
 * en `null` o fuera de la lista, con su nota.
 */
export function readTboHotelRecord(
  record: Readonly<Record<string, unknown>>,
  scope: TboHotelRecordScope,
): TboHotelRecord {
  const reader = new RecordReader(record, scope);
  const { at } = scope;
  const name = reader.text('HotelName', MAX_NAME);

  const hotel: TboCatalogHotel = {
    hotelId: scope.hotelId,
    name,
    stars: readStars(reader, at),
    location: readLocation(reader, scope),
    address: reader.text('Address', MAX_ADDRESS),
    zipcode: reader.text('PinCode', MAX_ZIPCODE),
    countryCode: readCountry(reader, scope),
    cityCode: readCityCode(reader, scope),
  };

  const descriptionRaw = reader.field(TboTextFieldSchema, 'Description');
  const description = safeHtml(
    reader,
    descriptionRaw === undefined ? undefined : String(descriptionRaw),
    `${at}.Description`,
  );
  const facilities = readFacilities(reader, at);
  const attractions = readAttractions(reader, at);
  const images = readImages(reader, at);
  const phone = reader.text('PhoneNumber', MAX_PHONE);
  const websiteUrl = readWebsite(reader, at);
  const checkInTime = readCheckTime(reader, 'CheckInTime', at);
  const checkOutTime = readCheckTime(reader, 'CheckOutTime', at);

  const content: TboHotelContent = {
    hotelId: scope.hotelId,
    lang: scope.lang,
    source: scope.source,
    name,
    descriptionHtml: description.html,
    descriptionText: description.text,
    sections: description.html === null ? [] : splitTboDescriptionSections(description.html),
    facilities: facilities.available,
    unavailableFacilities: facilities.unavailable,
    attractionsHtml: attractions.html,
    images,
    phone,
    websiteUrl,
    checkInTime,
    checkOutTime,
  };

  const hasContent =
    description.html !== null ||
    attractions.html !== null ||
    facilities.available.length > 0 ||
    facilities.unavailable.length > 0 ||
    images.length > 0 ||
    phone !== null ||
    websiteUrl !== null ||
    checkInTime !== null ||
    checkOutTime !== null;

  return { hotel, content, hasContent };
}
