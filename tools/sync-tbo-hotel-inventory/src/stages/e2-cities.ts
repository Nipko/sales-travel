import { throwIfAccountFailure, type StageContext } from './context.js';

export interface E2Result {
  readonly countriesRequested: number;
  readonly countriesSkipped: number;
  readonly countriesFailed: number;
  readonly citiesReceived: number;
  readonly citiesUpserted: number;
}

/**
 * E2 — `POST CityList` por país (p. 53; 05 §6.3) → upsert en `hotel_provider_city`.
 *
 * Un país sin ninguna ciudad guardada pide su lista aunque la corrida no incluya E2: sin ciudades,
 * E3 no tiene nada que recorrer y el primer despliegue quedaría esperando a la corrida semanal.
 * Una ciudad que TBO deja de listar no se borra (nunca `DELETE`, 05 §6.5): su último catálogo
 * sigue siendo el que se vio.
 */
export async function runCitiesStage(
  ctx: StageContext,
  countries: readonly string[],
): Promise<E2Result> {
  const { stages } = ctx.settings;
  if (!stages.has('E2') && !stages.has('E3')) {
    return {
      countriesRequested: 0,
      countriesSkipped: countries.length,
      countriesFailed: 0,
      citiesReceived: 0,
      citiesUpserted: 0,
    };
  }
  const stored = await ctx.store.countCitiesByCountry(countries);

  let countriesRequested = 0;
  let countriesSkipped = 0;
  let countriesFailed = 0;
  let citiesReceived = 0;
  let citiesUpserted = 0;
  for (const country of countries) {
    if (!stages.has('E2') && (stored.get(country) ?? 0) > 0) {
      countriesSkipped += 1;
      continue;
    }
    const result = await ctx.gate.call((signal) => ctx.source.listCities(country, { signal }));
    if (!result.ok) {
      throwIfAccountFailure(result.failure, 'E2');
      if (result.failure.type === 'stopped') break;
      countriesFailed += 1;
      ctx.logger.warn('tbo.sync.country_failed', {
        stage: 'E2',
        country,
        code: result.failure.code,
      });
      continue;
    }
    countriesRequested += 1;
    citiesReceived += result.value.cities.length;
    citiesUpserted += await ctx.store.upsertCities(country, result.value.cities);
    if (result.value.diagnostics.mapped < result.value.diagnostics.received) {
      ctx.logger.warn('tbo.sync.cities_discarded', {
        stage: 'E2',
        country,
        received: result.value.diagnostics.received,
        mapped: result.value.diagnostics.mapped,
        rejected: result.value.diagnostics.rejected,
      });
    }
  }

  const summary: E2Result = {
    countriesRequested,
    countriesSkipped,
    countriesFailed,
    citiesReceived,
    citiesUpserted,
  };
  ctx.logger.info('tbo.sync.stage', { stage: 'E2', ...summary });
  return summary;
}
