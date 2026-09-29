import { isSweepAnomaly, selectDueCities } from '../catalog-rules.js';
import { throwIfAccountFailure, unreadableItems, type StageContext } from './context.js';

export interface E3Result {
  readonly status: 'done' | 'skipped';
  readonly citiesDue: number;
  /** Ciudades que TBO contestó, con hoteles o sin ellos. */
  readonly cities: number;
  /**
   * De ésas, las que quedaron con `hotel_count = 0` y su `synced_at`: TBO contestó "No Hotels Found"
   * o una lista vacía, y la ciudad no tenía hoteles activos. Vuelven con la cadencia de las vacías
   * (`TBO_SYNC_EMPTY_REFRESH_DAYS`), no en cada corrida (01 §8.5; 05 §6.3).
   */
  readonly citiesEmpty: number;
  /** Ciudades que no se pudieron leer: se vuelven a pedir en la próxima corrida. */
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

/**
 * La ciudad quedó registrada como vacía: nada legible en la respuesta, nada descartado por ilegible
 * (eso no es una ciudad vacía, es una lectura rota) y el checkpoint avanzó (sin anomalía).
 */
function isEmptyCity(
  write: { readonly checkpointAdvanced: boolean; readonly hotelCount: number },
  received: number,
  unreadable: number,
): boolean {
  return received === 0 && unreadable === 0 && write.checkpointAdvanced && write.hotelCount === 0;
}

const SKIPPED: E3Result = {
  status: 'skipped',
  citiesDue: 0,
  cities: 0,
  citiesEmpty: 0,
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
 * Una ciudad sin hoteles NO es un fallo: TBO la contesta con `Status.Code` 500 "No Hotels Found",
 * que el ACL entrega como lista vacía en una sola llamada (01 §8.5). Si la ciudad no tenía hoteles
 * activos, queda con `hotel_count = 0` y su `synced_at`, y vuelve con la cadencia de las vacías
 * (`TBO_SYNC_EMPTY_REFRESH_DAYS`). Si los tenía, la guarda del barrido la trata como anomalía: no
 * barre nada y la ciudad queda pendiente (05 §6.5).
 *
 * Con `TBO_SYNC_CITIES` sólo se consideran esas ciudades, con la misma cadencia y el mismo orden.
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

  const { cadence, sweepMaxDrop, cities: onlyCities } = ctx.settings;
  const now = ctx.now();
  const candidates = await ctx.store.listCityCandidates({
    countries,
    ...(onlyCities === undefined ? {} : { cities: onlyCities }),
    demandSince: new Date(now - cadence.demandWindowMs),
  });
  if (onlyCities !== undefined) {
    // Un código mal copiado, o de un país que no está en la corrida, no se recorre y no falla: sin
    // este aviso la corrida terminaría "completa" sin haber tocado esa ciudad.
    const known = new Set(candidates.map((city) => city.code));
    const unknownCities = onlyCities.filter((code) => !known.has(code));
    if (unknownCities.length > 0) {
      ctx.logger.warn('tbo.sync.cities_unknown', { stage: 'E3', countries, unknownCities });
    }
  }
  // Todas las vencidas, no sólo las que caben: el presupuesto lo corta la puerta, y así una corrida
  // que no llega a todas termina "ok parcial" en vez de decir que completó.
  const due = selectDueCities(candidates, { now, cadence, limit: candidates.length });

  let cities = 0;
  let citiesEmpty = 0;
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
    const unreadable = unreadableItems(diagnostics);
    const write = await ctx.store.writeCityHotels({
      cityCode: city.code,
      hotels,
      unreadable,
      runStart: ctx.runStart,
      maxDrop: sweepMaxDrop,
    });
    cities += 1;
    if (isEmptyCity(write, hotels.length, unreadable)) citiesEmpty += 1;
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
        unreadable,
      });
    }
  }

  const summary: E3Result = {
    status: 'done',
    citiesDue: due.length,
    cities,
    citiesEmpty,
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
