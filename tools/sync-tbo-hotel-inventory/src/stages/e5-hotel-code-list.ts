import { isSweepAnomaly, type SweepVerdict } from '../catalog-rules.js';
import type { StopReason } from '../call-gate.js';
import { unreadableItems, type StageContext } from './context.js';

export type E5Result =
  | { readonly status: 'skipped'; readonly stopReason?: StopReason }
  | { readonly status: 'disabled'; readonly code: string }
  | {
      readonly status: 'done';
      readonly codesReceived: number;
      readonly previouslyActive: number;
      readonly missing: number;
      readonly verdict: SweepVerdict;
      readonly deactivated: number;
    };

/**
 * `hotelcodelist` no tiene por qué ser rápido (tamaño sin documentar, Q-61) y E3 va después: dos
 * intentos de hasta 180 s como mucho, no los tres de la tabla.
 */
const CODELIST_MAX_ATTEMPTS = 2;

/**
 * E5 — `GET hotelcodelist` (p. 55; 05 §6.3): los hoteles `tbo-hotels` activos que ya no están en
 * la lista global, y que ninguna ciudad listó dentro del ciclo de refresco, pasan a
 * `active = false`, con la misma guarda de caída máxima que E3.
 *
 * Es **opcional por contrato**: no está en Postman y su ejemplo no trae `Status` (CE-05). Si falla
 * —404, timeout, cuerpo roto, incluso un `401` de ese método—, E5 queda desactivada en esta corrida
 * y no desactiva nada, sin tocar E1-E3 (08 RF-30 CA 3): su fallo tampoco suma a las rachas que
 * cortan la corrida. Si el problema fuera la cuenta, E3 lo va a encontrar en su primera llamada.
 *
 * Corre ANTES de E3 aunque se numere después: es una sola llamada, y detrás de E3 la dejaría sin
 * tiempo cualquier corrida con muchas ciudades pendientes.
 */
export async function runHotelCodeListStage(ctx: StageContext): Promise<E5Result> {
  if (!ctx.settings.stages.has('E5')) return { status: 'skipped' };

  const result = await ctx.gate.call(
    (signal) => ctx.source.listAllHotelCodes({ signal, maxAttempts: CODELIST_MAX_ATTEMPTS }),
    { optional: true },
  );
  if (!result.ok) {
    const { failure } = result;
    if (failure.type === 'stopped') return { status: 'skipped', stopReason: failure.reason };
    const meta = { stage: 'E5', code: failure.code };
    if (failure.type === 'account') ctx.logger.error('tbo.sync.stage_disabled', meta);
    else ctx.logger.warn('tbo.sync.stage_disabled', meta);
    return { status: 'disabled', code: failure.code };
  }

  const { hotelCodes, diagnostics } = result.value;
  // Lo que E3 vio dentro del ciclo de refresco lo respalda la lista de su ciudad, que es la más
  // específica (Q-61 e). Con `runStart` como frontera no protegería nada, porque E5 corre antes que
  // E3: cada corrida apagaría lo que E3 confirmó la anterior, y un `hotelcodelist` que se actualiza
  // más lento que las ciudades (Q-61 d) escondería de la venta los hoteles nuevos. E5 queda para lo
  // que ninguna ciudad al día respalda: ciudades que fallan, con anomalía o que TBO ya no lista.
  const outcome = await ctx.store.deactivateMissing({
    hotelCodes,
    unreadable: unreadableItems(diagnostics),
    seenSince: new Date(ctx.runStart.getTime() - ctx.settings.cadence.regularMaxAgeMs),
    maxDrop: ctx.settings.sweepMaxDrop,
  });
  if (isSweepAnomaly(outcome.verdict) || outcome.verdict === 'incomplete-response') {
    ctx.logger.warn('tbo.sync.sweep_anomaly', {
      stage: 'E5',
      verdict: outcome.verdict,
      previouslyActive: outcome.previouslyActive,
      missing: outcome.missing,
      received: hotelCodes.length,
      unreadable: unreadableItems(diagnostics),
      maxDrop: ctx.settings.sweepMaxDrop,
    });
  }
  const summary: E5Result = { status: 'done', codesReceived: hotelCodes.length, ...outcome };
  ctx.logger.info('tbo.sync.stage', { stage: 'E5', ...summary });
  return summary;
}
