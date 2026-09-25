import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TBO_LIMITER_DEFAULTS,
  TboInMemoryRateLimiter,
  type TboLimiterGrant,
  type TboLimiterOptions,
  type TboLimiterPermit,
} from './limiter';
import type { TboLane } from './operations';

/**
 * 08 RNF-02, "Verificable": N+5 búsquedas concurrentes con cupo N nunca tienen más de N en vuelo, y
 * un Book no espera detrás de búsquedas saturadas. El reloj es el de vitest: el limitador lee
 * `Date.now()` y programa sus despertares con `setTimeout`.
 */

const ACCOUNT = 'acc-0001';

interface Tracked {
  readonly promise: Promise<TboLimiterGrant>;
  grant: TboLimiterGrant | undefined;
}

function track(promise: Promise<TboLimiterGrant>): Tracked {
  const tracked: Tracked = { promise, grant: undefined };
  void promise.then((grant) => {
    tracked.grant = grant;
  });
  return tracked;
}

function permitOf(tracked: Tracked): TboLimiterPermit {
  if (tracked.grant?.granted !== true) throw new Error('el cupo no se concedió');
  return tracked.grant.permit;
}

function limiter(options: Partial<TboLimiterOptions> = {}): TboInMemoryRateLimiter {
  return new TboInMemoryRateLimiter(options);
}

