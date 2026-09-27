import { describe, expect, it } from 'vitest';
import { POST_SALE_SWEEP_EVERY_MS } from '../queue/post-sale-queue.service.js';
import { SWEEP_RETRY_MAX_MS, SWEEP_RETRY_MIN_MS, sweepRetryAt } from './sweep-retry.js';

/** El backoff de una lectura del barrido que falló (HARD-2), sin I/O. */

const MIN = 60_000;
const T = Date.parse('2026-09-25T15:00:00Z');

describe('sweepRetryAt', () => {
  it('la espera mínima es una corrida del barrido: esperar menos no cambia nada', () => {
    expect(SWEEP_RETRY_MIN_MS).toBe(POST_SALE_SWEEP_EVERY_MS);
    expect(sweepRetryAt({ now: T, dueAt: T })).toBe(T + SWEEP_RETRY_MIN_MS);
    // Un reloj que llega antes de la hora del plan no da una espera negativa.
    expect(sweepRetryAt({ now: T, dueAt: T + 10 * MIN })).toBe(T + SWEEP_RETRY_MIN_MS);
  });

  it('la espera es la demora respecto del plan: se duplica con cada corrida fallida', () => {
    let now = T + 20 * MIN;
    const esperas: number[] = [];
    for (let i = 0; i < 4; i++) {
      const at = sweepRetryAt({ now, dueAt: T });
      esperas.push((at - now) / MIN);
      now = at;
    }
    expect(esperas).toEqual([20, 40, 80, 160]);
  });

  it('no pasa del techo general ni del propio, si el plan tiene una cadencia más corta', () => {
    expect(sweepRetryAt({ now: T + 48 * 60 * MIN, dueAt: T })).toBe(
      T + 48 * 60 * MIN + SWEEP_RETRY_MAX_MS,
    );
    expect(sweepRetryAt({ now: T + 5 * 60 * MIN, dueAt: T, maxWaitMs: 60 * MIN })).toBe(
      T + 6 * 60 * MIN,
    );
    // Un techo propio mayor que el general no lo levanta.
    expect(sweepRetryAt({ now: T + 48 * 60 * MIN, dueAt: T, maxWaitMs: 48 * 60 * MIN })).toBe(
      T + 48 * 60 * MIN + SWEEP_RETRY_MAX_MS,
    );
  });

  it('nunca pasa el plazo siguiente del plan', () => {
    expect(sweepRetryAt({ now: T + 20 * MIN, dueAt: T, deadline: T + 30 * MIN })).toBe(
      T + 30 * MIN,
    );
    // Un plazo que ya llegó: la corrida siguiente, que el plan ya dice qué leer.
    expect(sweepRetryAt({ now: T + 20 * MIN, dueAt: T, deadline: T + 10 * MIN })).toBe(
      T + 20 * MIN,
    );
    // Un plazo lejano no acorta nada.
    expect(sweepRetryAt({ now: T + 20 * MIN, dueAt: T, deadline: T + 24 * 60 * MIN })).toBe(
      T + 40 * MIN,
    );
  });
});
