import { HOTEL_MATCH_RULES, isMassLoss, planHotelMatches } from '../match-rules.js';
import type { StageContext } from './context.js';

export interface E6MatchResult {
  /** `held`: el recálculo perdía demasiado de lo aceptado y no se escribió nada (`isMassLoss`). */
  readonly status: 'done' | 'skipped' | 'held';
  readonly pairsNear: number;
  readonly pairsQualifying: number;
  readonly acceptedPairs: number;
  readonly reviewHotels: number;
  readonly protectedHotels: number;
  readonly written: number;
  readonly unchanged: number;
  readonly demoted: number;
  readonly acceptedLost: number;
}

const SKIPPED: E6MatchResult = {
  status: 'skipped',
  pairsNear: 0,
  pairsQualifying: 0,
  acceptedPairs: 0,
  reviewHotels: 0,
  protectedHotels: 0,
  written: 0,
  unchanged: 0,
  demoted: 0,
  acceptedLost: 0,
};

/** E6 corre si está pedida, hay países y el contenedor no se está apagando. */
export function shouldRunE6(ctx: StageContext, countries: readonly string[]): boolean {
  return ctx.settings.stages.has('E6') && countries.length > 0 && !ctx.gate.interrupted;
}

/**
 * E6, primera mitad — equivalencias de hotel entre el proveedor y el destino de la UI →
 * `hotel_match` (05 §9.1; 08 RF-34; D-TBO-13 A).
 *
 * Sólo SQL sobre lo que E3 dejó: no llama a TBO ni gasta presupuesto, así que corre aunque la
 * corrida se haya cortado por presupuesto, `429` o errores. Recalcula los países de la corrida
 * enteros, en una sola pasada: un hotel de frontera tiene candidatos en los dos países, y calcular
 * uno por vez podría aceptar el mismo hotel de Despegar con dos hoteles de TBO.
 *
 * Las reglas (`planHotelMatches`) son conservadoras: ante dos candidatos, `review`; una fila manual
 * no se pisa; y lo que ya no se sostiene pasa a `rejected`, nunca se borra. La búsqueda sólo agrupa
 * con `accepted`.
 */
export async function runHotelMatchStage(
  ctx: StageContext,
  countries: readonly string[],
): Promise<E6MatchResult> {
  if (!shouldRunE6(ctx, countries)) return SKIPPED;

  const scope = await ctx.store.listHotelMatchScope({
    countries,
    maxDistanceM: HOTEL_MATCH_RULES.maxDistanceM,
  });
  const stored = await ctx.store.listHotelMatches();
  const plan = planHotelMatches({
    sourceProvider: ctx.settings.destinationSourceProvider,
    targetProvider: ctx.settings.providerCode,
    pairs: scope.pairs,
    scopeTargetIds: new Set(scope.targetHotelIds),
    stored,
  });
  const counts = {
    pairsNear: plan.counts.pairsNear,
    pairsQualifying: plan.counts.pairsQualifying,
    acceptedPairs: plan.counts.acceptedPairs,
    reviewHotels: plan.counts.reviewHotels,
    protectedHotels: plan.counts.protectedHotels,
    unchanged: plan.counts.unchanged,
    acceptedLost: plan.counts.acceptedLost,
  };

  if (isMassLoss(plan.counts, ctx.settings.sweepMaxDrop)) {
    ctx.logger.warn('tbo.sync.e6_anomaly', {
      stage: 'E6',
      table: 'hotel_match',
      acceptedInScope: plan.counts.acceptedInScope,
      acceptedLost: plan.counts.acceptedLost,
      maxDrop: ctx.settings.sweepMaxDrop,
    });
    const held: E6MatchResult = { status: 'held', ...counts, written: 0, demoted: 0 };
    ctx.logger.info('tbo.sync.stage', { stage: 'E6', part: 'hotel_match', ...held });
    return held;
  }

  const write = await ctx.store.writeHotelMatches({
    upserts: plan.upserts,
    demotions: plan.demotions,
    computedAt: new Date(ctx.now()),
  });
  const summary: E6MatchResult = { status: 'done', ...counts, ...write };
  ctx.logger.info('tbo.sync.stage', { stage: 'E6', part: 'hotel_match', ...summary });
  return summary;
}
