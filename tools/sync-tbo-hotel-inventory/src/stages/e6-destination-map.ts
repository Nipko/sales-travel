import type { UnmappedDestination } from '../catalog-store.js';
import { isMassLoss, planDestinationMap } from '../match-rules.js';
import type { StageContext } from './context.js';
import { shouldRunE6 } from './e6-hotel-match.js';

export interface E6DestinationResult {
  /** `held`: el recálculo perdía demasiado de lo aceptado y no se escribió nada (`isMassLoss`). */
  readonly status: 'done' | 'skipped' | 'held';
  readonly sourcesInScope: number;
  readonly acceptedOverlap: number;
  readonly acceptedCentroid: number;
  readonly ambiguous: number;
  readonly tooFar: number;
  readonly catalogIncomplete: number;
  readonly manualOwned: number;
  readonly written: number;
  readonly unchanged: number;
  readonly demoted: number;
  readonly acceptedLost: number;
  /** Países con ciudades que E3 nunca pidió: ahí no se acepta por distancia de centroides. */
  readonly incompleteCountries: readonly string[];
  /** Los destinos más buscados sin ciudad del proveedor aceptada (05 §8.4). */
  readonly unmapped: readonly UnmappedDestination[];
}

const SKIPPED: E6DestinationResult = {
  status: 'skipped',
  sourcesInScope: 0,
  acceptedOverlap: 0,
  acceptedCentroid: 0,
  ambiguous: 0,
  tooFar: 0,
  catalogIncomplete: 0,
  manualOwned: 0,
  written: 0,
  unchanged: 0,
  demoted: 0,
  acceptedLost: 0,
  incompleteCountries: [],
  unmapped: [],
};

/** Cuántos destinos sin mapeo van al log de cada corrida: la lista de trabajo de la revisión. */
export const UNMAPPED_REPORT_LIMIT = 20;

/**
 * E6, segunda mitad — el destino que elige el vendedor (hoy, un id de ciudad de Despegar) →
 * ciudades del proveedor en `hotel_destination_map` (05 §8.3; 08 RF-33; D-TBO-10 A). Es lo que la
 * búsqueda de `/hotels` lee, sólo con `status = 'accepted'`, para saber qué `CityCode` pedirle a
 * TBO (`HotelsService.resolveDestinationCityCodes`); sin fila aceptada, TBO no se consulta.
 *
 * Corre después de las equivalencias: el solapamiento se mide con las `accepted` que acaban de
 * quedar. Un destino con alguna fila `manual` lo decide una persona y no se recalcula.
 *
 * Al final deja en el log los destinos más buscados que siguen sin mapeo aceptado, con y sin
 * filas `ambiguous` pendientes: la consulta de operación para priorizar la revisión manual (05 §8.4).
 */
export async function runDestinationMapStage(
  ctx: StageContext,
  countries: readonly string[],
): Promise<E6DestinationResult> {
  if (!shouldRunE6(ctx, countries)) return SKIPPED;

  const scope = await ctx.store.listDestinationScope({ countries });
  const plan = planDestinationMap(scope);
  const counts = {
    sourcesInScope: plan.counts.sourcesInScope,
    acceptedOverlap: plan.counts.acceptedOverlap,
    acceptedCentroid: plan.counts.acceptedCentroid,
    ambiguous: plan.counts.ambiguous,
    tooFar: plan.counts.tooFar,
    catalogIncomplete: plan.counts.catalogIncomplete,
    manualOwned: plan.counts.manualOwned,
    unchanged: plan.counts.unchanged,
    acceptedLost: plan.counts.acceptedLost,
    incompleteCountries: plan.incompleteCountries,
  };

  let status: E6DestinationResult['status'] = 'done';
  let write = { written: 0, demoted: 0 };
  if (isMassLoss(plan.counts, ctx.settings.sweepMaxDrop)) {
    status = 'held';
    ctx.logger.warn('tbo.sync.e6_anomaly', {
      stage: 'E6',
      table: 'hotel_destination_map',
      acceptedInScope: plan.counts.acceptedInScope,
      acceptedLost: plan.counts.acceptedLost,
      maxDrop: ctx.settings.sweepMaxDrop,
    });
  } else {
    write = await ctx.store.writeDestinationMap({
      upserts: plan.upserts,
      demotions: plan.demotions,
      computedAt: new Date(ctx.now()),
    });
  }

  const unmapped = await ctx.store.listUnmappedDestinations({
    since: new Date(ctx.now() - ctx.settings.cadence.demandWindowMs),
    limit: UNMAPPED_REPORT_LIMIT,
  });
  if (unmapped.length > 0) {
    ctx.logger.info('tbo.sync.unmapped_destinations', {
      stage: 'E6',
      provider: ctx.settings.providerCode,
      destinations: unmapped,
    });
  }

  const summary: E6DestinationResult = { status, ...counts, ...write, unmapped };
  const { unmapped: _listed, ...logged } = summary;
  ctx.logger.info('tbo.sync.stage', {
    stage: 'E6',
    part: 'destination_map',
    ...logged,
    unmappedListed: unmapped.length,
  });
  return summary;
}
