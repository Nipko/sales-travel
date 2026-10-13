import { createHash } from 'node:crypto';
import type { TboRoomContent, TboRoomDetailShape } from './content.types';
import { tboHtmlToText } from './html-sanitizer';
import { tboImageUrl } from './image-hosts';
import { normalizeTboText } from './normalize';
import type { TboStaticObserver } from './observer';
import { TBO_HOTEL_FIELD_KEYS } from './response.schema';

/**
 * El detalle por habitación de HotelDetails (`IsRoomDetailRequired: true`, p. 56-57; docs/tbo/05
 * §2.6.3; Q-65), leído sin saber su forma.
 *
 * El PDF nombra los campos de una habitación (`RoomName`, `RoomId` numérico, `RoomSize` "1830 ft",
 * `RoomDescription`, `imageURL` como lista) pero no dice bajo qué clave ni en qué nivel vienen, y
 * no trae una respuesta completa. Hasta tener un fixture real (TBO-10) el lector acepta las formas
 * plausibles, se queda con la primera que encuentra y DICE cuál fue (`shape`, métrica y log sin
 * valores). Nunca lanza: lo que no entiende queda fuera con su nota, y el contenido del hotel no
 * depende de nada de esto.
 *
 * Dónde busca, en orden:
 *
 * 1. En el hotel, bajo una clave conocida ({@link TBO_ROOM_CONTAINER_KEYS}, sin distinguir
 *    mayúsculas): una lista (`array`, una lista de listas se aplana un nivel), un objeto de objetos
 *    indexado por id (`map`) o un objeto que ya es una habitación (`single`).
 * 2. En la raíz, bajo las mismas claves, con el `HotelCode` del hotel en cada elemento (`root`). Sin
 *    `HotelCode` sólo se atribuye si la respuesta tiene un único hotel.
 * 3. Entre los demás valores del hotel, una lista de objetos con al menos dos campos de habitación
 *    (`heuristic`): se usa y se loguea el NOMBRE de la clave.
 *
 * Si nada de eso aparece, `none`, con un `warn` que lista las claves del hotel y el tipo JSON de cada
 * una (nunca los valores) para ver qué mandó TBO.
 */

export const TBO_ROOM_DETAIL_LIMITS = Object.freeze({
  maxRoomsPerHotel: 100,
  maxImagesPerRoom: 30,
  maxNameLength: 300,
  maxSizeTextLength: 60,
  maxDescriptionLength: 4_000,
  /** Entradas `Clave:tipo` del log de un hotel sin bloque de habitaciones. */
  maxHotelKeyShapes: 40,
  /** Elementos que se miran por contenedor: una lista enorme no se recorre entera. */
  maxScannedItems: 500,
  /** URLs candidatas que se miran por habitación. */
  maxScannedImages: 200,
} as const);

/** Claves que contienen habitaciones, en orden de preferencia. Se comparan sin mayúsculas. */
export const TBO_ROOM_CONTAINER_KEYS: readonly string[] = Object.freeze([
  'Rooms',
  'RoomDetails',
  'RoomDetail',
  'RoomInfo',
  'RoomInformation',
  'HotelRooms',
  'RoomList',
  'RoomData',
  'RoomTypes',
  'Room',
]);

/**
 * Alias de cada campo de una habitación, en orden de preferencia. Los del PDF primero (`RoomName`,
 * `RoomId`, `RoomSize`, `RoomDescription`, `imageURL`); el resto son los nombres que usan otros
 * bancos de camas y las variantes de casing que TBO ya mostró en otros métodos (CE-09).
 */
const FIELD_ALIASES = Object.freeze({
  id: ['RoomId', 'RoomID', 'RoomTypeId', 'RoomTypeID', 'RoomCode', 'Id'],
  name: ['RoomName', 'Name', 'RoomType', 'RoomTypeName'],
  size: ['RoomSize', 'Size', 'RoomArea', 'Area'],
  description: ['RoomDescription', 'Description', 'RoomDesc', 'RoomFeatures', 'Details'],
  images: [
    'imageURL',
    'ImageURL',
    'ImageUrl',
    'ImageUrls',
    'ImageURLs',
    'Images',
    'RoomImages',
    'Image',
    'Photos',
  ],
} as const);

