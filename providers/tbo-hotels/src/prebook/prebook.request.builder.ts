import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';

/**
 * Body de `PreBook` (docs/tbo/03 §2.1 y §7; 08 RF-15, RNF-04 capas 2 y 3).
 *
 * `PreBook` recibe sólo `BookingCode` y `PaymentMode` (p. 19). Mandamos siempre el literal
 * `"Limit"`, explícito aunque sea el valor por defecto: los otros dos modos del enum de TBO piden
 * `PaymentInfo` con PAN y CVV en el Book (p. 33-35) y D1 los deja fuera del producto. La forma que
 * sale es exactamente la del request `PreBook` de Postman.
 *
 * D1 vive aquí en tres capas independientes:
 *
 * 1. **En el tipo**: la entrada no tiene `PaymentMode` ni `PaymentInfo` (los dos `?: never`), así que
 *    un llamador no puede elegir el modo ni pasar una tarjeta sin un cast.
 * 2. **En el esquema de salida**: `.strict()` con `PaymentMode: z.literal('Limit')`; el body se arma
 *    SÓLO con el `BookingCode`, así que ninguna clave de la entrada lo atraviesa.
 * 3. **En el cable**: el cliente HTTP barre los bytes que salen (claves de tarjeta y `PaymentMode`
 *    distinto de `Limit`) y recibe este esquema como `requestSchema`.
 *
 * El `BookingCode` es opaco (06 §5.3): no se parsea ni se recorta. Llega del contexto de búsqueda
 * que guardó el servidor, nunca suelto desde el navegador (03 §2.1).
 */

const PREBOOK_PATH = TBO_OPERATIONS.prebook.path;

/** El único modo de pago que sale de este paquete (D1; 03 §7). */
export const TBO_PREBOOK_PAYMENT_MODE = 'Limit';

/** Lo que el builder lee. El modo no se elige y la tarjeta no existe. */
export interface TboPrebookInput {
  /** El de Search, tal como lo guardó el contexto del servidor (p. 19). */
  readonly bookingCode: string;
  readonly PaymentMode?: never;
  readonly PaymentInfo?: never;
}

/**
 * El body exacto que sale al cable. Mismo techo que `ProviderRef.offerRef` y que el esquema de
 * Search: lo que Search aceptó como `BookingCode` es lo que PreBook puede reenviar.
 */
export const TboPrebookRequestSchema = z
  .object({
    BookingCode: z.string().min(1).max(255),
    PaymentMode: z.literal(TBO_PREBOOK_PAYMENT_MODE),
  })
  .strict();

/** Tipo crudo de TBO: no sale del paquete. `PaymentInfo?: never` es la barrera de D1 en el tipo. */
export type TboPrebookRequest = z.infer<typeof TboPrebookRequestSchema> & {
  readonly PaymentInfo?: never;
};

/**
 * Construye el body de un PreBook. Lanza `TboRequestBuildError` con `SCHEMA` si el `BookingCode` no
 * tiene forma de uno de TBO; nada sale hacia TBO y los issues son `ruta:código`, sin valores.
 */
export function buildTboPrebookRequest(input: TboPrebookInput): TboPrebookRequest {
  const bookingCode: unknown = input.bookingCode;
  // El orden de las claves es el del PDF y el de Postman (p. 19): el RQ que se entrega en la
  // certificación se lee al lado del contrato.
  const parsed = TboPrebookRequestSchema.safeParse({
    BookingCode: bookingCode,
    PaymentMode: TBO_PREBOOK_PAYMENT_MODE,
  });
  if (!parsed.success) {
    throw new TboRequestBuildError(PREBOOK_PATH, 'SCHEMA', zodIssueRefs(parsed.error));
  }
  return parsed.data;
}
