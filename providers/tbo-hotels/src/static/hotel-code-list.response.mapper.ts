import { zodIssueRefs } from '../internal/zod-issues';
import type { TboHotelCodeListMapping } from './content.types';
import { TboStaticObserver, type TboStaticMapDeps } from './observer';
import {
  TBO_STATIC_ROOT_KEYS,
  TboStaticCodeSchema,
  type TboHotelCodeListEnvelope,
} from './response.schema';

/**
 * `GET hotelcodelist` → todos los códigos de hotel de TBO (docs/tbo/05 §2.4, p. 54-55). Etapa E5
 * del sync: un hotel activo que no está en esta lista se da de baja.
 *
 * OJO con el nombre: en 06 §4.2 `hotel-code-list.response.mapper.ts` es el de `TBOHotelCodeList`,
 * que aquí vive en `tbo-hotel-code-list.response.mapper.ts` (desviación registrada en
 * `tbo-hotel-code-list.request.builder.ts`). Este archivo sigue a la fila `hotelCodeList` de
 * `TBO_OPERATIONS`.
 *
 * - Los códigos llegan como ENTEROS (p. 55) y en el resto de los métodos como string: todo sale
 *   string, que es como los guarda `hotel_inventory.hotel_id`.
 * - El ejemplo no trae `Status` (p. 55; Q-61): el cliente lo admite sólo en esta operación.
 * - Un código ilegible se descarta y se cuenta como `ITEM_SCHEMA`; un repetido, como `DUPLICATE`.
 *   El sync mira `ITEM_SCHEMA` antes de desactivar: una lista con códigos ilegibles no es una lista
 *   completa, y lo que falte en ella no se puede dar de baja.
 */
/**
 * La lista es GLOBAL y su tamaño no está documentado (Q-61): pueden ser millones de códigos. El
 * entero no negativo, que es la forma observada (p. 55), se convierte sin pasar por Zod; cualquier
 * otra forma sí pasa por el esquema, que es el que decide y el que nombra el motivo.
 */
function readCode(raw: unknown, index: number, observer: TboStaticObserver): string | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  const parsed = TboStaticCodeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  observer.reject('ITEM_SCHEMA', zodIssueRefs(parsed.error, `HotelCodes.${index}`));
  return undefined;
}

export function mapTboHotelCodeListResponse(
  envelope: TboHotelCodeListEnvelope,
  deps: TboStaticMapDeps = {},
): TboHotelCodeListMapping {
  const observer = new TboStaticObserver('hotelCodeList', deps);
  observer.assertSuccess(envelope.Status);
  observer.collectUnknownKeys(envelope, TBO_STATIC_ROOT_KEYS.hotelCodeList, '');

  const hotelCodes: string[] = [];
  const seen = new Set<string>();
  envelope.HotelCodes.forEach((raw, index) => {
    observer.received += 1;
    const code = readCode(raw, index, observer);
    if (code === undefined) return;
    if (seen.has(code)) {
      observer.reject('DUPLICATE', [`HotelCodes.${index}:duplicated`]);
      return;
    }
    seen.add(code);
    hotelCodes.push(code);
    observer.mapped += 1;
  });

  return { hotelCodes, diagnostics: observer.finish() };
}
