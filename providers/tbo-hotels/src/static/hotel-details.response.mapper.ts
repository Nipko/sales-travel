import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';
import {
  TBO_CONTENT_LANGUAGES,
  type TboCatalogHotel,
  type TboContentLanguage,
  type TboHotelContent,
  type TboHotelDetailsMapping,
} from './content.types';
import { readTboHotelRecord } from './hotel-record';
import { TboStaticObserver, type TboStaticMapDeps } from './observer';
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
 * - **El detalle por habitación queda APAGADO** (RF-32; 05 §2.6.3; Q-65): el builder no pide
 *   `IsRoomDetailRequired` y, si TBO igual manda un contenedor de habitaciones, sólo se registra el
 *   NOMBRE de su clave como desconocida. No hay fixture real que diga dónde viene.
 * - Un código que no se pidió se descarta; uno pedido que no vuelve se informa en
 *   `missingHotelCodes`, porque no se sabe si un código inexistente tumba el lote (Q-62).
 * - El lote que TBO contesta con "No Hotels Found" (05 CE-23) no llega aquí: el cliente lo arma con
 *   {@link emptyTboHotelDetailsMapping}, sin nada que mapear.
 */
export interface TboHotelDetailsMapContext {
  readonly lang: TboContentLanguage;
  /** Los códigos del request, en su orden. */
  readonly hotelCodes: readonly string[];
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
  const observer = new TboStaticObserver('hotelDetails', deps);
  observer.assertSuccess(envelope.Status);
  observer.collectUnknownKeys(envelope, TBO_STATIC_ROOT_KEYS.hotelDetails, '');

  const contents: TboHotelContent[] = [];
  const hotels: TboCatalogHotel[] = [];
  const seen = new Set<string>();
  observer.container(envelope.HotelDetails, 'HotelDetails').forEach((raw, index) => {
    observer.received += 1;
    observer.collectUnknownKeys(raw, TBO_HOTEL_FIELD_KEYS, 'HotelDetails[].');
    const parsed = TboHotelItemSchema.safeParse(raw);
    if (!parsed.success || !isRecord(raw)) {
      observer.reject(
        'ITEM_SCHEMA',
        parsed.success
          ? [`HotelDetails.${index}:invalid_type`]
          : zodIssueRefs(parsed.error, `HotelDetails.${index}`),
      );
      return;
    }
    const hotelId = parsed.data.HotelCode;
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
  });

  return {
    lang: context.lang,
    outcome: 'DETAILS',
    contents,
    hotels,
    missingHotelCodes: requested.filter((code) => pending.has(code)),
    diagnostics: observer.finish(),
  };
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
    diagnostics: observer.finish(),
  };
}
