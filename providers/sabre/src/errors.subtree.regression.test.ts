/**
 * Regresiones de la RONDA 3 sobre la regla dura de éxito (`classifySabreEnvelope`).
 *
 * Las tres rondas anteriores endurecieron la regla y la suite quedó verde; la lección que se
 * repite es que **verde no significa protegido**. Lo que quedaba abierto no era una forma nueva
 * de sobre hostil, sino **subárboles que el recorrido no pisaba** y una **severidad que se
 * degradaba** por el camino:
 *
 * - **ALTO** — `scanNode` entraba en `message`/`messages` con `scanMessageValue`, que decidía la
 *   severidad del registro y hacía `continue` **sin descender**. Cualquier error anidado bajo un
 *   item de `messages[]` cuya severidad resolviera a benigna era INVISIBLE:
 *   `{messages:[{severity:'Info',errors:[{category:'APPLICATION_ERROR'}]}]}` se entregaba como
 *   reserva confirmada.
 * - **MEDIO** — la severidad del CONTENEDOR ganaba a la que declaraba el propio item, y eso es
 *   fail-OPEN: un `Error` (o un `Fatal`) metido dentro de `warnings[]` se degradaba a warning y
 *   el sobre pasaba. Un proveedor que mete un Error dentro de `warnings[]` está diciendo que
 *   hubo un error.
 * - **BAJO** — `{}` y `[]` se aceptaban como éxito.
 *
 * Como en `envelope-bypass.e2e.test.ts`, **todo entra por la puerta pública**: `postJson`, no
 * `classifySabreEnvelope`. Un test que llama a la función interna sólo demuestra que esa función
 * es correcta, jamás que sea la que corre en producción — que es exactamente cómo la ronda 2 tuvo
 * 347 tests verdes sobre un clasificador que nadie invocaba.
 */

import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import {
  SabreApiError,
  classifySabreEnvelope,
  sabreEnvelopeRecord,
  sabreEnvelopeString,
} from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';
const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

function fakeTokens(): SabreTokenProvider {
  return {
    getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
    invalidate: () => Promise.resolve(),
  };
}

interface FetchSpy {
  fetch: SabreFetch;
  calls: number;
}

/** Un 200 con el sobre pedido: exactamente lo que Sabre hace con sus fallos de negocio. */
function fetchReturning(payload: unknown): FetchSpy {
  const spy = {
    calls: 0,
    fetch: ((_url: string, _init: RequestInit) => {
      spy.calls += 1;
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }) as SabreFetch,
  };
  return spy;
}

