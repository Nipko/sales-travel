import { z } from 'zod';
import { SabreAncillaryAirExtraIdSchema } from './add.response.mapper';
import {
  SABRE_ANCILLARIES_BASE_PATH,
  SabreAncillaryPnrSchema,
  SabreAncillaryRequestError,
  sabreAncillaryZodIssues,
} from './shop.request.builder';

/**
 * `POST /v1/dc/ancillaries/remove` (`stateless-ancillaries-api-1.0.yml:66-84`).
 *
 * Quita servicios del PNR por `airExtraId`: los que devolvió el alta o los que muestra la reserva
 * (`help/stateless-ancillaries-api-1.0/1.0-index.txt`). **Escribe en el PNR** y está en
 * `SABRE_NON_IDEMPOTENT_PATHS`: un timeout no dice si se quitó, y reintentar sobre una reserva que
 * ya cambió no es inocuo.
 *
 * No es la ruta de Manage Ancillary (`/v1/ancillaries/remove`), cuyo éxito es un cuerpo vacío: el
 * de ésta declara `results[]` (`:314-325`), así que un `{}` aquí NO es éxito y el cliente HTTP lo
 * sigue rechazando.
 */
export const SABRE_ANCILLARIES_REMOVE_PATH = `${SABRE_ANCILLARIES_BASE_PATH}/remove`;

/** El contrato no pone tope; una reserva de 9 pasajeros y 16 tramos no llega a tanto. */
export const SABRE_ANCILLARY_MAX_REMOVALS = 64;

/** `AncillaryRemoveRequest` (`:219-242`). */
export const SabreAncillaryRemoveRequestSchema = z
  .object({
    pnrLocator: SabreAncillaryPnrSchema,
    isCommitEnabled: z.literal(true),
    airExtraIds: z
      .array(SabreAncillaryAirExtraIdSchema)
      .min(1)
      .max(SABRE_ANCILLARY_MAX_REMOVALS)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate' }),
  })
  .strict();
export type SabreAncillaryRemoveRequest = z.infer<typeof SabreAncillaryRemoveRequestSchema>;

export interface SabreAncillaryRemovePlan {
  readonly path: typeof SABRE_ANCILLARIES_REMOVE_PATH;
  readonly body: SabreAncillaryRemoveRequest;
}

export function buildSabreAncillaryRemoveRequest(input: {
  readonly pnrLocator: string;
  readonly airExtraIds: readonly string[];
}): SabreAncillaryRemovePlan {
  const parsed = SabreAncillaryRemoveRequestSchema.safeParse({
    pnrLocator: input.pnrLocator,
    isCommitEnabled: true,
    airExtraIds: [...input.airExtraIds],
  });
  if (!parsed.success) {
    throw new SabreAncillaryRequestError('remove', sabreAncillaryZodIssues(parsed.error));
  }
  return { path: SABRE_ANCILLARIES_REMOVE_PATH, body: parsed.data };
}
