import { z } from 'zod';
import { TBO_CONFIRMATION_NUMBER_PATTERN } from '../booking/booking-reference';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';

/**
 * Body de `Cancel` (docs/tbo/04 §4.1; 08 RF-25; RNF-04 capas 1 a 3).
 *
 * `ConfirmationNumber` es el ÚNICO campo del request (p. 41): no se cancela por nuestra referencia,
 * no hay motivo ni cancelación por habitación (PV-19). Tampoco lleva `PaymentMode`, a diferencia de
 * PreBook, Book y BookingDetail: el ejemplo de p. 41 y el de Postman no lo traen, y agregar una
 * clave que el contrato no declara es darle a TBO algo que interpretar en una escritura con dinero.
 * El esquema es `.strict()` por lo mismo.
 */

const CANCEL_PATH = TBO_OPERATIONS.cancel.path;

export const TboCancelRequestSchema = z
  .object({ ConfirmationNumber: z.string().regex(TBO_CONFIRMATION_NUMBER_PATTERN) })
  .strict();

/** Tipo crudo de TBO: no sale del paquete. `PaymentInfo?: never` es la barrera de D1 en el tipo. */
export type TboCancelRequest = z.infer<typeof TboCancelRequestSchema> & {
  readonly PaymentInfo?: never;
};

/**
 * Construye el body de un Cancel. Lanza `TboRequestBuildError` con `SCHEMA` y path `/Cancel` si el
 * localizador no tiene forma de uno: nada sale hacia TBO y, por el nombre de la clase, la política
 * de cancelaciones lo lee como determinista y previo al envío.
 */
export function buildTboCancelRequest(confirmationNumber: string): TboCancelRequest {
  const parsed = TboCancelRequestSchema.safeParse({ ConfirmationNumber: confirmationNumber });
  if (!parsed.success) {
    throw new TboRequestBuildError(CANCEL_PATH, 'SCHEMA', zodIssueRefs(parsed.error));
  }
  return parsed.data;
}
