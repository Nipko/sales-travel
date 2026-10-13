import { z } from 'zod';
import { SabreAncillaryAirExtraIdSchema } from './add.response.mapper';
import { sabreAncillaryZodIssues } from './shop.request.builder';
import { SabreAncillaryMappingError, SabreAncillaryRejectedError } from './shop.response.mapper';

/**
 * `AncillaryRemoveResponse` (`stateless-ancillaries-api-1.0.yml:314-325`): un `airExtraId` por
 * servicio quitado (`RemovedAncillaryItem`, `:717-725`).
 *
 * Un id pedido que no vuelve no se da por quitado ni por fallido: queda sin confirmar. Que siga en
 * la reserva o no lo dice una lectura de la orden, no esta respuesta.
 */
export const SabreAncillaryRemoveResponseSchema = z.object({
  results: z.array(z.object({ airExtraId: SabreAncillaryAirExtraIdSchema })).optional(),
  errors: z.array(z.unknown()).optional(),
  warnings: z.array(z.unknown()).optional(),
});

export type SabreAncillaryRemoveWarningCode =
  | 'provider-warning'
  /** `results` nombra un id que no se pidió quitar. */
  | 'remove-result-unrequested';

export interface SabreAncillaryRemoveMapped {
  readonly removed: readonly string[];
  readonly unverified: readonly string[];
  readonly warnings: readonly SabreAncillaryRemoveWarningCode[];
}

export function mapSabreAncillaryRemoveResponse(
  raw: unknown,
  requested: readonly string[],
): SabreAncillaryRemoveMapped {
  const parsed = SabreAncillaryRemoveResponseSchema.safeParse(raw);
  if (!parsed.success) throw new SabreAncillaryMappingError(sabreAncillaryZodIssues(parsed.error));
  if ((parsed.data.errors?.length ?? 0) > 0) {
    throw new SabreAncillaryRejectedError(parsed.data.errors?.length ?? 0);
  }

  const warnings = new Set<SabreAncillaryRemoveWarningCode>();
  if ((parsed.data.warnings?.length ?? 0) > 0) warnings.add('provider-warning');

  const asked = new Set(requested);
  const returned = new Set<string>();
  for (const result of parsed.data.results ?? []) {
    if (asked.has(result.airExtraId)) returned.add(result.airExtraId);
    else warnings.add('remove-result-unrequested');
  }

  return {
    removed: requested.filter((id) => returned.has(id)),
    unverified: requested.filter((id) => !returned.has(id)),
    warnings: [...warnings],
  };
}
