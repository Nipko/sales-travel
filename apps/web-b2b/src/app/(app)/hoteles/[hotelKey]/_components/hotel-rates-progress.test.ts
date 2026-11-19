import { describe, expect, it, vi } from 'vitest';
import {
  RATES_ENDPOINT,
  RATES_UNREACHABLE,
  fetchRatesByProvider,
  pendingProviders,
  ratesSoFar,
  readProviderRates,
  settleProvider,
  startRates,
  type ProviderRatesArrival,
} from './hotel-rates-progress';

/*
 * Las tarifas de la ficha llegan proveedor por proveedor: lo que respondió se pinta ya, lo que
 * falta se cuenta, y un proveedor colgado o caído no frena ni tapa a los demás.
 */

const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };
const REFS = [DESPEGAR, TBO];

const offer = (hotelId: string) => ({ hotelId, roompacks: [] });

describe('settleProvider / ratesSoFar', () => {
  it('nada que pintar hasta que responde alguien; después, en el orden de la clave', () => {
    let progress = startRates(REFS);
    expect(ratesSoFar(progress)).toBeUndefined();
    expect(pendingProviders(progress)).toBe(2);

    progress = settleProvider(progress, {
      outcome: { ref: TBO, offer: offer('1402689') },
      receivedAt: 2_000,
    });
    expect(pendingProviders(progress)).toBe(1);
    expect(ratesSoFar(progress)).toEqual({
      ok: true,
      outcomes: [{ ref: TBO, offer: offer('1402689') }],
      receivedAt: 2_000,
    });

    progress = settleProvider(progress, {
      outcome: { ref: DESPEGAR, error: 'caído' },
      receivedAt: 1_000,
      nonRefundableBlocked: true,
    });
    expect(pendingProviders(progress)).toBe(0);
    const result = ratesSoFar(progress);
    expect(result?.outcomes.map((o) => o.ref.provider)).toEqual(['despegar-hotels', 'tbo-hotels']);
    // La hora más nueva del servidor, y un `blocked` de cualquiera alcanza.
    expect(result?.receivedAt).toBe(2_000);
    expect(result?.nonRefundableBlocked).toBe(true);
  });

  it('un proveedor que falla no tapa al que respondió; uno que no es de la clave no cuenta', () => {
    let progress = startRates(REFS);
    progress = settleProvider(progress, { outcome: { ref: TBO, error: 'Tiempo agotado' } });
    expect(ratesSoFar(progress)).toMatchObject({ ok: false });
    progress = settleProvider(progress, {
      outcome: { ref: { provider: 'hotelbeds', hotelId: '1' }, offer: offer('1') },
    });
    expect(pendingProviders(progress)).toBe(1);
    progress = settleProvider(progress, { outcome: { ref: DESPEGAR, offer: offer('555') } });
    expect(ratesSoFar(progress)).toMatchObject({ ok: true });
  });
});

describe('readProviderRates', () => {
  it('arma el desenlace con el ref pedido, no con el de la respuesta', () => {
    const arrival = readProviderRates(TBO, 200, {
      outcome: { ref: DESPEGAR, offer: offer('1402689'), accountEnvironment: 'test' },
      receivedAt: 5,
      nonRefundableBlocked: true,
    });
    expect(arrival).toEqual({
      outcome: { ref: TBO, offer: offer('1402689'), accountEnvironment: 'test' },
      receivedAt: 5,
      nonRefundableBlocked: true,
    });
  });

  it('un error de la ruta, un cuerpo raro o un entorno desconocido no pasan como tarifas', () => {
    expect(readProviderRates(TBO, 400, { message: 'Faltan datos.' }).outcome).toEqual({
      ref: TBO,
      error: 'Faltan datos.',
    });
    expect(readProviderRates(TBO, 502, undefined).outcome.error).toBe(RATES_UNREACHABLE);
    expect(readProviderRates(TBO, 200, 'hola').outcome.offer).toBeUndefined();
    expect(
      readProviderRates(TBO, 200, { outcome: { error: 'TBO no respondió.' } }).outcome,
    ).toEqual({ ref: TBO, error: 'TBO no respondió.' });
    expect(
      readProviderRates(TBO, 200, {
        outcome: { offer: offer('1'), accountEnvironment: 'sandbox' },
      }).outcome,
    ).not.toHaveProperty('accountEnvironment');
  });
});

describe('fetchRatesByProvider', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('un pedido por proveedor; el rápido se avisa sin esperar al lento', async () => {
    const slow = deferred<Response>();
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      const { provider } = JSON.parse(init.body as string) as { provider: string };
      return provider === 'tbo-hotels'
        ? slow.promise
        : Promise.resolve(
            new Response(JSON.stringify({ outcome: { offer: offer('555') }, receivedAt: 1 })),
          );
    });
    const arrivals: ProviderRatesArrival[] = [];
    const done = fetchRatesByProvider(
      'KEY',
      REFS,
      { checkinDate: '2026-10-12' },
      (a) => arrivals.push(a),
      new AbortController().signal,
      fetcher as unknown as typeof fetch,
    );

    await vi.waitFor(() => expect(arrivals).toHaveLength(1));
    expect(arrivals[0]?.outcome).toEqual({ ref: DESPEGAR, offer: offer('555') });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe(RATES_ENDPOINT);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toEqual({
      hotelKey: 'KEY',
      provider: 'despegar-hotels',
      stay: { checkinDate: '2026-10-12' },
    });

    slow.resolve(new Response(JSON.stringify({ outcome: { error: 'Tiempo agotado' } })));
    await done;
    expect(arrivals[1]?.outcome).toEqual({ ref: TBO, error: 'Tiempo agotado' });
  });

  it('un corte de red es el error de ese proveedor; abortada, no avisa nada', async () => {
    const arrivals: ProviderRatesArrival[] = [];
    await fetchRatesByProvider(
      'KEY',
      [TBO],
      {},
      (a) => arrivals.push(a),
      new AbortController().signal,
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    expect(arrivals).toEqual([{ outcome: { ref: TBO, error: RATES_UNREACHABLE } }]);

    const run = new AbortController();
    run.abort();
    const none: ProviderRatesArrival[] = [];
    await fetchRatesByProvider(
      'KEY',
      [TBO],
      {},
      (a) => none.push(a),
      run.signal,
      () => Promise.resolve(new Response('{}')),
    );
    expect(none).toEqual([]);
  });
});
