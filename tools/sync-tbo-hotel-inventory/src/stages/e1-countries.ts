import { throwIfAccountFailure, unreadableItems, type StageContext } from './context.js';

export interface E1Result {
  readonly status: 'done' | 'skipped' | 'failed';
  /** Los países con que siguen E2 y E3. */
  readonly countries: readonly string[];
  /** Configurados que TBO no lista: no se piden sus ciudades. */
  readonly unknownCountries: readonly string[];
}

/**
 * E1 — `GET CountryList` (p. 51; 05 §6.3): que los países de `TBO_SYNC_COUNTRIES` existan en TBO
 * antes de gastar una llamada de `CityList` por cada uno.
 *
 * Si la lista no se puede leer entera, se sigue con los países configurados: E2 revela el mismo
 * problema país por país, y descartar un país por un error de lectura dejaría su catálogo sin
 * refrescar sin que nadie lo note.
 */
export async function runCountriesStage(ctx: StageContext): Promise<E1Result> {
  const configured = ctx.settings.countries;
  if (!ctx.settings.stages.has('E1')) {
    return { status: 'skipped', countries: configured, unknownCountries: [] };
  }

  const result = await ctx.gate.call((signal) => ctx.source.listCountries({ signal }));
  if (!result.ok) {
    throwIfAccountFailure(result.failure, 'E1');
    ctx.logger.warn('tbo.sync.stage_failed', {
      stage: 'E1',
      ...(result.failure.type === 'failed' ? { code: result.failure.code } : {}),
      ...(result.failure.type === 'stopped' ? { stopReason: result.failure.reason } : {}),
    });
    return { status: 'failed', countries: configured, unknownCountries: [] };
  }

  const { countries, diagnostics } = result.value;
  const known = new Set(countries.map((country) => country.code));
  const complete = known.size > 0 && unreadableItems(diagnostics) === 0;
  const unknownCountries = complete ? configured.filter((code) => !known.has(code)) : [];
  const kept = configured.filter((code) => !unknownCountries.includes(code));

  ctx.logger.info('tbo.sync.stage', {
    stage: 'E1',
    countriesConfigured: configured.length,
    countriesInTbo: known.size,
    countries: kept,
    ...(unknownCountries.length > 0 ? { unknownCountries } : {}),
    ...(complete ? {} : { validation: 'skipped_incomplete_list' }),
    diagnostics: { rejected: diagnostics.rejected, notes: diagnostics.notes },
  });
  return { status: 'done', countries: kept, unknownCountries };
}
