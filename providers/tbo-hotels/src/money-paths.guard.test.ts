import { describe, expect, it, vi } from 'vitest';
import { parseTboConfig } from './config';
import { TboApiError } from './errors';
import { TboInMemoryRateLimiter } from './http/limiter';
import { TBO_OPERATIONS, type TboOperationSpec } from './http/operations';
import type * as OperationsModule from './http/operations';
import { TboHttpClient, type TboFetch } from './http/tbo-http.client';

/**
 * `/Book` y `/Cancel` hacen UNA llamada aunque alguien edite la tabla (docs/tbo/01 §10.2; 08 RF-02
 * CA-1; 09 PR-1.2).
 *
 * Repetir un Book puede crear dos reservas cobradas al crédito de la agencia, y repetir un Cancel
 * sin conciliar no es seguro: TBO no documenta idempotencia (p. 33) y la recuperación obligatoria
 * es BookingDetail a +120 s (p. 42). La regla no puede depender de que la columna `money` o
 * `maxAttempts` sigan diciendo la verdad: aquí la tabla que ve el cliente está ADULTERADA —todas
 * las filas marcadas como lecturas con 5 intentos— y el cliente real tiene que seguir haciendo una
 * sola llamada. Cada fila adulterada deja en pie UNA sola de las defensas, para que quitar
 * cualquiera ponga rojo un caso:
 *
 * - `book` con el path cambiado a `/HotelBook` (la etiqueta del PDF, p. 32): sólo lo salva el
 *   nombre de la operación;
 * - `hotelDetails` con el path `/BOOK`: sólo lo salva el path;
 * - `cancel` con `/cancel` en minúsculas: nombre y path a la vez.
 *
 * El control es `bookingDetail`, adulterado igual: ése sí reintenta, y así el test demuestra que
 * distingue algo.
 */

vi.mock('./http/operations', async (importOriginal) => {
  const original = await importOriginal<typeof OperationsModule>();
  // También piden el vacío de "No Hotels Found" (01 §8.5): en Book o Cancel un 500 es incierto y
  // tiene que seguir siéndolo, nunca una lista vacía que el adapter lea como "no pasó nada".
  const tamper = (spec: TboOperationSpec, path = spec.path): TboOperationSpec => ({
    ...spec,
    path,
    money: false,
    maxAttempts: 5,
    sharedDeadline: false,
    lanes: ['background'],
    emptyOnNoHotelsFound: true,
  });
  return {
    ...original,
    TBO_OPERATIONS: {
      ...original.TBO_OPERATIONS,
      book: tamper(original.TBO_OPERATIONS.book, '/HotelBook'),
      cancel: tamper(original.TBO_OPERATIONS.cancel, '/cancel'),
      hotelDetails: tamper(original.TBO_OPERATIONS.hotelDetails, '/BOOK'),
      bookingDetail: tamper(original.TBO_OPERATIONS.bookingDetail),
    },
  };
});

function countingFetch(respond: () => Response | Promise<Response>): {
  fetch: TboFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url) => {
      calls.push(url);
      return Promise.resolve(respond());
    },
  };
}

function client(fetch: TboFetch): TboHttpClient {
  return new TboHttpClient(
    parseTboConfig({ environment: 'test', username: 'agencia-demo', password: 'x' }),
    {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      limiter: new TboInMemoryRateLimiter({
        maxQps: 1_000,
        maxConcurrent: 100,
        background: { qps: 1_000, concurrent: 100 },
      }),
    },
  );
}

const upstream = (): Response =>
  new Response(JSON.stringify({ Status: { Code: 500 } }), { status: 200 });
const refused = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));

const GUARDED = ['book', 'cancel', 'hotelDetails'] as const;

describe('la tabla adulterada llega al cliente (si no, el test sería vacuo)', () => {
  it('las filas guardadas figuran como lecturas con 5 intentos', () => {
    expect(TBO_OPERATIONS.book).toMatchObject({ money: false, maxAttempts: 5, path: '/HotelBook' });
    expect(TBO_OPERATIONS.cancel).toMatchObject({ money: false, maxAttempts: 5, path: '/cancel' });
    expect(TBO_OPERATIONS.hotelDetails).toMatchObject({
      money: false,
      maxAttempts: 5,
      path: '/BOOK',
    });
  });
});

describe('Book y Cancel salen una vez aunque la tabla diga otra cosa', () => {
  it.each(GUARDED)('%s con un 500 en el cuerpo: una llamada', async (op) => {
    const { fetch, calls } = countingFetch(upstream);
    const error = await client(fetch)
      .send(op, {}, { maxAttempts: 5 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).kind).toBe('UPSTREAM');
    expect(calls).toHaveLength(1);
  });

  it.each(GUARDED)('%s sin respuesta: una llamada', async (op) => {
    const { fetch, calls } = countingFetch(refused);
    const error = await client(fetch)
      .send(op, {})
      .catch((err: unknown) => err);
    expect((error as TboApiError).kind).toBe('TRANSPORT');
    // La naturaleza sigue siendo reintentable: la política de cancelaciones la necesita para pedir
    // conciliación en vez de cerrar como FAILED (01 §9.3).
    expect((error as TboApiError).retryable).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('el control: una lectura adulterada igual SÍ reintenta hasta 5', async () => {
    const { fetch, calls } = countingFetch(upstream);
    await client(fetch)
      .send('bookingDetail', {})
      .catch(() => undefined);
    expect(calls).toHaveLength(5);
  });
});

describe('Book y Cancel: un 500 "No Hotels Found" sigue siendo incierto aunque la fila pida el vacío', () => {
  const noHotelsFound = (): Response =>
    new Response(JSON.stringify({ Status: { Code: 500, Description: 'No Hotels Found' } }), {
      status: 200,
    });

  it.each(GUARDED)('%s: UPSTREAM en una llamada, nunca un resultado vacío', async (op) => {
    expect(TBO_OPERATIONS[op].emptyOnNoHotelsFound).toBe(true);
    const { fetch, calls } = countingFetch(noHotelsFound);
    const error = await client(fetch)
      .send(op, {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).kind).toBe('UPSTREAM');
    expect(calls).toHaveLength(1);
  });

  it('el control: en una lectura adulterada igual, la fila sí manda y es un vacío', async () => {
    const { fetch, calls } = countingFetch(noHotelsFound);
    const result = await client(fetch).send('bookingDetail', {});
    expect(result).toMatchObject({ outcome: 'NO_AVAILABILITY', tboCode: 500 });
    expect(calls).toHaveLength(1);
  });
});
