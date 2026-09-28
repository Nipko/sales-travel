import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';

/**
 * Body de `POST TBOHotelCodeList` (docs/tbo/05 §2.5, p. 65): los hoteles de UNA ciudad.
 *
 * Nombre (desviación de 06 §4.2, que llama `hotel-code-list.*` a este método): el paquete tiene
 * también `GET hotelcodelist` (p. 55), y los dos nombres colisionan. Este par es `tbo-hotel-code-list.*`
 * y sus símbolos dicen `CityHotels`; `hotel-code-list.response.mapper.ts` es el de `hotelcodelist`,
 * igual que las filas `tboHotelCodeList` y `hotelCodeList` de `TBO_OPERATIONS`.
 *
 * - `CityCode` va como STRING y `IsDetailedResponse` como el string `"true"`/`"false"`, como en el
 *   PDF y en Postman, aunque la tabla diga Integer y Boolean (p. 65; Postman: `TBOHotelCodeList`).
 *   Hasta que la certificación pruebe que TBO acepta los tipos de la tabla, se manda lo único que
 *   se vio funcionar (Q-63).
 * - `IsDetailedResponse` es `"true"` por defecto, al revés que en Search: el key point de p. 71 no
 *   dice a qué método aplica, y sin `Map`, `HotelRating` y `CountryCode` no hay inventario útil ni
 *   centroide de ciudad (05 §6.3 E3; CE-08). Pasar a `"false"` es configuración, no código.
 */
const TboCityHotelsRequestSchema = z
  .object({
    CityCode: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9]+$/),
    IsDetailedResponse: z.enum(['true', 'false']),
  })
  .strict();

/** El body exacto que sale al cable. Tipo crudo de TBO: no sale del paquete. */
export type TboCityHotelsRequest = z.infer<typeof TboCityHotelsRequestSchema>;

export interface TboCityHotelsRequestOptions {
  /** `IsDetailedResponse`; `true` por defecto (Q-63). */
  readonly detailedResponse?: boolean;
}

export function buildTboCityHotelsRequest(
  cityCode: string,
  options: TboCityHotelsRequestOptions = {},
): TboCityHotelsRequest {
  const parsed = TboCityHotelsRequestSchema.safeParse({
    CityCode: cityCode,
    IsDetailedResponse: options.detailedResponse === false ? 'false' : 'true',
  });
  if (!parsed.success) {
    throw new TboRequestBuildError(
      TBO_OPERATIONS.tboHotelCodeList.path,
      'SCHEMA',
      zodIssueRefs(parsed.error),
    );
  }
  return parsed.data;
}
