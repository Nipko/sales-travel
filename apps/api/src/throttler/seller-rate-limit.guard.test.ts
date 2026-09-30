import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import {
  SELLER_RATE_LIMIT_KEY,
  SellerRateLimitGuard,
  type SellerRateLimitOptions,
} from './seller-rate-limit.guard.js';

/**
 * El tope por vendedor de las rutas de venta de hoteles: cada vendedor tiene su cupo aunque todos
 * lleguen desde el mismo peer (web-b2b llama desde su servidor), y el que se pasa recibe 429 con
 * Retry-After sin afectar a los demás.
 */

const LIMITE: SellerRateLimitOptions = { bucket: 'hotels-book', limit: 3, ttlMs: 60_000 };
const PEER = { 'x-edge-peer-ip': '10.0.0.7' };

/** `null`: la ruta no declara cupo. */
function contexto(options: SellerRateLimitOptions | null = LIMITE) {
  const headers: Record<string, string> = {};
  const handler = () => undefined;
  if (options !== null) Reflect.defineMetadata(SELLER_RATE_LIMIT_KEY, options, handler);
  const ctx = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: PEER, ip: '10.0.0.7' }),
      getResponse: () => ({
        header: (k: string, v: string) => {
          headers[k] = v;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

function como<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

function intentos(
  guard: SellerRateLimitGuard,
  context: RequestContext,
  n: number,
  ctx = contexto(),
) {
  const resultados: ('ok' | 429)[] = [];
  for (let i = 0; i < n; i += 1) {
    try {
      como(context, () => guard.canActivate(ctx.ctx));
      resultados.push('ok');
    } catch (err) {
      expect(err).toBeInstanceOf(ThrottlerException);
      expect((err as ThrottlerException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      resultados.push(429);
    }
  }
  return resultados;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SellerRateLimitGuard', () => {
  it('cuenta por vendedor: varios vendedores detrás del mismo peer no comparten cupo', () => {
    const guard = new SellerRateLimitGuard(new Reflector());

    const primero = intentos(guard, { userId: 'u1', tenantId: 't1' }, 5);
    const segundo = intentos(guard, { userId: 'u2', tenantId: 't1' }, 3);
    const deOtraAgencia = intentos(guard, { userId: 'u3', tenantId: 't2' }, 3);

    expect(primero).toEqual(['ok', 'ok', 'ok', 429, 429]);
    expect(segundo).toEqual(['ok', 'ok', 'ok']);
    expect(deOtraAgencia).toEqual(['ok', 'ok', 'ok']);
  });

  it('el mismo vendedor en otro nodo activo tiene otro cupo', () => {
    const guard = new SellerRateLimitGuard(new Reflector());

    intentos(guard, { userId: 'u1', tenantId: 't1' }, 3);

    expect(intentos(guard, { userId: 'u1', tenantId: 't1' }, 1)).toEqual([429]);
    expect(intentos(guard, { userId: 'u1', tenantId: 't2' }, 1)).toEqual(['ok']);
  });

  it('el 429 dice cuándo reintentar y la ventana siguiente vuelve a abrir', () => {
    const guard = new SellerRateLimitGuard(new Reflector());
    const c = contexto();

    intentos(guard, { userId: 'u1', tenantId: 't1' }, 3, c);
    vi.advanceTimersByTime(20_000);
    expect(intentos(guard, { userId: 'u1', tenantId: 't1' }, 1, c)).toEqual([429]);
    expect(c.headers['Retry-After']).toBe('40');

    vi.advanceTimersByTime(40_000);
    expect(intentos(guard, { userId: 'u1', tenantId: 't1' }, 1, c)).toEqual(['ok']);
  });

  it('rutas con cupos distintos no se descuentan entre sí', () => {
    const guard = new SellerRateLimitGuard(new Reflector());
    const prebook = contexto({ bucket: 'hotels-prebook', limit: 3, ttlMs: 60_000 });

    intentos(guard, { userId: 'u1', tenantId: 't1' }, 3);

    expect(intentos(guard, { userId: 'u1', tenantId: 't1' }, 1, prebook)).toEqual(['ok']);
  });

  it('no opina sin cupo declarado ni sin usuario (AuthGuard ya decidió)', () => {
    const guard = new SellerRateLimitGuard(new Reflector());

    expect(intentos(guard, { userId: 'u1', tenantId: 't1' }, 10, contexto(null))).toEqual(
      Array(10).fill('ok'),
    );
    expect(intentos(guard, {}, 10)).toEqual(Array(10).fill('ok'));
  });

  it('barre las ventanas vencidas cuando se acumulan muchas', () => {
    const guard = new SellerRateLimitGuard(new Reflector());
    for (let i = 0; i < 5_000; i += 1) intentos(guard, { userId: `u${i}`, tenantId: 't1' }, 1);
    const windows = (guard as unknown as { windows: Map<string, unknown> }).windows;
    expect(windows.size).toBe(5_000);

    vi.advanceTimersByTime(60_000);
    intentos(guard, { userId: 'nuevo', tenantId: 't1' }, 1);

    expect(windows.size).toBe(1);
  });
});
