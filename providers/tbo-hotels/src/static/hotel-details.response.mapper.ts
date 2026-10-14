import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';
import {
  TBO_CONTENT_LANGUAGES,
  type TboCatalogHotel,
  type TboContentLanguage,
  type TboHotelContent,
  type TboHotelDetailsMapping,
  type TboHotelRoomContents,
} from './content.types';
import { readTboHotelRecord } from './hotel-record';
import { TboStaticObserver, type TboStaticMapDeps } from './observer';
import { readTboRoomDetails, type TboRoomDetailRead } from './room-detail.reader';
import {
  TBO_HOTEL_FIELD_KEYS,
  TBO_STATIC_ROOT_KEYS,
  TboHotelItemSchema,
  TboStaticCodeSchema,
  type TboHotelDetailsEnvelope,
} from './response.schema';

/**
 * `POST HotelDetails` → contenido `details` por idioma (docs/tbo/05 §2.6, p. 56-62). Etapa E4 del
 * sync y lectura bajo demanda de un solo hotel (PR-3.6).
 *
 * - `HotelRating` llega como número (`5`, p. 62), `Attractions` como objeto `{"1) ": …}` (p. 61) y
 *   `CheckInTime` como `"3:00 PM"` (p. 62): se normalizan a 1-5, un único HTML saneado y `HH:mm`.
 * - Las imágenes quedan sólo si son `https` (RNF-16).
 * - **El detalle por habitación sólo se lee si se pidió** (`roomDetail`; RF-32; 05 §2.6.3; Q-65).
 *   Sin pedirlo, un contenedor de habitaciones que TBO mande igual sólo se registra por el NOMBRE
 *   de su clave como desconocida, y la salida es la de siempre con `roomContents` vacío. Pedido, cada
 *   hotel mapeado pasa por `readTboRoomDetails`, que no sabe dónde viene el bloque y lo busca; las
 *   claves que consumió dejan de ser desconocidas. Un fallo del lector nunca le quita al hotel su
 *   contenido.
 * - Un código que no se pidió se descarta; uno pedido que no vuelve se informa en
 *   `missingHotelCodes`, porque no se sabe si un código inexistente tumba el lote (Q-62).
 * - El lote que TBO contesta con "No Hotels Found" (05 CE-23) no llega aquí: el cliente lo arma con
 *   {@link emptyTboHotelDetailsMapping}, sin nada que mapear.
 */