function newClient(spy: FetchSpy): SabreHttpClient {
  return new SabreHttpClient(config(), fakeTokens(), {
    fetch: spy.fetch,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
}

type Settled = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: unknown };

/**
 * El arnés no puede ser tautológico: `rejects.toBeInstanceOf` pasaría igual si el cliente
 * reventara con un `TypeError`. Aquí se distingue resolver de lanzar, y lanzar-otra-cosa es fallo.
 */
async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return { kind: 'resolved', value: await promise };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

async function post(payload: unknown, path = CREATE_BOOKING_PATH): Promise<Settled> {
  const spy = fetchReturning(payload);
  return settle(newClient(spy).postJson(path, {}));
}

/**
 * Los sobres que la ronda 3 midió aceptados como éxito extremo a extremo. Cada uno es un HTTP 200
 * que jamás puede llegar al adapter como reserva confirmada: el cliente no vuela y ya se le cobró.
 */
const RONDA_3_ENVELOPES: ReadonlyArray<readonly [string, unknown]> = [
  [
    'A1. error bajo un messages[] con severity benigna (el subárbol que no se recorría)',
    { messages: [{ severity: 'Info', errors: [{ category: 'APPLICATION_ERROR' }] }] },
  ],
  [
    'A2. el mismo error a profundidad 3 por debajo del item de messages[]',
    {
      messages: [
        {
          severity: 'Info',
          detail: {
            orders: [
              {
                fulfillment: {
                  errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }],
                },
              },
            ],
          },
        },
      ],
    },
  ],
  [
    'A3. status NotProcessed enterrado bajo un messages[] benigno',
    { messages: [{ severity: 'Info', ApplicationResults: { status: 'NotProcessed' } }] },
  ],
  [
    'A4. Message (singular) benigno de hoteles con un Error dentro',
    { Message: { code: 'WARN.0788', Error: [{ type: 'Validation' }] } },
  ],
  [
    // Pin del CONTEXTO con el que se desciende, no sólo de que se descienda: si el descenso
    // heredara `benign` de un `severity: 'Info'`, este mensaje interior —que no declara nada—
    // se daría por inocuo y el sobre pasaría. `benign` sólo lo otorga el contrato (`Success[]`).
    'A5. messages[] anidado y sin severidad, bajo un messages[] con severity Info',
    { messages: [{ severity: 'Info', detail: { messages: [{ content: 'Booking failed' }] } }] },
  ],
  [
    'M1. category de error declarada dentro de WARNINGS con severity Error',
    { WARNINGS: [{ category: 'APPLICATION_ERROR', severity: 'Error' }] },
  ],
  [
    'M2. severity Fatal suelto dentro de warnings[], sin identificador estructurado',
    { warnings: [{ severity: 'Fatal' }] },
  ],
  [
    'M3. type ERROR (dialecto NDC) dentro de warnings[]',
    { warnings: [{ type: 'ERROR', code: 'X99' }] },
  ],
  [
    'M4. code con prefijo ERR de hoteles dentro de un contenedor de warnings',
    { warningDetails: [{ code: 'ERR.0161' }] },
  ],
  ['B1. sobre objeto vacío', {}],
  ['B2. sobre array vacío', []],
];

