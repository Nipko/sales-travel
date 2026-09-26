import { describe, expect, it } from 'vitest';
import {
  SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS,
  SHUTDOWN_MAX_DRAIN_TIMEOUT_MS,
  loadShutdownConfig,
} from './shutdown.config.js';

/** Plazo del drenaje en el apagado ordenado, leído del entorno (docs/tbo/09 PR-4.10). */

describe('loadShutdownConfig', () => {
  it('sin valor usa 125 s, que cabe en el stop_grace_period de 130 s del compose', () => {
    for (const env of [
      {},
      { SHUTDOWN_DRAIN_TIMEOUT_MS: '' },
      { SHUTDOWN_DRAIN_TIMEOUT_MS: '   ' },
    ]) {
      expect(loadShutdownConfig(env)).toEqual({
        drainTimeoutMs: SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS,
      });
    }
    expect(SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS).toBe(125_000);
    expect(SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS).toBeLessThan(130_000);
  });

  it('acepta enteros de milisegundos entre 0 y el tope', () => {
    expect(loadShutdownConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: '0' })).toEqual({ drainTimeoutMs: 0 });
    expect(loadShutdownConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: ' 60000 ' })).toEqual({
      drainTimeoutMs: 60_000,
    });
    expect(
      loadShutdownConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: String(SHUTDOWN_MAX_DRAIN_TIMEOUT_MS) }),
    ).toEqual({ drainTimeoutMs: SHUTDOWN_MAX_DRAIN_TIMEOUT_MS });
  });

  it('un valor inválido cae al de por defecto, dice por qué y no repite el valor', () => {
    for (const raw of ['-1', '12.5', '125s', 'abc', '300001', '99999999', '1e5']) {
      const config = loadShutdownConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: raw });

      expect(config.drainTimeoutMs).toBe(SHUTDOWN_DEFAULT_DRAIN_TIMEOUT_MS);
      expect(config.invalidReason).toBe(
        'SHUTDOWN_DRAIN_TIMEOUT_MS debe ser un entero de milisegundos entre 0 y 300000; se usa 125000',
      );
      expect(config.invalidReason).not.toContain(raw);
    }
  });
});
