import { z } from 'zod';

/**
 * Zod de la respuesta de `Cancel` (docs/tbo/04 §4.1 y §4.3; 08 RF-25; RNF-12).
 *
 * La respuesta trae `Status` y `ConfirmationNumber` (p. 42), nada más: ni cargo, ni reembolso, ni
 * estado de la reserva. `ConfirmationNumber` es OBLIGATORIO porque es lo único que dice a qué
 * reserva se refiere el `200`; sin él la respuesta no se puede leer y el cliente HTTP la convierte en
 * `TboCancelMappingError`, que la política de cancelaciones deja `UNVERIFIED` (01 §9.3). Un número
 * entero se acepta como texto: el contrato dice String, pero un serializador que lo emita como
 * número no cambia de qué reserva se trata.
 *
 * El sobre es tolerante a claves extra y el mapper registra sus NOMBRES. Los tipos de este archivo
 * son crudos de TBO y no salen del paquete (RF-07 CA-6).
 */

/** `Code` es Integer (p. 42); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

const ConfirmationNumberSchema = z.preprocess(
  (value) => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value),
  z.string().trim().min(1),
);

export const TboCancelEnvelopeSchema = z
  .object({
    Status: z
      .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
      .passthrough()
      .optional(),
    ConfirmationNumber: ConfirmationNumberSchema,
  })
  .passthrough();
export type TboCancelEnvelope = z.infer<typeof TboCancelEnvelopeSchema>;

// Las claves conocidas salen del propio esquema: una lista escrita a mano derivaría.
export const TBO_CANCEL_ROOT_KEYS: readonly string[] = Object.keys(TboCancelEnvelopeSchema.shape);