type FieldGroup = keyof typeof FIELD_ALIASES;

const FIELD_GROUPS = Object.keys(FIELD_ALIASES) as FieldGroup[];

/** Las claves de una imagen dada como objeto: `{ "Url": "…" }`. */
const IMAGE_OBJECT_KEYS = ['Url', 'URL', 'ImageUrl', 'Path', 'Src'] as const;

const lower = (keys: readonly string[]): string[] => [...new Set(keys.map((k) => k.toLowerCase()))];

const CONTAINER_KEYS_LOWER = lower(TBO_ROOM_CONTAINER_KEYS);
const HOTEL_CODE_LOWER = 'hotelcode';

/** Lo que se espera dentro de una habitación; el resto se registra por NOMBRE. */
const ROOM_KNOWN_KEYS: readonly string[] = lower([
  ...FIELD_GROUPS.flatMap((group) => FIELD_ALIASES[group]),
  'HotelCode',
]);

/** Lo que se espera en un envoltorio de la raíz: `{ "HotelCode": …, "Rooms": [ … ] }`. */
const WRAPPER_KNOWN_KEYS: readonly string[] = [HOTEL_CODE_LOWER, ...CONTAINER_KEYS_LOWER];

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ZEROS = /^0+$/;

/**
 * La clave de comparación de un nombre de habitación: NFKD, sin diacríticos, en minúsculas y todo lo
 * que no sea `[a-z0-9]` como un espacio, colapsado y recortado. ESPEJO de `normalizeRoomName` de la
 * web (`apps/web-b2b/…/hoteles/_components/room-type-groups.ts`): las dos se prueban con la misma
 * tabla `ROOM_NAME_VECTORS`, así que una no cambia sin que la otra se ponga roja.
 */
export function normalizeTboRoomName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `n-` y 16 hex del SHA-256 de la clave de nombre: la identidad de una habitación sin id. */
export function tboSyntheticRoomKey(nameKey: string): string {
  return `n-${createHash('sha256').update(nameKey, 'utf8').digest('hex').slice(0, 16)}`;
}

export interface TboRoomDetailScope {
  readonly observer: TboStaticObserver;
  /** Ruta del hotel para los issues (`HotelDetails.0`), sin valores. */
  readonly at: string;
  readonly hotelId: string;
  /**
   * La respuesta es de un solo hotel: las habitaciones de la raíz sin `HotelCode` son suyas. Con
   * varios no se sabe de quién son y no se atribuyen.
   */
  readonly soleHotel?: boolean;
}

