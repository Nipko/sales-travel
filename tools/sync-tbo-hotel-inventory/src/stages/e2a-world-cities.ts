import { throwIfAccountFailure, unreadableItems, type StageContext } from './context.js';

/**
 * Tope propio de E2A por corrida: una llamada de `CityList` por país, y TBO lista unos 250. Con
 * esto, la primera corrida baja el mundo entero de una vez y ninguna puede gastar más que eso
 * aunque el presupuesto general sea mayor.
 */
export const WORLD_CITY_LISTS_PER_RUN = 300;

export interface E2AResult {
  readonly status: 'done' | 'skipped' | 'failed';
  /** Países que lista `CountryList`. */
  readonly countriesInTbo: number;
  /** Países con ciudades ya guardadas (o de la corrida, que son de E2): no se piden. */
  readonly countriesSkipped: number;
  readonly countriesRequested: number;
  readonly countriesFailed: number;
  /** Pendientes que no entraron por el tope propio o el presupuesto: los pide la próxima corrida. */
  readonly countriesPending: number;
  readonly citiesReceived: number;
  readonly citiesUpserted: number;
}

function skipped(status: E2AResult['status'] = 'skipped'): E2AResult {
  return {
    status,
    countriesInTbo: 0,
    countriesSkipped: 0,
    countriesRequested: 0,
    countriesFailed: 0,
    countriesPending: 0,
    citiesReceived: 0,
    citiesUpserted: 0,
  };
}

/**
 * E2A — las ciudades de TODOS los países de TBO (`CountryList` + un `CityList` por país, pp. 51-54)
 * → `hotel_provider_city`, sin hoteles. Es la cobertura global del buscador: con la ciudad en el
 * catálogo, el autocompletado la sugiere aunque todavía no tenga hoteles ("se cargan al buscar") y
 * el API trae sus `HotelCodes` con un `TBOHotelCodeList` la primera vez que alguien la busca.
 *
 * - **Opt-in**: no está en las etapas por defecto (`TBO_SYNC_STAGES`). Se corre a mano con
 *   `stages=E1,E2A` y `max_calls=300` desde el workflow, y otra vez cuando haga falta sumar países.
 * - **Sólo lo que falta**: un país que ya tiene ciudades guardadas no se vuelve a pedir, y los de
 *   `TBO_SYNC_COUNTRIES` son de E2 cuando E2 corre, que los refresca con su propia cadencia (en una
 *   corrida `E1,E2A` los pide E2A si todavía no tienen ciudades). Así, repetirla cuesta una llamada
 *   (`CountryList`) más los países nuevos o sin ciudades.
 * - **Con su propio tope** ({@link WORLD_CITY_LISTS_PER_RUN}) y al FINAL de la corrida: nunca le
 *   quita presupuesto a E3 ni a E4, que son lo que se vende hoy.
 * - **No toca hoteles** ni el checkpoint de ninguna ciudad: E3 sigue recorriendo sólo los países
 *   de la corrida y las ciudades buscadas; el resto queda con `hotel_count` en `NULL`, que es lo que
 *   el API lee como "se carga al buscar".
 */
export async function runWorldCitiesStage(ctx: StageContext): Promise<E2AResult> {
  if (!ctx.settings.stages.has('E2A')) return skipped();
  // Una corrida que ya se cortó no gasta una consulta: la puerta no dejaría pedir nada.
  if (ctx.gate.stopReason !== undefined) return skipped();

  const list = await ctx.gate.call((signal) => ctx.source.listCountries({ signal }));
  if (!list.ok) {
    throwIfAccountFailure(list.failure, 'E2A');
    // La puerta no la dejó salir (presupuesto, SIGTERM): no es un fallo, es lo que queda para la
    // próxima corrida.
    if (list.failure.type === 'stopped') return skipped();
    ctx.logger.warn('tbo.sync.stage_failed', { stage: 'E2A', code: list.failure.code });
    return skipped('failed');
  }

  const inTbo = [...new Set(list.value.countries.map((country) => country.code))].sort();
  if (unreadableItems(list.value.diagnostics) > 0) {
    // Una lista con países ilegibles sigue sirviendo para los legibles: E2A sólo AGREGA ciudades.
    ctx.logger.warn('tbo.sync.countries_unreadable', {
      stage: 'E2A',
      rejected: list.value.diagnostics.rejected,
    });
  }
  // Los países de la corrida son de E2 SÓLO si E2 corre (E2 también corre para E3). En una corrida
  // `E1,E2A` nadie más les pediría la lista, y un país de la corrida todavía sin ciudades quedaría
  // fuera de la cobertura global.
  const stages = ctx.settings.stages;
  const e2Runs = stages.has('E2') || stages.has('E3');
  const configured = new Set(e2Runs ? ctx.settings.countries : []);
  const stored = await ctx.store.countCitiesByCountry(inTbo);
  const pending = inTbo.filter(
    (country) => !configured.has(country) && (stored.get(country) ?? 0) === 0,
  );

  let countriesRequested = 0;
  let countriesFailed = 0;
  let citiesReceived = 0;
  let citiesUpserted = 0;
  let attempted = 0;
  for (const country of pending) {
    if (attempted >= WORLD_CITY_LISTS_PER_RUN || ctx.gate.stopReason !== undefined) break;
    attempted += 1;
    const result = await ctx.gate.call((signal) => ctx.source.listCities(country, { signal }));
    if (!result.ok) {
      throwIfAccountFailure(result.failure, 'E2A');
      if (result.failure.type === 'stopped') {
        attempted -= 1;
        break;
      }
      countriesFailed += 1;
      ctx.logger.warn('tbo.sync.country_failed', {
        stage: 'E2A',
        country,
        code: result.failure.code,
      });
      continue;
    }
    countriesRequested += 1;
    citiesReceived += result.value.cities.length;
    citiesUpserted += await ctx.store.upsertCities(country, result.value.cities);
  }

  const summary: E2AResult = {
    status: 'done',
    countriesInTbo: inTbo.length,
    countriesSkipped: inTbo.length - pending.length,
    countriesRequested,
    countriesFailed,
    countriesPending: pending.length - attempted,
    citiesReceived,
    citiesUpserted,
  };
  ctx.logger.info('tbo.sync.stage', { stage: 'E2A', ...summary });
  return summary;
}
