import { z } from 'zod';

/**
 * Zod de la respuesta del Book (docs/tbo/03 §3.8; 08 RF-03 CA-2, RF-20; RNF-12).
 *
 * La respuesta sólo trae `Status`, `ClientReferenceId` y `ConfirmationNumber` (p. 40-41) y la tabla
 * termina con una fila en blanco que puede ser un campo omitido (H-21, Q-40): el sobre es tolerante
 * a claves extra y registra sus NOMBRES.
 *
 * Los dos identificadores son opcionales A PROPÓSITO. Un `200` sin `ConfirmationNumber` no es una
 * respuesta ilegible que se pueda descartar: es un Book que pudo haber reservado sin decirnos con
 * qué localizador, y lo clasifica `classify-book-outcome.ts` como incierto con su motivo propio
 * (RF-03 CA-2). Si este esquema lo exigiera, el mismo caso saldría como un error de mapeo genérico.
 *
 * Los tipos de este archivo son crudos de TBO y no salen del paquete (RF-07 CA-6).
 */

/** `Code` es Integer (p. 40); el cliente también acepta un string de 3 dígitos. */
const StatusCodeSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d{3}$/)
    .transform(Number),
]);

/**
 * Identificador como texto. Un número entero se acepta y se pasa a texto (el contrato dice String,
 * p. 40, pero un serializador que lo emita como número no cambia qué reserva es); vacío o sólo
 * espacios es "no vino".
 */
const IdentifierSchema = z
  .union([z.string(), z.number().int().nonnegative().safe().transform(String), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  });

export const TboBookEnvelopeSchema = z
  .object({
    Status: z
      .object({ Code: StatusCodeSchema, Description: z.string().nullish() })
      .passthrough()
      .optional(),
    ClientReferenceId: IdentifierSchema,
    ConfirmationNumber: IdentifierSchema,
  })
  .passthrough();
export type TboBookEnvelope = z.infer<typeof TboBookEnvelopeSchema>;

// Las claves conocidas salen del propio esquema: una lista escrita a mano derivaría.
export const TBO_BOOK_ROOT_KEYS: readonly string[] = Object.keys(TboBookEnvelopeSchema.shape);