export interface TboRoomDetailRead {
  readonly rooms: readonly TboRoomContent[];
  readonly shape: TboRoomDetailShape;
  /** La clave del HOTEL que el lector consumió, con su grafía. Deja de ser desconocida. */
  readonly hotelKey?: string;
  /** La clave de la RAÍZ que consumió (`root`). Deja de ser desconocida. */
  readonly rootKey?: string;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Las claves de `record` que coinciden con `alias` sin distinguir mayúsculas, en su orden. */
function keysFor(record: Json, alias: string): string[] {
  const wanted = alias.toLowerCase();
  return Object.keys(record).filter((key) => key.toLowerCase() === wanted);
}

/** El primer alias presente y no nulo, por orden de preferencia. */
function pick(
  record: Json,
  aliases: readonly string[],
): { key: string; value: unknown } | undefined {
  for (const alias of aliases) {
    for (const key of keysFor(record, alias)) {
      const value = record[key];
      if (value !== undefined && value !== null) return { key, value };
    }
  }
  return undefined;
}

/** Cuántos grupos de campo de habitación trae un objeto (id, nombre, tamaño, descripción, fotos). */
function roomFieldGroups(record: Json): number {
  return FIELD_GROUPS.filter((group) => pick(record, FIELD_ALIASES[group]) !== undefined).length;
}

/** `Clave:tipoJSON` de cada clave del hotel. Nunca el valor. */
function keyShapes(hotel: Json): string[] {
  return Object.keys(hotel)
    .slice(0, TBO_ROOM_DETAIL_LIMITS.maxHotelKeyShapes)
    .map((key) => {
      const value = hotel[key];
      // En una lista, el tipo de su primer elemento: `Rooms:array<object>`, `Images:array<string>`.
      const type = isList(value)
        ? `array<${value.length === 0 ? 'empty' : scalarType(value[0])}>`
        : scalarType(value);
      return `${key.slice(0, 60)}:${type}`;
    });
}

function scalarType(value: unknown): string {
  if (value === null) return 'null';
  if (isList(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

// ───────────────────────── Contenedores ─────────────────────────

interface Candidate {
  readonly raw: Json;
  /** El índice del `map` como respaldo del id, si no parece una posición. */
  readonly fallbackId?: string;
  /** Prefijo de la ruta para las claves desconocidas (`HotelDetails[].Rooms[].`). */
  readonly prefix: string;
}

type ContainerShape = 'array' | 'map' | 'single' | 'unreadable';

/**
 * Un contenedor vacío (`[]`, `{}`) es `array` o `map` sin candidatas: TBO dijo "sin habitaciones",
 * que no es lo mismo que algo que no entendimos (`unreadable`).
 */
interface ContainerRead {
  readonly shape: ContainerShape;
  readonly candidates: readonly Candidate[];
}

/** `{"0": …, "1": …}` o `{"1": …, "2": …}`: el índice es una posición, no un id. */
function positionalKeys(keys: readonly string[]): boolean {
  const numbers = keys.map((key) => (/^\d+$/.test(key) ? Number(key) : Number.NaN));
  if (numbers.some(Number.isNaN)) return false;
  const sorted = [...numbers].sort((a, b) => a - b);
  const start = sorted[0] ?? 0;
  return (start === 0 || start === 1) && sorted.every((n, i) => n === start + i);
}

function readContainer(
  value: unknown,
  prefix: string,
  scope: TboRoomDetailScope,
  issueAt: string,
): ContainerRead {
  const { maxScannedItems } = TBO_ROOM_DETAIL_LIMITS;
  if (isList(value)) {
    const scanned = value
      .slice(0, maxScannedItems)
      .flatMap((item) => (isList(item) ? item : [item]))
      .slice(0, maxScannedItems);
    const records = scanned.filter(isRecord);
    if (records.length < scanned.length) {
      scope.observer.note('FIELD_INVALID', `${issueAt}[]:invalid_type`);
    }
    return {
      shape: records.length === 0 && value.length > 0 ? 'unreadable' : 'array',
      candidates: records.map((raw) => ({ raw, prefix: `${prefix}[].` })),
    };
  }
  if (isRecord(value)) {
    if (roomFieldGroups(value) > 0) {
      return { shape: 'single', candidates: [{ raw: value, prefix: `${prefix}.` }] };
    }
    const entries = Object.entries(value).slice(0, maxScannedItems);
    if (entries.length === 0) return { shape: 'map', candidates: [] };
    const usable = entries.filter((entry): entry is [string, Json] => isRecord(entry[1]));
    if (usable.length === 0) {
      scope.observer.note('FIELD_INVALID', `${issueAt}:invalid_type`);
      return { shape: 'unreadable', candidates: [] };
    }
    const positional = positionalKeys(entries.map(([key]) => key));
    return {
      shape: 'map',
      candidates: usable.map(([key, raw]) => ({
        raw,
        prefix: `${prefix}{}.`,
        ...(positional ? {} : { fallbackId: key }),
      })),
    };
  }
  scope.observer.note('FIELD_INVALID', `${issueAt}:invalid_type`);
  return { shape: 'unreadable', candidates: [] };
}

/** La primera clave contenedora presente y no nula de `record`, por orden de preferencia. */
function findContainer(record: Json): { key: string; value: unknown } | undefined {
  return pick(record, TBO_ROOM_CONTAINER_KEYS);
}

function sameHotel(value: unknown, hotelId: string): boolean {
  return (
    (typeof value === 'string' || typeof value === 'number') && String(value).trim() === hotelId
  );
}

interface Located {
  readonly shape: TboRoomDetailShape;
  readonly candidates: readonly Candidate[];
  readonly hotelKey?: string;
  readonly rootKey?: string;
}

/** Las habitaciones de un elemento de la raíz que ya se sabe que son de este hotel. */
function fromRootElement(element: Json, prefix: string, scope: TboRoomDetailScope): Candidate[] {
  const nested = findContainer(element);
  if (nested === undefined) {
    if (roomFieldGroups(element) > 0) return [{ raw: element, prefix: `${prefix}[].` }];
    scope.observer.collectUnknownKeys(element, WRAPPER_KNOWN_KEYS, `${prefix}[].`);
    return [];
  }
  scope.observer.collectUnknownKeys(element, WRAPPER_KNOWN_KEYS, `${prefix}[].`);
  return [
    ...readContainer(nested.value, `${prefix}[].${nested.key}`, scope, `${prefix}[].${nested.key}`)
      .candidates,
  ];
}

function locateAtRoot(root: unknown, scope: TboRoomDetailScope): Located | undefined {
  if (!isRecord(root)) return undefined;
  const found = findContainer(root);
  if (found === undefined) return undefined;
  const { key, value } = found;
  const { hotelId } = scope;
  const sole = scope.soleHotel === true;
  const elements = isList(value)
    ? value.slice(0, TBO_ROOM_DETAIL_LIMITS.maxScannedItems).filter(isRecord)
    : isRecord(value)
      ? [value]
      : [];

  // `{ "Rooms": { "1000000": [ … ] } }`: indexado por hotel.
  if (isRecord(value) && Object.hasOwn(value, hotelId)) {
    const read = readContainer(value[hotelId], `${key}{}`, scope, `${key}.${hotelId}`);
    return { shape: 'root', candidates: read.candidates, rootKey: key };
  }

  const coded = elements.filter((element) => pick(element, ['HotelCode']) !== undefined);
  const mine = coded.filter((element) => sameHotel(pick(element, ['HotelCode'])?.value, hotelId));
  const uncoded = elements.filter((element) => pick(element, ['HotelCode']) === undefined);
  const candidates = [
    ...mine.flatMap((element) => fromRootElement(element, key, scope)),
    ...(sole ? uncoded.flatMap((element) => fromRootElement(element, key, scope)) : []),
  ];
  const emptyContainer =
    (isList(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
  // Con elementos de este hotel, con un contenedor sólo de otros hoteles (TBO no mandó habitaciones
  // de éste) o vacío: `root`.
  if (candidates.length > 0 || mine.length > 0 || coded.length > 0 || emptyContainer) {
    return { shape: 'root', candidates, rootKey: key };
  }
  // Sin `HotelCode` y con varios hoteles no se sabe de quién son; sin objetos, no se entiende.
  scope.observer.note(
    'FIELD_INVALID',
    elements.length === 0 ? `${key}:invalid_type` : `${key}[].HotelCode:missing`,
  );
  return { shape: 'unreadable', candidates: [], rootKey: key };
}

function locateHeuristic(hotel: Json, scope: TboRoomDetailScope): Located | undefined {
  const known = new Set([...TBO_HOTEL_FIELD_KEYS, ...CONTAINER_KEYS_LOWER]);
  for (const key of Object.keys(hotel)) {
    if (known.has(key.toLowerCase())) continue;
    const value = hotel[key];
    if (!isList(value)) continue;
    const records = value
      .slice(0, 5)
      .flatMap((item) => (isList(item) ? item : [item]))
      .filter(isRecord);
    if (!records.some((record) => roomFieldGroups(record) >= 2)) continue;
    scope.observer.warnOnce('tbo.static.room_container_heuristic', {
      roomContainerKey: key.slice(0, 60),
      roomShape: 'heuristic',
    });
    const read = readContainer(value, `HotelDetails[].${key}`, scope, `${scope.at}.${key}`);
    return { shape: 'heuristic', candidates: read.candidates };
  }
  return undefined;
}

function locate(hotel: Json, root: unknown, scope: TboRoomDetailScope): Located {
  const own = findContainer(hotel);
  if (own !== undefined) {
    const read = readContainer(
      own.value,
      `HotelDetails[].${own.key}`,
      scope,
      `${scope.at}.${own.key}`,
    );
    return { shape: read.shape, candidates: read.candidates, hotelKey: own.key };
  }
  // Una clave contenedora presente pero `null` no es un bloque; tampoco se registra como desconocida.
  const nullKey = Object.keys(hotel).find((key) =>
    CONTAINER_KEYS_LOWER.includes(key.toLowerCase()),
  );
  const atRoot = locateAtRoot(root, scope);
  if (atRoot !== undefined)
    return nullKey === undefined ? atRoot : { ...atRoot, hotelKey: nullKey };
  const heuristic = locateHeuristic(hotel, scope);
  if (heuristic !== undefined) return heuristic;
  return { shape: 'none', candidates: [], ...(nullKey === undefined ? {} : { hotelKey: nullKey }) };
}

// ───────────────────────── Campos ─────────────────────────

type IdRead =
  | { readonly id: string }
  | { readonly id: null; readonly note?: 'missing' | 'invalid' };

/** Número, texto o lista de UN elemento → id; `0` es "sin mapeo" (p. 57). */
function normalizeRoomId(value: unknown): IdRead {
  let raw = value;
  if (isList(raw)) {
    if (raw.length === 0) return { id: null, note: 'missing' };
    if (raw.length > 1) return { id: null, note: 'invalid' };
    raw = raw[0];
  }
  if (raw === undefined || raw === null) return { id: null, note: 'missing' };
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return { id: null, note: 'invalid' };
    raw = String(raw);
  }
  if (typeof raw !== 'string') return { id: null, note: 'invalid' };
  const text = raw.trim();
  if (text.length === 0 || ZEROS.test(text)) return { id: null, note: 'missing' };
  return ROOM_ID.test(text) ? { id: text } : { id: null, note: 'invalid' };
}

function readName(record: Json, at: string, scope: TboRoomDetailScope): string | null {
  const found = pick(record, FIELD_ALIASES.name);
  if (found === undefined) return null;
  if (typeof found.value !== 'string') {
    scope.observer.note('FIELD_INVALID', `${at}.${found.key}:invalid_type`);
    return null;
  }
  return normalizeTboText(found.value, Number.MAX_SAFE_INTEGER);
}

function readSize(record: Json, at: string, scope: TboRoomDetailScope): string | null {
  const found = pick(record, FIELD_ALIASES.size);
  if (found === undefined) return null;
  if (typeof found.value === 'string' || typeof found.value === 'number') {
    return normalizeTboText(found.value, TBO_ROOM_DETAIL_LIMITS.maxSizeTextLength);
  }
  scope.observer.note('FIELD_INVALID', `${at}.${found.key}:invalid_type`);
  return null;
}

function readDescription(record: Json, at: string, scope: TboRoomDetailScope): string | null {
  const found = pick(record, FIELD_ALIASES.description);
  if (found === undefined) return null;
  let html: string;
  if (typeof found.value === 'string') {
    html = found.value;
  } else if (isList(found.value)) {
    const parts = found.value.filter((part): part is string => typeof part === 'string');
    if (parts.length < found.value.length) {
      scope.observer.note('FIELD_INVALID', `${at}.${found.key}:invalid_item`);
    }
    html = parts
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('; ');
  } else {
    scope.observer.note('FIELD_INVALID', `${at}.${found.key}:invalid_type`);
    return null;
  }
  const text = tboHtmlToText(html);
  if (text === null) return null;
  // Texto plano para mostrar: un `<` o `>` que quedó (entidad decodificada o suelto) no se guarda.
  if (!/[<>]/.test(text)) return text.slice(0, TBO_ROOM_DETAIL_LIMITS.maxDescriptionLength);
  scope.observer.note('HTML_SANITIZED', `${at}.${found.key}:angle_brackets`);
  const plain = text
    .replace(/[<>]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim();
  return plain.length === 0 ? null : plain.slice(0, TBO_ROOM_DETAIL_LIMITS.maxDescriptionLength);
}

/** Las URLs candidatas de un valor de imagen: texto con una o varias, lista u objetos con `Url`. */
function imageTexts(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return value.split(/[\s,|]+/).filter((text) => text.length > 0);
  if (isRecord(value)) {
    const found = pick(value, IMAGE_OBJECT_KEYS);
    return found === undefined ? [] : imageTexts(found.value, depth + 1);
  }
  if (isList(value) && depth < 2) return value.flatMap((item) => imageTexts(item, depth + 1));
  return [];
}

/**
 * Una URL de foto de habitación, sólo de un dominio de TBO. Sin esquema (`www.tboholidays.com/…`,
 * `//…`) o con `http`, se pide por `https` (el proxy de imágenes sólo sale por `https`, 05 §10).
 */
function roomImageUrl(
  raw: string,
): { readonly url: string; readonly upgraded: boolean } | undefined {
  let text = raw.trim();
  let upgraded = false;
  if (text.startsWith('//')) {
    text = `https:${text}`;
    upgraded = true;
  } else if (/^http:\/\//i.test(text)) {
    text = `https://${text.slice('http://'.length)}`;
    upgraded = true;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    text = `https://${text}`;
    upgraded = true;
  }
  const url = tboImageUrl(text);
  return url === undefined ? undefined : { url, upgraded };
}

function readImages(record: Json, at: string, scope: TboRoomDetailScope): string[] {
  const { maxImagesPerRoom, maxScannedImages } = TBO_ROOM_DETAIL_LIMITS;
  const images: string[] = [];
  const seenKeys = new Set<string>();
  for (const alias of FIELD_ALIASES.images) {
    for (const key of keysFor(record, alias)) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const value = record[key];
      if (value === undefined || value === null) continue;
      const texts = imageTexts(value);
      // Una lista o un texto vacíos dicen "sin fotos"; otra cosa sin URLs no se entiende.
      const blank = (isList(value) && value.length === 0) || value === '';
      if (texts.length === 0 && !blank) {
        scope.observer.note('FIELD_INVALID', `${at}.${key}:invalid_type`);
      }
      for (const text of texts.slice(0, maxScannedImages)) {
        const image = roomImageUrl(text);
        if (image === undefined) {
          scope.observer.note('IMAGE_DROPPED', `${at}.${key}:not_tbo_https_url`);
          continue;
        }
        if (images.includes(image.url)) continue;
        if (images.length >= maxImagesPerRoom) {
          scope.observer.note('IMAGE_DROPPED', `${at}.${key}:over_limit`);
          continue;
        }
        if (image.upgraded) scope.observer.note('IMAGE_HTTPS_UPGRADED', `${at}.${key}:upgraded`);
        images.push(image.url);
      }
    }
  }
  return images;
}

function readRoom(
  candidate: Candidate,
  at: string,
  scope: TboRoomDetailScope,
): TboRoomContent | undefined {
  const { raw, fallbackId } = candidate;
  scope.observer.collectUnknownKeys(raw, ROOM_KNOWN_KEYS, candidate.prefix);

  const idField = pick(raw, FIELD_ALIASES.id);
  const idRead =
    idField !== undefined
      ? normalizeRoomId(idField.value)
      : fallbackId !== undefined
        ? normalizeRoomId(fallbackId)
        : ({ id: null, note: 'missing' } as const);

  const fullName = readName(raw, at, scope);
  const nameKey = normalizeTboRoomName(fullName ?? '')
    .slice(0, TBO_ROOM_DETAIL_LIMITS.maxNameLength)
    .trim();
  if (idRead.id === null && nameKey.length === 0) {
    scope.observer.note('ROOM_EMPTY', `${at}:no_id_no_name`);
    return undefined;
  }
  if (idRead.id === null && idRead.note === 'invalid') {
    scope.observer.note('ROOM_ID_INVALID', `${at}.${idField?.key ?? 'Id'}:invalid`);
  } else if (idRead.id === null) {
    scope.observer.note('ROOM_ID_MISSING', `${at}.RoomId:missing`);
  }

  return {
    roomKey: idRead.id ?? tboSyntheticRoomKey(nameKey),
    roomId: idRead.id,
    nameKey,
    name: (fullName ?? '').slice(0, TBO_ROOM_DETAIL_LIMITS.maxNameLength).trim(),
    sizeText: readSize(raw, at, scope),
    description: readDescription(raw, at, scope),
    images: readImages(raw, at, scope),
  };
}

function readRooms(candidates: readonly Candidate[], scope: TboRoomDetailScope): TboRoomContent[] {
  const rooms: TboRoomContent[] = [];
  const keys = new Set<string>();
  candidates.forEach((candidate, index) => {
    const at = `${scope.at}.rooms.${index}`;
    if (rooms.length >= TBO_ROOM_DETAIL_LIMITS.maxRoomsPerHotel) {
      scope.observer.note('ROOM_LIMIT', `${scope.at}.rooms:over_limit`);
      return;
    }
    const room = readRoom(candidate, at, scope);
    if (room === undefined) return;
    if (keys.has(room.roomKey)) {
      scope.observer.note('ROOM_DUPLICATE', `${at}:duplicated_room_key`);
      return;
    }
    keys.add(room.roomKey);
    rooms.push(room);
  });
  return rooms;
}

/**
 * El detalle por habitación de UN hotel de HotelDetails. `hotel` es el elemento crudo de
 * `HotelDetails[]` y `root`, el sobre entero. Nunca lanza.
 */
export function readTboRoomDetails(
  hotel: unknown,
  root: unknown,
  scope: TboRoomDetailScope,
): TboRoomDetailRead {
  let read: TboRoomDetailRead;
  try {
    read = readSafely(hotel, root, scope);
  } catch {
    // Un caso que nadie previó no le quita al hotel su contenido: se cuenta como ilegible.
    scope.observer.note('FIELD_INVALID', `${scope.at}:room_detail_unreadable`);
    read = { rooms: [], shape: 'unreadable' };
  }
  scope.observer.count('tbo.hotelDetails.room_detail', { shape: read.shape });
  return read;
}

function readSafely(hotel: unknown, root: unknown, scope: TboRoomDetailScope): TboRoomDetailRead {
  if (!isRecord(hotel)) return { rooms: [], shape: 'unreadable' };
  const located = locate(hotel, root, scope);
  const keys = {
    ...(located.hotelKey === undefined ? {} : { hotelKey: located.hotelKey }),
    ...(located.rootKey === undefined ? {} : { rootKey: located.rootKey }),
  };
  if (located.shape === 'none') {
    scope.observer.warnOnce('tbo.static.room_container_not_found', {
      roomShape: 'none',
      hotelKeyShapes: keyShapes(hotel),
    });
    return { rooms: [], shape: 'none', ...keys };
  }
  const rooms = readRooms(located.candidates, scope);
  // Había algo que leer y no salió ninguna habitación: no es "sin habitaciones", es ilegible.
  const unreadable =
    located.shape === 'unreadable' || (rooms.length === 0 && located.candidates.length > 0);
  if (unreadable) {
    scope.observer.warnOnce('tbo.static.room_container_unreadable', {
      roomShape: 'unreadable',
      ...(located.hotelKey === undefined && located.rootKey === undefined
        ? {}
        : { roomContainerKey: (located.hotelKey ?? located.rootKey ?? '').slice(0, 60) }),
    });
    return { rooms: [], shape: 'unreadable', ...keys };
  }
  return { rooms, shape: located.shape, ...keys };
}
