import { isSweepAnomaly, selectDueCities } from '../catalog-rules.js';
import { throwIfAccountFailure, unreadableItems, type StageContext } from './context.js';

export interface E3Result {
  readonly status: 'done' | 'skipped';
  readonly citiesDue: number;
  readonly cities: number;
  readonly citiesFailed: number;
  readonly hotelsUpserted: number;
  readonly hotelsDeactivated: number;
  readonly sweepAnomalies: number;
  readonly incompleteResponses: number;
  /** Filas `listing` en inglés insertadas o reescritas (PR-3.3). */
  readonly listingContentsWritten: number;
  /** `listing` iguales a lo guardado o que no pisan un `details`: no se escribió nada. */
  readonly listingContentsKept: number;
}

const SKIPPED: E3Result = {
  status: 'skipped',
  citiesDue: 0,
  cities: 0,
  citiesFailed: 0,
  hotelsUpserted: 0,
  hotelsDeactivated: 0,
  sweepAnomalies: 0,
  incompleteResponses: 0,
  listingContentsWritten: 0,
  listingContentsKept: 0,
};

/**
 * E3 — `POST TBOHotelCodeList` por ciudad (p. 65; 05 §6.3 y §6.5) → `hotel_inventory` con
 * upsert, guarda de caída máxima y barrido, en una transacción corta por ciudad.
 *
 * Una ciudad que falla (timeout, `500`, cuerpo ilegible) sólo anota su `last_status_code`: su
 * catálogo queda como estaba, su `synced_at` no avanza y la próxima corrida la vuelve a pedir.
 * Una corrida que se corta a mitad (presupuesto, `429` seguidos, SIGTERM) deja intactas las
 * ciudades que no alcanzó (08 RF-30 CA 1).
 *
 * El texto que TBOHotelCodeList trae de paso (descripción, servicios, atracciones) va a
 * `hotel_content` como `listing` en inglés, sin llamada extra: es el respaldo del detalle hasta que
 * E4 traiga HotelDetails, y nunca lo pisa (05 §6.3). Va en su propia transacción, después de la
 * ciudad: si falla, el catálogo de la ciudad ya quedó bien y la corrida falla como cualquier caída
 * de la base.
 */
export async function runCityHotelsStage(
  ctx: StageContext,
  countries: readonly string[],
): Promise<E3Result> {
  if (!ctx.settings.stages.has('E3') || countries.length === 0) return SKIPPED;

  const { cadence, sweepMaxDrop } = ctx.settings;
  const now = ctx.now();
  const candidates = await ctx.store.listCityCandidates({
    countries,
    demandSince: new Date(now - cadence.demandWindowMs),
  });
  // Todas las vencidas, no sólo las que caben: el presupuesto lo corta la puerta, y así una corrida
  // que no llega a todas termina "ok parcial" en vez de decir que completó.
  const due = selectDueCities(candidates, { now, cadence, limit: candidates.length });

  let cities = 0;
  let citiesFailed = 0;
  let hotelsUpserted = 0;
  let hotelsDeactivated = 0;
  let sweepAnomalies = 0;
  let incompleteResponses = 0;
  let listingContentsWritten = 0;
  let listingContentsKept = 0;
  for (const city of due) {
    const result = await ctx.gate.call((signal) =>
      ctx.source.listCityHotels(city.code, { countryCode: city.countryCode }, { signal }),
    );
    if (!result.ok) {
      throwIfAccountFailure(result.failure, 'E3');
      if (result.failure.type === 'stopped') break;
      citiesFailed += 1;
      await ctx.store.recordCityFailure(city.code, result.failure.statusCode);
      if (ctx.gate.stopReason !== undefined) break;
      continue;
    }

    const { hotels, listingContents, diagnostics } = result.value;
    const write = await ctx.store.writeCityHotels({
      cityCode: city.code,
      hotels,
      unreadable: unreadableItems(diagnostics),
      runStart: ctx.runStart,
      maxDrop: sweepMaxDrop,
    });
    cities += 1;
    hotelsUpserted += write.upserted;
    hotelsDeactivated += write.deactivated;
    if (listingContents.length > 0) {
      const content = await ctx.store.writeHotelContents({
        contents: listingContents,
        fetchedAt: new Date(ctx.now()),
      });
      listingContentsWritten += content.inserted + content.rewritten;
      listingContentsKept += content.unchanged + content.protected + content.touched;
    }
    if (isSweepAnomaly(write.verdict)) {
      sweepAnomalies += 1;
      ctx.logger.warn('tbo.sync.sweep_anomaly', {
        stage: 'E3',
        city: city.code,
        country: city.countryCode,
        verdict: write.verdict,
        previouslyActive: write.previouslyActive,
        missing: write.missing,
        received: hotels.length,
        maxDrop: sweepMaxDrop,
      });
    } else if (write.verdict === 'incomplete-response') {
      incompleteResponses += 1;
      ctx.logger.warn('tbo.sync.incomplete_response', {
        stage: 'E3',
        city: city.code,
        country: city.countryCode,
        missing: write.missing,
        unreadable: unreadableItems(diagnostics),
      });
    }
  }

  const summary: E3Result = {
    status: 'done',
    citiesDue: due.length,
    cities,
    citiesFailed,
    hotelsUpserted,
    hotelsDeactivated,
    sweepAnomalies,
    incompleteResponses,
    listingContentsWritten,
    listingContentsKept,
  };
  ctx.logger.info('tbo.sync.stage', { stage: 'E3', ...summary });
  return summary;
}
