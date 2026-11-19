import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotelSearchDeadlineError, withDeadline } from './hotel-search-deadline.js';

/*
 * El plazo de una ola: lo que llega a tiempo pasa tal cual; lo que no, rechaza con un motivo
 * legible, sin cancelar la llamada y sin dejar rechazos sueltos.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('withDeadline', () => {
  it('lo que llega a tiempo pasa tal cual, éxito o fallo', async () => {
    await expect(withDeadline(Promise.resolve([1]), 1_000, 'tbo-hotels')).resolves.toEqual([1]);
    const caido = new Error('caído');
    await expect(withDeadline(Promise.reject(caido), 1_000, 'tbo-hotels')).rejects.toBe(caido);
  });

  it('vencido el plazo rechaza con el proveedor y los segundos', async () => {
    vi.useFakeTimers();
    const espera = withDeadline(new Promise<never>(() => undefined), 8_000, 'tbo-hotels');
    const resultado = espera.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8_000);
    const err = await resultado;
    expect(err).toBeInstanceOf(HotelSearchDeadlineError);
    expect(err).toMatchObject({ providerCode: 'tbo-hotels', deadlineMs: 8_000 });
    expect((err as Error).message).toMatch(/^No respondió en 8 s/);
  });

  it('el rechazo tardío de la llamada queda atendido', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let tirar!: (e: Error) => void;
      const llamada = new Promise<never>((_, reject) => (tirar = reject));
      await withDeadline(llamada, 5, 'tbo-hotels').catch(() => undefined);
      tirar(new Error('timeout del cliente'));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('lo que llega a tiempo no deja el temporizador corriendo', async () => {
    vi.useFakeTimers();
    await withDeadline(Promise.resolve('ok'), 8_000, 'tbo-hotels');
    expect(vi.getTimerCount()).toBe(0);
  });
});
