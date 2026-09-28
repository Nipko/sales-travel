import { CallGate, type StopReason } from './call-gate.js';
import type { CatalogStore } from './catalog-store.js';
import type { SyncSettings } from './env.js';
import type { SyncLogger } from './log.js';
import type { CatalogSource, StageContext } from './stages/context.js';
import { runCountriesStage, type E1Result } from './stages/e1-countries.js';
import { runCitiesStage, type E2Result } from './stages/e2-cities.js';
import { runCityHotelsStage, type E3Result } from './stages/e3-city-hotels.js';
import { runHotelContentStage, type E4Result } from './stages/e4-hotel-content.js';
import { runHotelCodeListStage, type E5Result } from './stages/e5-hotel-code-list.js';
import { runDestinationMapStage, type E6DestinationResult } from './stages/e6-destination-map.js';
import { runHotelMatchStage, type E6MatchResult } from './stages/e6-hotel-match.js';

/**
 * Una corrida del sync del catálogo TBO (docs/tbo/05 §6; 08 RF-30): lock consultivo, E1, E2, E5 y
 * E3 dentro del presupuesto; E6 (equivalencias de hotel y mapa de destinos, 08 RF-33 y RF-34), que
 * es sólo SQL; y E4 con lo que quede. E6 va antes que E4 porque el contenido prioriza los destinos
 * con demanda, y la demanda se lee por el mapa que E6 acaba de dejar al día.
 *
 * No escribe `domain_events`: el catálogo es dato de referencia de plataforma, no un cambio de
 * negocio, con el mismo criterio que el sync de Despegar (05 §6.6).
 */

export interface SyncDeps {
  readonly source: CatalogSource;
  readonly store: CatalogStore;
  readonly logger: SyncLogger;
  readonly now?: () => number;
  /** SIGTERM del contenedor: la corrida termina la ciudad en curso y sale "ok parcial". */
  readonly interrupt?: AbortSignal;
}

export type SyncReport =
  | { readonly action: 'skip'; readonly reason: 'locked' }
  | {
      readonly action: 'sync';
      /** `partial` = se cortó antes de recorrer lo pendiente; la próxima corrida sigue desde ahí. */
      readonly outcome: 'complete' | 'partial';
      readonly stopReason: StopReason | null;
      readonly provider: string;
      readonly runStart: string;
      readonly durationMs: number;
      readonly calls: number;
      readonly status429: number;
      readonly errorsByCode: Readonly<Record<string, number>>;
      readonly e1: E1Result;
      readonly e2: E2Result;
      readonly e3: E3Result;
      readonly e4: E4Result;
      readonly e5: E5Result;
      readonly e6: E6Result;
    };

export interface E6Result {
  readonly hotelMatch: E6MatchResult;
  readonly destinationMap: E6DestinationResult;
}

export async function runSync(settings: SyncSettings, deps: SyncDeps): Promise<SyncReport> {
  const now = deps.now ?? (() => Date.now());
  // Una segunda corrida mientras la primera sigue (un cron que se solapa con un dispatch manual)
  // sale sin hacer nada: dos escritores sobre la misma ciudad se pisarían el barrido (05 §6.4).
  if (!(await deps.store.tryLock())) {
    deps.logger.warn('tbo.sync.locked', { provider: settings.providerCode });
    return { action: 'skip', reason: 'locked' };
  }

  const startedAt = now();
  const gate = new CallGate(
    {
      maxCalls: settings.maxCalls,
      maxDurationMs: settings.maxDurationMs,
      maxConsecutiveThrottled: settings.maxConsecutiveThrottled,
      maxConsecutiveErrors: settings.maxConsecutiveErrors,
    },
    now,
    deps.interrupt,
  );
  const ctx: StageContext = {
    settings,
    source: deps.source,
    store: deps.store,
    gate,
    logger: deps.logger,
    runStart: new Date(startedAt),
    now,
  };

  try {
    const e1 = await runCountriesStage(ctx);
    const e2 = await runCitiesStage(ctx, e1.countries);
    const e5 = await runHotelCodeListStage(ctx);
    const e3 = await runCityHotelsStage(ctx, e1.countries);
    const hotelMatch = await runHotelMatchStage(ctx, e1.countries);
    const destinationMap = await runDestinationMapStage(ctx, e1.countries);
    const e4 = await runHotelContentStage(ctx, e1.countries);
    const counters = gate.counters();
    return {
      action: 'sync',
      outcome: counters.stopReason === undefined ? 'complete' : 'partial',
      stopReason: counters.stopReason ?? null,
      provider: settings.providerCode,
      runStart: ctx.runStart.toISOString(),
      durationMs: now() - startedAt,
      calls: counters.calls,
      status429: counters.status429,
      errorsByCode: counters.errorsByCode,
      e1,
      e2,
      e3,
      e4,
      e5,
      e6: { hotelMatch, destinationMap },
    };
  } finally {
    gate.dispose();
    try {
      await deps.store.unlock();
    } catch {
      // Si la conexión murió, el lock de sesión murió con ella; no hay nada más que liberar.
      deps.logger.warn('tbo.sync.unlock_failed', { provider: settings.providerCode });
    }
  }
}
