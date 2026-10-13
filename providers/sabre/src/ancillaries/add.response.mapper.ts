import { z } from 'zod';
import type { SabreAncillarySentLine } from './add.request.builder';
import { sabreAncillaryZodIssues } from './shop.request.builder';
import {
  SABRE_ANCILLARY_WIRE_PATTERNS as P,
  SabreAncillaryMappingError,
  SabreAncillaryRejectedError,
} from './shop.response.mapper';

/**
 * `AncillaryAddResponse` (`stateless-ancillaries-api-1.0.yml:302-313`): por cada servicio agregado,
 * su `ancillaryId` —el `Ancillary.id` que se mandó, «used to correlate given request with a
 * response» (`:703-706`)— y los `airExtraIds` que la reserva le asignó (`:707-716`), que son los que
 * pide `/remove`.
 *
 * El contrato dice «Successful response unless 'errors' element is returned» (`:63-65`), pero no
 * dice que `results` vaya a nombrar todo lo que se mandó. Una línea cuyo servicio no aparece no se
 * da por agregada ni por fallida: queda sin confirmar, y la orden se relee.
 *
 * **La correlación es por DEFINICIÓN de servicio, no por línea.** `ancillaryId` nombra un
 * `Ancillary`, y una misma definición la comparten todos los pasajeros de un ítem y todos los ítems
 * que la referencian (la misma maleta a la ida y a la vuelta). De ahí salen dos reglas:
 *
 * 1. Los `airExtraIds` de un servicio con más de una línea no se pueden repartir: se devuelven a
 *    todas sus líneas marcados como compartidos, y quitarlos quita todas.
 * 2. Cada línea (un pasajero en un ítem) deja al menos un air extra en la reserva, porque Sabre los
 *    guarda por nombre. Si vuelven MENOS ids que líneas, alguna no quedó y no se sabe cuál: todas
 *    las del servicio quedan sin confirmar. Dar por agregada la maleta de un pasajero que no la
 *    tiene es peor que pedir que se relea la orden.
 */

/**
 * `airExtraId` es texto sin patrón (`:722-725`, ejemplos `'12'`, `'32'`). Se acepta con forma de id
 * y sin la ventana de dígitos de un PAN, que es la misma regla con la que `/remove` lo vuelve a
 * mandar.
 */
export const SABRE_ANCILLARY_AIR_EXTRA_ID_PATTERN = /^[A-Za-z0-9-]{1,20}$/;

export const SabreAncillaryAirExtraIdSchema = z
  .string()
  .regex(SABRE_ANCILLARY_AIR_EXTRA_ID_PATTERN)
  .refine((value) => !P.panWindowDigitRun.test(value));

export const SabreAncillaryAddResponseSchema = z.object({
  results: z
    .array(
      z.object({
        ancillaryId: z.string().min(1).max(128),
        airExtraIds: z.array(SabreAncillaryAirExtraIdSchema).min(1).optional(),
      }),
    )
    .optional(),
  errors: z.array(z.unknown()).optional(),
  warnings: z.array(z.unknown()).optional(),
});

export type SabreAncillaryAddWarningCode =
  | 'provider-warning'
  /** `results` nombra un servicio que no se mandó. */
  | 'add-result-unrequested'
  /** Servicio confirmado sin `airExtraIds`: para quitarlo hay que leerlos de la orden. */
  | 'add-result-without-air-extra-ids'
  /** Menos `airExtraIds` que líneas del servicio: alguna no quedó y todas quedan en duda. */
  | 'add-result-incomplete';

export interface SabreAncillaryAddedLine extends SabreAncillarySentLine {
  readonly airExtraIds: readonly string[];
  /** Los ids son del servicio entero y otras líneas de `added` llevan los mismos. */
  readonly airExtraIdsShared: boolean;
}

export interface SabreAncillaryAddMapped {
  readonly added: readonly SabreAncillaryAddedLine[];
  readonly unverified: readonly SabreAncillarySentLine[];
  readonly warnings: readonly SabreAncillaryAddWarningCode[];
}

export function mapSabreAncillaryAddResponse(
  raw: unknown,
  sent: readonly SabreAncillarySentLine[],
): SabreAncillaryAddMapped {
  const parsed = SabreAncillaryAddResponseSchema.safeParse(raw);
  if (!parsed.success) throw new SabreAncillaryMappingError(sabreAncillaryZodIssues(parsed.error));
  if ((parsed.data.errors?.length ?? 0) > 0) {
    throw new SabreAncillaryRejectedError(parsed.data.errors?.length ?? 0);
  }

  const warnings = new Set<SabreAncillaryAddWarningCode>();
  if ((parsed.data.warnings?.length ?? 0) > 0) warnings.add('provider-warning');

  const linesByAncillary = new Map<string, number>();
  for (const line of sent) {
    linesByAncillary.set(line.ancillaryId, (linesByAncillary.get(line.ancillaryId) ?? 0) + 1);
  }

  const confirmed = new Map<string, string[]>();
  for (const result of parsed.data.results ?? []) {
    if (!linesByAncillary.has(result.ancillaryId)) {
      warnings.add('add-result-unrequested');
      continue;
    }
    const ids = confirmed.get(result.ancillaryId) ?? [];
    for (const id of result.airExtraIds ?? []) if (!ids.includes(id)) ids.push(id);
    confirmed.set(result.ancillaryId, ids);
  }

  const added: SabreAncillaryAddedLine[] = [];
  const unverified: SabreAncillarySentLine[] = [];
  for (const line of sent) {
    const ids = confirmed.get(line.ancillaryId);
    const lines = linesByAncillary.get(line.ancillaryId) ?? 1;
    if (ids === undefined) {
      unverified.push(line);
    } else if (ids.length > 0 && ids.length < lines) {
      warnings.add('add-result-incomplete');
      unverified.push(line);
    } else {
      if (ids.length === 0) warnings.add('add-result-without-air-extra-ids');
      added.push({
        ...line,
        airExtraIds: [...ids],
        airExtraIdsShared: lines > 1 && ids.length > 0,
      });
    }
  }
  return { added, unverified, warnings: [...warnings] };
}