export interface TboHotelDetailsMapContext {
  readonly lang: TboContentLanguage;
  /** Los códigos del request, en su orden. */
  readonly hotelCodes: readonly string[];
  /** Se pidió `IsRoomDetailRequired`: leer el bloque de habitaciones de cada hotel. */
  readonly roomDetail?: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readContext(context: TboHotelDetailsMapContext): readonly string[] {
  const issues: string[] = [];
  if (!TBO_CONTENT_LANGUAGES.includes(context.lang)) issues.push('context.lang:invalid_enum_value');
  const codes: string[] = [];
  context.hotelCodes.forEach((code, index) => {
    const parsed = TboStaticCodeSchema.safeParse(code);
    if (parsed.success) codes.push(parsed.data);
    else issues.push(...zodIssueRefs(parsed.error, `context.hotelCodes.${index}`));
  });
  if (codes.length === 0 && issues.length === 0) issues.push('context.hotelCodes:too_small');
  if (issues.length > 0) {
    throw new TboResponseMappingError(TBO_OPERATIONS.hotelDetails.path, issues);
  }
  return codes;
}

export function mapTboHotelDetailsResponse(
  envelope: TboHotelDetailsEnvelope,
  context: TboHotelDetailsMapContext,
  deps: TboStaticMapDeps = {},
): TboHotelDetailsMapping {
  const requested = readContext(context);
  const pending = new Set(requested);
  const roomDetail = context.roomDetail === true;
  const observer = new TboStaticObserver('hotelDetails', deps);
  observer.assertSuccess(envelope.Status);
  // Con el detalle por habitación, las claves de la raíz se miran al final: el lector puede haber
  // consumido un contenedor de la raíz (`root`).
  if (!roomDetail) observer.collectUnknownKeys(envelope, TBO_STATIC_ROOT_KEYS.hotelDetails, '');

  const contents: TboHotelContent[] = [];
  const hotels: TboCatalogHotel[] = [];
  const roomContents: TboHotelRoomContents[] = [];
  const consumedRootKeys = new Set<string>();
  const seen = new Set<string>();
  observer.container(envelope.HotelDetails, 'HotelDetails').forEach((raw, index) => {
    observer.received += 1;
    if (!roomDetail) observer.collectUnknownKeys(raw, TBO_HOTEL_FIELD_KEYS, 'HotelDetails[].');
    const parsed = TboHotelItemSchema.safeParse(raw);
    if (!parsed.success || !isRecord(raw)) {
      if (roomDetail) observer.collectUnknownKeys(raw, TBO_HOTEL_FIELD_KEYS, 'HotelDetails[].');
      observer.reject(
        'ITEM_SCHEMA',
        parsed.success
          ? [`HotelDetails.${index}:invalid_type`]
          : zodIssueRefs(parsed.error, `HotelDetails.${index}`),
      );
      return;
    }
    const hotelId = parsed.data.HotelCode;
    if (roomDetail && (seen.has(hotelId) || !pending.has(hotelId))) {
      observer.collectUnknownKeys(raw, TBO_HOTEL_FIELD_KEYS, 'HotelDetails[].');
    }
    if (seen.has(hotelId)) {
      observer.reject('DUPLICATE', [`HotelDetails.${index}.HotelCode:duplicated`]);
      return;
    }
    if (!pending.has(hotelId)) {
      observer.reject('NOT_REQUESTED', [`HotelDetails.${index}.HotelCode:not_requested`]);
      return;
    }
    seen.add(hotelId);
    pending.delete(hotelId);

    const record = readTboHotelRecord(raw, {
      observer,
      at: `HotelDetails.${index}`,
      hotelId,
      lang: context.lang,
      source: 'details',
    });
    hotels.push(record.hotel);
    contents.push(record.content);
    observer.mapped += 1;

    if (roomDetail) {
      const rooms = readRooms(raw, envelope, {
        observer,
        at: `HotelDetails.${index}`,
        hotelId,
        soleHotel: requested.length === 1,
      });
      roomContents.push({ hotelId, rooms: rooms.rooms, shape: rooms.shape });
      if (rooms.rootKey !== undefined) consumedRootKeys.add(rooms.rootKey.toLowerCase());
      observer.collectUnknownKeys(
        raw,
        rooms.hotelKey === undefined
          ? TBO_HOTEL_FIELD_KEYS
          : [...TBO_HOTEL_FIELD_KEYS, rooms.hotelKey.toLowerCase()],
        'HotelDetails[].',
      );
    }
  });

  if (roomDetail) {
    observer.collectUnknownKeys(
      envelope,
      [...TBO_STATIC_ROOT_KEYS.hotelDetails, ...consumedRootKeys],
      '',
    );
  }

  return {
    lang: context.lang,
    outcome: 'DETAILS',
    contents,
    hotels,
    missingHotelCodes: requested.filter((code) => pending.has(code)),
    roomContents,
    diagnostics: observer.finish(),
  };
}

/**
 * El lector no lanza; esto es la última red: el contenido del hotel ya está guardado en
 * `contents` y un caso que nadie previó lo deja sin habitaciones, nunca sin contenido.
 */
function readRooms(
  raw: Readonly<Record<string, unknown>>,
  envelope: TboHotelDetailsEnvelope,
  scope: Parameters<typeof readTboRoomDetails>[2],
): TboRoomDetailRead {
  try {
    return readTboRoomDetails(raw, envelope, scope);
  } catch {
    scope.observer.note('FIELD_INVALID', `${scope.at}:room_detail_unreadable`);
    return { rooms: [], shape: 'unreadable' };
  }
}

/**
 * El lote que TBO contestó con un "No Hotels Found" rápido (05 CE-23): nada que mapear, todos los
 * códigos pedidos sin contenido en ese idioma y diagnósticos en cero. Valida el contexto igual que
 * el mapper: un código ilegible es un bug del llamador, no un lote vacío.
 */
export function emptyTboHotelDetailsMapping(
  context: TboHotelDetailsMapContext,
  deps: TboStaticMapDeps = {},
): TboHotelDetailsMapping {
  const requested = readContext(context);
  const observer = new TboStaticObserver('hotelDetails', deps);
  return {
    lang: context.lang,
    outcome: 'NO_HOTELS_FOUND',
    contents: [],
    hotels: [],
    missingHotelCodes: requested,
    roomContents: [],
    diagnostics: observer.finish(),
  };
}
