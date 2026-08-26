import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerService } from './circuit-breaker.service.js';

/** Los mismos números que declara el servicio; si cambian allá, este test debe fallar. */
const FAILURE_THRESHOLD = 5;
const OPEN_MS = 30_000;

const CAÍDO = () => Promise.reject(new Error('proveedor caído'));

/** Rompe el circuito de `code` con los fallos consecutivos que exige el umbral. */
async function abrirCircuito(breaker: CircuitBreakerService, code: string): Promise<void> {
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    await expect(breaker.execute(code, CAÍDO)).rejects.toThrow('proveedor caído');
  }
}

describe('CircuitBreakerService', () => {
  let breaker: CircuitBreakerService;
  let envGuardado: string | undefined;

  beforeEach(() => {
    envGuardado = process.env['PROVIDERS_DISABLED'];
    delete process.env['PROVIDERS_DISABLED'];
    // El servicio avisa por log en cada apertura/restablecimiento: sin esto el runner
    // escupe ruido que no distingue un fallo real de un caso de prueba esperado.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    breaker = new CircuitBreakerService();
  });

  afterEach(() => {
    if (envGuardado === undefined) delete process.env['PROVIDERS_DISABLED'];
    else process.env['PROVIDERS_DISABLED'] = envGuardado;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('apertura por fallos consecutivos', () => {
    it('deja pasar y propaga los primeros 4 fallos sin abrir el circuito', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
        await expect(breaker.execute('prov-a', CAÍDO)).rejects.toThrow('proveedor caído');
      }
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 4 });
    });

    it(`${FAILURE_THRESHOLD} fallos consecutivos abren el circuito`, async () => {
      await abrirCircuito(breaker, 'prov-a');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 5 });
    });

    it('con el circuito abierto falla al instante SIN llamar al proveedor', async () => {
      await abrirCircuito(breaker, 'prov-a');

      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-a', run)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(run).not.toHaveBeenCalled();
    });

    it('un éxito intercalado resetea el contador de fallos', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
        await expect(breaker.execute('prov-a', CAÍDO)).rejects.toThrow('proveedor caído');
      }
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
    });

    it('el circuito es POR proveedor: abrir uno no toca al otro', async () => {
      await abrirCircuito(breaker, 'prov-a');

      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-b', run)).resolves.toBe('ok');
      expect(run).toHaveBeenCalledTimes(1);
      expect(breaker.snapshot()['prov-a']?.state).toBe('open');
      expect(breaker.snapshot()['prov-b']?.state).toBe('closed');
    });
  });

  describe(`half-open a los ${OPEN_MS / 1000} s (reloj falso)`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('antes de la ventana sigue rechazando sin llamar al proveedor', async () => {
      await abrirCircuito(breaker, 'prov-a');
      vi.advanceTimersByTime(OPEN_MS - 1);

      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-a', run)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(run).not.toHaveBeenCalled();
    });

    it('cumplida la ventana deja pasar UNA sonda y, si va bien, cierra el circuito', async () => {
      await abrirCircuito(breaker, 'prov-a');
      vi.advanceTimersByTime(OPEN_MS);

      const sonda = vi.fn(() => Promise.resolve('vivo'));
      await expect(breaker.execute('prov-a', sonda)).resolves.toBe('vivo');
      expect(sonda).toHaveBeenCalledTimes(1);
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
    });

    it('si la sonda falla, un solo fallo vuelve a abrir y reinicia la ventana', async () => {
      await abrirCircuito(breaker, 'prov-a');
      vi.advanceTimersByTime(OPEN_MS);

      await expect(breaker.execute('prov-a', CAÍDO)).rejects.toThrow('proveedor caído');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 6 });

      // La ventana se reinició: justo antes de los 30 s nuevos sigue cerrado al tráfico.
      vi.advanceTimersByTime(OPEN_MS - 1);
      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-a', run)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('kill-switch PROVIDERS_DISABLED', () => {
    it('apaga sólo al proveedor nombrado y no afecta a los demás', async () => {
      process.env['PROVIDERS_DISABLED'] = 'prov-a';

      const apagado = vi.fn(() => Promise.resolve('no debería'));
      await expect(breaker.execute('prov-a', apagado)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(apagado).not.toHaveBeenCalled();

      const vivo = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-b', vivo)).resolves.toBe('ok');
      expect(vivo).toHaveBeenCalledTimes(1);
    });

    it('acepta lista separada por comas con espacios y entradas vacías', async () => {
      process.env['PROVIDERS_DISABLED'] = ' prov-a , ,prov-b ';

      await expect(breaker.execute('prov-a', () => Promise.resolve(1))).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(breaker.execute('prov-b', () => Promise.resolve(1))).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(breaker.execute('prov-c', () => Promise.resolve(1))).resolves.toBe(1);
    });

    it('el kill-switch no cuenta como fallo del circuito (no lo abre)', async () => {
      process.env['PROVIDERS_DISABLED'] = 'prov-a';
      for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) {
        await expect(breaker.execute('prov-a', () => Promise.resolve(1))).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      }

      // El circuito ni siquiera se materializa: se corta antes de tocarlo.
      expect(breaker.snapshot()['prov-a']).toBeUndefined();

      delete process.env['PROVIDERS_DISABLED'];
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it('sin la variable definida no apaga nada', async () => {
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });
  });

  describe('snapshot', () => {
    it('arranca vacío y sólo lista proveedores ya usados', async () => {
      expect(breaker.snapshot()).toEqual({});
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
      expect(breaker.snapshot()).toEqual({ 'prov-a': { state: 'closed', failures: 0 } });
    });
  });
});
