import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';
import { TBO_CONTENT_LANGUAGES, type TboContentLanguage } from './content.types';

/**
 * Body de `POST HotelDetails` (docs/tbo/05 §2.6.1 y §10, p. 56-58).
 *
 * - **`Hotelcodes` con c minúscula y como UN string CSV**, igual que Postman (13 códigos en un
 *   string) y que el ejemplo de p. 56. No el `HotelCodes` de Search ni el número de p. 58 (CE-03).
 * - **Nunca más de 13 códigos** por llamada; 10 es el lote por defecto del sync. El máximo no está
 *   documentado y 13 es lo único que se vio (Postman; Q-62). Los códigos se deduplican conservando
 *   el orden y nunca se recortan: partir en lotes es decisión del sync.
 * - **`Language` en mayúsculas** (`ES`, `PT`, `EN`), aunque la lista del PDF no nombre `EN` (p. 58;
 *   CE-11; Q-66).
 * - **Sin `IsRoomDetailRequired`**: el detalle por habitación queda apagado hasta tener un fixture
 *   real (RF-32; 05 §2.6.3; Q-65). El `.strict()` del body de salida impide mandarlo por descuido.
 */

export const TBO_HOTEL_DETAILS_LIMITS = Object.freeze({
  /** Lote por defecto de la etapa E4 (05 §10; `TBO_SYNC_DETAILS_BATCH`). */
  defaultBatchSize: 10,
  /** Techo hasta que TBO publique el suyo: lo que manda Postman (Q-62). */
  maxCodesPerRequest: 13,
} as const);

/** Nuestro idioma → el código de TBO (p. 58). */
const LANGUAGE_CODES: Readonly<Record<TboContentLanguage, 'ES' | 'PT' | 'EN'>> = Object.freeze({
  es: 'ES',
  pt: 'PT',
  en: 'EN',
});

// El mismo techo que `TboStaticCodeSchema`: un código que el mapper rechazaría no gasta la llamada.
const HOTEL_CODE = /^[A-Za-z0-9]{1,64}$/;

const TboHotelDetailsRequestSchema = z
  .object({
    Hotelcodes: z.string().regex(/^[A-Za-z0-9]+(,[A-Za-z0-9]+)*$/),
    Language: z.enum(['ES', 'PT', 'EN']),
  })
  .strict()
  .superRefine((body, ctx) => {
    const codes = body.Hotelcodes.split(',');
    if (codes.length > TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['Hotelcodes'],
        params: { reason: 'too_many_codes' },
      });
    }
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['Hotelcodes'],
        params: { reason: 'duplicated_code' },
      });
    }
  });

/** El body exacto que sale al cable. Tipo crudo de TBO: no sale del paquete. */
export type TboHotelDetailsRequest = z.infer<typeof TboHotelDetailsRequestSchema>;

function fail(issues: readonly string[]): never {
  throw new TboRequestBuildError(TBO_OPERATIONS.hotelDetails.path, 'SCHEMA', issues);
}

export function buildTboHotelDetailsRequest(
  hotelCodes: readonly string[],
  lang: TboContentLanguage,
): TboHotelDetailsRequest {
  if (!TBO_CONTENT_LANGUAGES.includes(lang)) fail(['lang:invalid_enum_value']);
  if (hotelCodes.length === 0) fail(['hotelCodes:too_small']);
  const invalid = hotelCodes.flatMap((code, index) =>
    HOTEL_CODE.test(code) ? [] : [`hotelCodes.${index}:invalid_code`],
  );
  if (invalid.length > 0) fail(invalid.slice(0, 20));
  const unique = [...new Set(hotelCodes)];
  if (unique.length > TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest) {
    fail(['hotelCodes:too_many_codes']);
  }

  const parsed = TboHotelDetailsRequestSchema.safeParse({
    Hotelcodes: unique.join(','),
    Language: LANGUAGE_CODES[lang],
  });
  if (!parsed.success) fail(zodIssueRefs(parsed.error));
  return parsed.data;
}