function acquire(
  subject: TboInMemoryRateLimiter,
  lane: TboLane,
  maxWaitMs = 60_000,
  account = ACCOUNT,
  signal?: AbortSignal,
): Tracked {
  return track(
    subject.acquire({
      accountRef: account,
      lane,
      maxWaitMs,
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

/** Deja correr las promesas pendientes sin mover el reloj. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('valores por defecto (D-TBO-17 A)', () => {
  it('5 QPS, 4 en vuelo, reserva de 1 para dinero, fondo de 1, mitad durante 60 s tras un 429', () => {
    expect(TBO_LIMITER_DEFAULTS).toEqual({
      maxQps: 5,
      maxConcurrent: 4,
      moneyReserve: { qps: 1, concurrent: 1 },
      background: { qps: 1, concurrent: 1 },
      throttleFactor: 0.5,
      throttleMs: 60_000,
    });
  });
});

describe('concurrencia', () => {
  it('N+5 búsquedas con cupo N nunca tienen más de N en vuelo', async () => {
    // Cupo de ventas = 4 en vuelo − 1 reservado para dinero = 3. QPS alto para aislar la concurrencia.
    const subject = limiter({ maxQps: 1_000 });
    const salesCap = 3;
    const all = Array.from({ length: salesCap + 5 }, () => acquire(subject, 'sales'));
    await flush();

    let maxInFlight = 0;
    let done = 0;
    while (done < all.length) {
      maxInFlight = Math.max(maxInFlight, subject.inFlight(ACCOUNT));
      const granted = all.filter((item) => item.grant?.granted === true);
      expect(granted.length - done).toBeLessThanOrEqual(salesCap);
      const next = granted[done];
      if (next === undefined) throw new Error('nadie avanzó: el limitador se trabó');
      permitOf(next).release();
      done++;
      await flush();
    }
    expect(maxInFlight).toBe(salesCap);
    expect(subject.inFlight(ACCOUNT)).toBe(0);
  });

  it('un Book no espera detrás de búsquedas saturadas', async () => {
    const subject = limiter({ maxQps: 1_000 });
    const searches = Array.from({ length: 8 }, () => acquire(subject, 'sales'));
    await flush();
    expect(searches.filter((item) => item.grant?.granted === true)).toHaveLength(3);

    const book = acquire(subject, 'money');
    await flush();
    expect(book.grant?.granted).toBe(true);
    expect(subject.inFlight(ACCOUNT)).toBe(4);
  });

  it('el dinero también tiene techo: con la cuenta llena, espera como cualquiera', async () => {
    const subject = limiter({ maxQps: 1_000 });
    const four = Array.from({ length: 4 }, () => acquire(subject, 'money'));
    const fifth = acquire(subject, 'money');
    await flush();
    expect(four.every((item) => item.grant?.granted === true)).toBe(true);
    expect(fifth.grant).toBeUndefined();
    permitOf(four[0] as Tracked).release();
    await flush();
    expect(fifth.grant?.granted).toBe(true);
  });

  it('al liberar, el dinero que espera pasa antes que las búsquedas que esperaban desde antes', async () => {
    const subject = limiter({ maxQps: 1_000 });
    const holders = Array.from({ length: 4 }, () => acquire(subject, 'money'));
    const search = acquire(subject, 'sales');
    const book = acquire(subject, 'money');
    await flush();
    permitOf(holders[0] as Tracked).release();
    await flush();
    expect(book.grant?.granted).toBe(true);
    expect(search.grant).toBeUndefined();
  });

  it('el fondo tiene su propio techo y no le quita cupo al vendedor', async () => {
    // QPS del fondo holgado para aislar su techo de concurrencia, que es lo que se mide aquí.
    const subject = limiter({ maxQps: 1_000, background: { qps: 1_000, concurrent: 1 } });
    const first = acquire(subject, 'background');
    const second = acquire(subject, 'background');
    const sales = [acquire(subject, 'sales'), acquire(subject, 'sales')];
    await flush();
    expect(first.grant?.granted).toBe(true);
    expect(second.grant).toBeUndefined();
    expect(sales.every((item) => item.grant?.granted === true)).toBe(true);
    permitOf(first).release();
    await flush();
    expect(second.grant?.granted).toBe(true);
  });

  it('dentro de un cupo se respeta el orden de llegada', async () => {
    const subject = limiter({ maxQps: 1_000 });
    const holders = Array.from({ length: 3 }, () => acquire(subject, 'sales'));
    const a = acquire(subject, 'sales');
    const b = acquire(subject, 'sales');
    await flush();
    permitOf(holders[0] as Tracked).release();
    await flush();
    expect(a.grant?.granted).toBe(true);
    expect(b.grant).toBeUndefined();
  });

  it('las cuentas no comparten cupo', async () => {
    const subject = limiter({ maxQps: 1_000 });
    Array.from({ length: 6 }, () => acquire(subject, 'sales', 60_000, 'acc-A'));
    const other = acquire(subject, 'sales', 60_000, 'acc-B');
    await flush();
    expect(other.grant?.granted).toBe(true);
  });

  it('liberar dos veces no regala cupo', async () => {
    const subject = limiter({ maxQps: 1_000 });
    const one = acquire(subject, 'sales');
    await flush();
    const permit = permitOf(one);
    permit.release();
    permit.release();
    expect(subject.inFlight(ACCOUNT)).toBe(0);
  });
});

describe('QPS', () => {
  it('el fondo despacha 1 por segundo aunque tenga concurrencia libre', async () => {
    const subject = limiter({ maxConcurrent: 100 });
    const first = acquire(subject, 'background');
    await flush();
    permitOf(first).release();
    const second = acquire(subject, 'background');
    await flush();
    expect(second.grant).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(second.grant?.granted).toBe(true);
  });

  it('ventas despacha 4 por segundo (5 − 1 de reserva) y el resto espera a que corra la ventana', async () => {
    const subject = limiter({ maxConcurrent: 100 });
    const all = Array.from({ length: 6 }, () => acquire(subject, 'sales'));
    await flush();
    for (const item of all) if (item.grant?.granted === true) item.grant.permit.release();
    expect(all.filter((item) => item.grant?.granted === true)).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(999);
    expect(all.filter((item) => item.grant?.granted === true)).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(2);
    expect(all.filter((item) => item.grant?.granted === true)).toHaveLength(6);
  });

  it('el dinero usa el quinto aunque ventas haya agotado lo suyo', async () => {
    const subject = limiter({ maxConcurrent: 100 });
    Array.from({ length: 4 }, () => acquire(subject, 'sales'));
    const book = acquire(subject, 'money');
    await flush();
    expect(book.grant?.granted).toBe(true);
  });

  it('tras un 429 el ritmo baja a la mitad durante 60 s', async () => {
    const subject = limiter({ maxConcurrent: 100 });
    subject.reportThrottled(ACCOUNT);
    // 5 × 0,5 = 2 para la cuenta; ventas, 2 − 1 de reserva = 1.
    const throttled = Array.from({ length: 3 }, () => acquire(subject, 'sales'));
    await flush();
    expect(throttled.filter((item) => item.grant?.granted === true)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const later = Array.from({ length: 5 }, () => acquire(subject, 'sales'));
    await flush();
    const grantedLater = later.filter((item) => item.grant?.granted === true).length;
    // Pasado el castigo vuelve a 4 por ventana (las 3 de antes ya se despacharon en ventanas viejas).
    expect(grantedLater).toBe(4);
  });
});

describe('rechazos', () => {
  it('sin cupo dentro del plazo, QUEUE_TIMEOUT', async () => {
    const subject = limiter({ maxQps: 1_000 });
    Array.from({ length: 3 }, () => acquire(subject, 'sales'));
    const late = acquire(subject, 'sales', 500);
    await vi.advanceTimersByTimeAsync(499);
    expect(late.grant).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(late.grant).toEqual({ granted: false, reason: 'QUEUE_TIMEOUT' });
  });

  it('quien se va por timeout no tapa al que venía detrás', async () => {
    const subject = limiter({ maxQps: 1_000 });
    const holders = Array.from({ length: 3 }, () => acquire(subject, 'sales'));
    const impatient = acquire(subject, 'sales', 100);
    const patient = acquire(subject, 'sales', 60_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(impatient.grant).toEqual({ granted: false, reason: 'QUEUE_TIMEOUT' });
    permitOf(holders[0] as Tracked).release();
    await flush();
    expect(patient.grant?.granted).toBe(true);
  });

  it('el llamador aborta mientras espera: ABORTED', async () => {
    const subject = limiter({ maxQps: 1_000 });
    Array.from({ length: 3 }, () => acquire(subject, 'sales'));
    const controller = new AbortController();
    const waiting = acquire(subject, 'sales', 60_000, ACCOUNT, controller.signal);
    await flush();
    controller.abort();
    await flush();
    expect(waiting.grant).toEqual({ granted: false, reason: 'ABORTED' });
  });

  it('una señal ya abortada no llega a la cola', async () => {
    const subject = limiter();
    const waiting = acquire(subject, 'sales', 60_000, ACCOUNT, AbortSignal.abort());
    await flush();
    expect(waiting.grant).toEqual({ granted: false, reason: 'ABORTED' });
    expect(subject.inFlight(ACCOUNT)).toBe(0);
  });

  it('una espera infinita no se convierte en un timer de 1 ms', async () => {
    const subject = limiter({ maxQps: 1_000 });
    Array.from({ length: 3 }, () => acquire(subject, 'sales'));
    const waiting = acquire(subject, 'sales', Number.POSITIVE_INFINITY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(waiting.grant).toBeUndefined();
  });
});
