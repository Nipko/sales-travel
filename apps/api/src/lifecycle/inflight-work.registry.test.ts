import { describe, expect, it, vi } from 'vitest';
import { InflightWorkRegistry } from './inflight-work.registry.js';

/** Registro del trabajo que sigue después de responder (docs/tbo/09 PR-4.10; 03 §4.5). */

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('InflightWorkRegistry', () => {
  it('devuelve la misma promesa y cuenta por tipo mientras el trabajo sigue', async () => {
    const registry = new InflightWorkRegistry();
    const book = deferred<string>();
    const otro = deferred<number>();

    const tracked = registry.track('hotel-book', book.promise);
    void registry.track('hotel-book', deferred().promise);
    void registry.track('verificacion', otro.promise);

    expect(tracked).toBe(book.promise);
    expect(registry.size).toBe(3);
    expect(registry.countsByKind()).toEqual({ 'hotel-book': 2, verificacion: 1 });

    book.resolve('confirmada');
    await expect(tracked).resolves.toBe('confirmada');
    expect(registry.countsByKind()).toEqual({ 'hotel-book': 1, verificacion: 1 });
  });

  it('whenIdle resuelve en el acto sin trabajo y, con trabajo, cuando termina el último', async () => {
    const registry = new InflightWorkRegistry();
    await expect(registry.whenIdle()).resolves.toBeUndefined();

    const a = deferred();
    const b = deferred();
    void registry.track('hotel-book', a.promise);
    void registry.track('hotel-book', b.promise).catch(() => undefined);
    let idle = false;
    const waiting = registry.whenIdle().then(() => {
      idle = true;
    });

    a.resolve();
    await a.promise;
    await Promise.resolve();
    expect(idle).toBe(false);

    // Un trabajo que falla también libera el registro: si no, el apagado esperaría hasta el plazo.
    b.reject(new Error('timeout del proveedor'));
    await waiting;
    expect(idle).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.countsByKind()).toEqual({});
  });

  it('el rechazo sigue siendo del llamador y el registro no deja un rechazo sin manejar', async () => {
    const registry = new InflightWorkRegistry();
    const falla = deferred();

    const tracked = registry.track('hotel-book', falla.promise);
    falla.reject(new Error('BOOK_FAILED'));

    await expect(tracked).rejects.toThrow('BOOK_FAILED');
    await registry.whenIdle();
    expect(registry.size).toBe(0);
  });

  it('begin cuenta hasta liberar y liberar dos veces no descuenta un trabajo ajeno', async () => {
    const registry = new InflightWorkRegistry();
    const release = registry.begin('http-handler');
    void registry.track('hotel-book', deferred().promise);
    let idle = false;
    void registry.whenIdle().then(() => {
      idle = true;
    });

    release();
    release();
    await Promise.resolve();

    expect(registry.countsByKind()).toEqual({ 'hotel-book': 1 });
    expect(idle).toBe(false);
  });
});

describe('InflightWorkRegistry: onShutdown', () => {
  it('no corre nada hasta startShutdown; después corre cada stop una vez y lo cuenta como trabajo', async () => {
    const registry = new InflightWorkRegistry();
    const closing = deferred();
    const stop = vi.fn(() => closing.promise);
    const onError = vi.fn();

    registry.onShutdown('post-sale-worker', stop);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);

    registry.startShutdown(onError);
    registry.startShutdown(onError);
    expect(registry.countsByKind()).toEqual({ 'post-sale-worker': 1 });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    closing.resolve();
    await registry.whenIdle();
    expect(stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('un stop que falla, también en el acto, va a onError con su tipo y libera el registro', async () => {
    const registry = new InflightWorkRegistry();
    const onError = vi.fn();
    const redisDown = new Error('Connection is closed.');
    const sync = new Error('sin conexión');

    registry.onShutdown('post-sale-worker', () => Promise.reject(redisDown));
    registry.onShutdown('otro-worker', () => {
      throw sync;
    });
    registry.startShutdown(onError);
    await registry.whenIdle();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('post-sale-worker', redisDown);
    expect(onError).toHaveBeenCalledWith('otro-worker', sync);
    expect(registry.size).toBe(0);
  });

  it('un stop registrado cuando el apagado ya empezó corre en el acto', async () => {
    const registry = new InflightWorkRegistry();
    registry.startShutdown(vi.fn());
    const stop = vi.fn(() => Promise.resolve());

    registry.onShutdown('post-sale-worker', stop);

    expect(registry.size).toBe(1);
    await registry.whenIdle();
    expect(stop).toHaveBeenCalledOnce();
  });
});