describe('puerta pública — los subárboles que el recorrido no pisaba', () => {
  it.each(RONDA_3_ENVELOPES)('%s lanza SabreApiError desde postJson', async (name, payload) => {
    const outcome = await post(payload);

    expect(outcome.kind, `${name}: el sobre se aceptó como éxito`).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    // Lanzar OTRA cosa (TypeError, RangeError por recursión…) tampoco es protección.
    expect(outcome.error, name).toBeInstanceOf(SabreApiError);
    expect((outcome.error as SabreApiError).status, name).toBe(200);
  });

  it('el error escondido bajo messages[] llega al log con su categoría, no como opaco', async () => {
    const outcome = await post({
      messages: [
        { severity: 'Info', errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
      ],
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    const meta = JSON.stringify((outcome.error as SabreApiError).toLogMeta());
    expect(meta).toContain('APPLICATION_ERROR');
    expect(meta).toContain('UNABLE_TO_CREATE');
  });

  it('una operación con dinero no se reintenta ni cuando el sobre esconde el error', async () => {
    const spy = fetchReturning({
      messages: [{ severity: 'Info', errors: [{ category: 'APPLICATION_ERROR' }] }],
    });
    await settle(newClient(spy).postJson(CREATE_BOOKING_PATH, {}));
    expect(spy.calls).toBe(1);
  });
});

/**
 * La severidad declarada por el item manda sobre la heredada del contenedor y, en conflicto, gana
 * la más grave. Estas dos direcciones se comprueban por separado porque sólo una es fail-open:
 * degradar un error a warning entrega una reserva fantasma; escalar un warning a error cuesta un
 * reintento.
 */
describe('la severidad del item gana a la del contenedor, y en conflicto gana la más grave', () => {
  it('un Error dentro de warnings[] es un fallo, no un warning', () => {
    const verdict = classifySabreEnvelope({
      warnings: [{ category: 'APPLICATION_ERROR', severity: 'Error' }],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]?.category).toBe('APPLICATION_ERROR');
    expect(verdict.warnings).toHaveLength(0);
  });

  it('un Warning dentro de errors[] sigue siendo fallo: gana la severidad más grave', () => {
    const verdict = classifySabreEnvelope({
      errors: [{ category: 'APPLICATION_ERROR', severity: 'Warning' }],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
  });

  it('un Info dentro de errors[] tampoco rebaja nada: el contenedor ya declaró el problema', () => {
    const verdict = classifySabreEnvelope({
      errors: [{ category: 'APPLICATION_ERROR', severity: 'Info' }],
    });

    expect(verdict.ok).toBe(false);
  });

  /**
   * La severidad escalada tiene que VIAJAR al subárbol, no quedarse en el item. Si el descenso
   * siguiera usando la del contenedor, este mensaje interior saldría catalogado como warning y el
   * operador leería «degradación» donde hubo un fallo.
   */
  it('la severidad escalada se hereda hacia abajo: el subárbol de un Error no produce warnings', () => {
    const verdict = classifySabreEnvelope({
      warnings: [{ severity: 'Error', detail: { messages: [{ content: 'Booking failed' }] } }],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.warnings).toHaveLength(0);
    expect(verdict.failures.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * El falso positivo es el modo de fallo que MATA la regla: si un sobre real y bueno empieza a
 * fallar, el equipo la desactiva en una semana y volvemos al agujero. Estos son los guardarraíles.
 */
describe('puerta pública — el 200 legítimo sigue pasando, sin un solo warning nuevo', () => {
  it.each([
    ['adult', adultFixture],
    ['child-baggage', childFixture],
    ['family', familyFixture],
  ])(
    'el fixture oficial de BFM v5 "%s" se entrega como éxito y sin warnings',
    async (name, fixture) => {
      const spy = fetchReturning(fixture);
      const outcome = await settle(newClient(spy).postJson(SHOP_PATH, {}, { idempotent: true }));

      expect(outcome.kind, name).toBe('resolved');
      if (outcome.kind !== 'resolved') return;
      const result = outcome.value as { status: number; warnings: readonly unknown[] };
      expect(result.status, name).toBe(200);
      expect(result.warnings, name).toHaveLength(0);
    },
  );

  it('el `type: "DEFAULT"` de BFM contiene "FAULT" y sigue sin disparar nada', async () => {
    const spy = fetchReturning({
      groupedItineraryResponse: {
        version: '5',
        messages: [
          { severity: 'Info', type: 'DEFAULT', code: 'RULEID', text: '31139' },
          {
            severity: 'Info',
            type: 'WORKERTHREAD',
            code: 'TRANSACTIONID',
            text: '7346539295149655838',
          },
        ],
        statistics: { itineraryCount: 1 },
      },
    });
    const outcome = await settle(newClient(spy).postJson(SHOP_PATH, {}, { idempotent: true }));

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as { warnings: readonly unknown[] }).warnings).toHaveLength(0);
  });

  it('un warning de entitlement se sigue entregando como degradación, no como fallo', async () => {
    const spy = fetchReturning({
      warnings: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
      groupedItineraryResponse: { version: '5' },
    });
    const outcome = await settle(newClient(spy).postJson(SHOP_PATH, {}, { idempotent: true }));

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(
      (outcome.value as { partialUnauthorized: readonly unknown[] }).partialUnauthorized,
    ).toHaveLength(1);
  });

  /**
   * El warning REST de hoteles anida `Message[]` cuatro niveles por debajo de `Warning[]`. Ahora
   * que se desciende por los mensajes, este sobre pasa por el camino nuevo entero: si el descenso
   * escalara de más, aquí se pondría rojo.
   */
  it('el warning REST oficial de hoteles sigue degradando y NO tumba la búsqueda', async () => {
    const spy = fetchReturning({
      GetHotelAvailRS: {
        ApplicationResults: {
          status: 'Complete',
          Success: [{ timeStamp: '2024-05-30T00:17:56.715-05:00' }],
          Warning: [
            {
              type: 'Validation',
              SystemSpecificResults: [
                {
                  Message: [
                    { code: 'WARN.0788', value: 'Invalid format for search by distance' },
                    { code: 'WarningDetails', value: 'Cannot sort by distance' },
                  ],
                },
              ],
            },
          ],
        },
        HotelAvailInfos: { OffSet: 1 },
      },
    });
    const outcome = await settle(newClient(spy).postJson(SHOP_PATH, {}, { idempotent: true }));

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(
      (outcome.value as { warnings: readonly unknown[] }).warnings.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('los Message dentro de Success[] siguen sin ser problemas, ni al descender', () => {
    const verdict = classifySabreEnvelope({
      ApplicationResults: {
        status: 'Complete',
        Success: [
          { SystemSpecificResults: [{ Message: [{ value: 'ok', detail: { note: 'x' } }] }] },
        ],
      },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(0);
  });

  it('un sobre con contenido real pero sin problemas sigue siendo éxito', () => {
    expect(classifySabreEnvelope({ groupedItineraryResponse: { version: '5' } }).ok).toBe(true);
    expect(classifySabreEnvelope({ errors: [] }).ok).toBe(true);
    expect(classifySabreEnvelope({ messages: [] }).ok).toBe(true);
  });
});

/**
 * HALLAZGO BAJO — duplicados estructurales entre `errors.ts` y `http/sabre-http.client.ts`.
 *
 * `asRecord` (cliente) es copia byte a byte de `sabreEnvelopeRecord`, y `str` (cliente) es copia
 * DERIVADA de `sabreEnvelopeString`: a la del cliente le falta el `Number.isFinite`, así que
 * acepta `NaN`/`Infinity` como texto. Hoy la deriva es inobservable por la puerta pública —el
 * único llamador es `transportError`, que trabaja sobre un `JSON.parse`, y JSON no puede
 * transportar `NaN` ni `Infinity`—, pero es exactamente el patrón que causó el incidente de la
 * ronda 2: dos copias, la vieja en producción, la suite midiendo la buena.
 *
 * Aquí se fija el contrato de las versiones canónicas para que el cliente pueda importarlas sin
 * cambiar comportamiento. **Pendiente en `http/sabre-http.client.ts` (fichero de otro carril):**
 * borrar `asRecord`/`str` e importar estas dos.
 */
describe('helpers canónicos del sobre — un solo sitio donde arreglarlos', () => {
  it('sabreEnvelopeRecord acepta el objeto plano y rechaza array, escalar y null', () => {
    expect(sabreEnvelopeRecord({ a: 1 })).toEqual({ a: 1 });
    expect(sabreEnvelopeRecord([{ a: 1 }])).toBeNull();
    expect(sabreEnvelopeRecord('x')).toBeNull();
    expect(sabreEnvelopeRecord(null)).toBeNull();
    expect(sabreEnvelopeRecord(undefined)).toBeNull();
  });

  it('sabreEnvelopeString normaliza texto y número finito, y descarta el resto', () => {
    expect(sabreEnvelopeString('ERR.0161')).toBe('ERR.0161');
    expect(sabreEnvelopeString(404)).toBe('404');
    expect(sabreEnvelopeString(0)).toBe('0');
    expect(sabreEnvelopeString('')).toBeUndefined();
    expect(sabreEnvelopeString(true)).toBeUndefined();
    expect(sabreEnvelopeString(null)).toBeUndefined();
    // La rama donde la copia del cliente diverge: `NaN`/`Infinity` NO son contenido.
    expect(sabreEnvelopeString(Number.NaN)).toBeUndefined();
    expect(sabreEnvelopeString(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  /**
   * Sonda de comportamiento que sostiene la afirmación «la deriva es inobservable»: ningún cuerpo
   * que Sabre pueda mandar llega a esa rama, porque `JSON.parse` no produce `NaN` ni `Infinity`.
   * Si esto dejara de ser cierto, unificar dejaría de ser un no-op y habría que medirlo.
   */
  it('un cuerpo JSON no puede transportar NaN ni Infinity hasta esa rama', () => {
    const parse = (raw: string): unknown => JSON.parse(raw) as unknown;

    expect(() => parse('{"errorCode":NaN}')).toThrow();
    expect(() => parse('{"errorCode":Infinity}')).toThrow();
    // Y por el otro lado: serializar un NaN lo convierte en `null`, que tampoco llega a la rama.
    expect(parse(JSON.stringify({ errorCode: Number.NaN }))).toEqual({ errorCode: null });
  });
});
