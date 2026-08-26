import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import * as errorsModule from './errors';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import * as packageIndex from './index';

/**
 * Por qué este fichero existe y por qué entra por `postJson` y no por `classifySabreEnvelope`.
 *
 * La regla dura vivía duplicada: la endurecida en `errors.ts` y una copia vieja y débil dentro del
 * cliente HTTP. Los 58 tests de `errors.test.ts` —incluidos los siete bypasses— llamaban a la
 * endurecida directamente, así que estaban verdes mientras producción ejecutaba la débil: 15 de 16
 * sobres hostiles se aceptaban como reserva confirmada. Verde no era protegido.
 *
 * De ahí la regla de este fichero: **todo entra por la puerta pública del paquete**. Un test que
 * llama a una función interna sólo demuestra que esa función es correcta, nunca que sea la que
 * corre. Si mañana alguien vuelve a colar un clasificador propio en el cliente, esto se pone rojo.
 */

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

/** Un 200 con el sobre pedido. Es exactamente lo que Sabre hace con sus fallos de negocio. */
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

function newClient(spy: FetchSpy, logger?: LoggerPort): SabreHttpClient {
  return new SabreHttpClient(config(), fakeTokens(), {
    fetch: spy.fetch,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
    ...(logger ? { logger } : {}),
  });
}

function spyLogger(): { logger: LoggerPort; calls: Array<{ message: string; meta?: unknown }> } {
  const calls: Array<{ message: string; meta?: unknown }> = [];
  const record = (message: string, meta?: Record<string, unknown>): void => {
    calls.push({ message, meta });
  };
  const logger: LoggerPort = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  };
  return { logger, calls };
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

/**
 * Los dieciséis sobres hostiles medidos extremo a extremo contra la copia vieja del clasificador:
 * quince se aceptaban como éxito. Los siete primeros son los bypasses originales de la auditoría;
 * el resto los añadió la re-auditoría. Cada uno es un HTTP 200 que **jamás** puede llegar al
 * adapter como reserva confirmada.
 */
const HOSTILE_ENVELOPES: ReadonlyArray<readonly [string, unknown]> = [
  [
    '1. errors[] a profundidad >= 4',
    {
      a: {
        b: { c: { d: { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] } } },
      },
    },
  ],
  [
    '2. errors[] dentro de un elemento de array',
    {
      orders: [
        { confirmationId: 'ABC123' },
        { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
      ],
    },
  ],
  [
    '3. ApplicationResults dentro de un array',
    {
      results: [{ ApplicationResults: { status: 'NotProcessed', Error: [{ type: 'Transport' }] } }],
    },
  ],
  ['4. errors: ["texto plano"]', { errors: ['Booking failed: no seats available'] }],
  ['4-bis. errors: [1] — escalar numerico', { errors: [1] }],
  ['4-ter. errors: [true] — escalar booleano', { errors: [true] }],
  [
    '5. errors como OBJETO (carriles derivados de XML/SOAP)',
    { errors: { category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' } },
  ],
  ['5-bis. soapFault', { soapFault: { faultstring: 'Backend unavailable' } }],
  ['5-ter. error como cadena suelta', { error: 'invalid_grant' }],
  [
    '6. messages[] sin severity ni type',
    { messages: [{ content: 'Booking could not be completed' }] },
  ],
  ['6-bis. messages[] con code ERR.* de hoteles', { messages: [{ code: 'ERR.0161' }] }],
  ['7. status NotProcessed en la raiz', { status: 'NotProcessed', data: {} }],
  // Los que anadio la re-auditoria.
  ['8. Fault de SOAP con faultcode', { Fault: { faultcode: 'soap:Server' } }],
  ['9. exception sin campos reconocibles', { exception: { message: 'NullPointerException' } }],
  [
    '10. clave con sufijo Error (applicationError, processingError, ...)',
    { bookingApplicationError: { type: 'UNABLE_TO_CREATE' } },
  ],
  [
    '11. Errors sepultado bajo dos arrays y cinco niveles',
    {
      trip: {
        orders: [
          {
            orderItems: [
              { fulfillment: { detail: { Errors: [{ category: 'APPLICATION_ERROR' }] } } },
            ],
          },
        ],
      },
    },
  ],
];

describe('puerta publica — un sobre hostil dentro de un 200 nunca se acepta', () => {
  it.each(HOSTILE_ENVELOPES)('%s lanza SabreApiError desde postJson', async (name, payload) => {
    const spy = fetchReturning(payload);
    const outcome = await settle(newClient(spy).postJson(CREATE_BOOKING_PATH, {}));

    // Resolver es la reserva fantasma: el cliente no vuela y ya se le cobro.
    expect(outcome.kind, `${name}: el sobre se acepto como exito`).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    // Y lanzar OTRA cosa (TypeError, RangeError por recursion...) tampoco es proteccion.
    expect(outcome.error, name).toBeInstanceOf(SabreApiError);
    expect((outcome.error as SabreApiError).status, name).toBe(200);
    // Una operacion con dinero no se reintenta ni cuando el sobre es hostil.
    expect(spy.calls, name).toBe(1);
  });

  /**
   * Los `issues` del error salen del clasificador, y de ahi van al log estructurado. Sólo pueden
   * llevar `category`/`type`/`code`/`fieldPath`: `description` y `fieldValue` son texto libre del
   * proveedor y arrastran PII del pasajero (RNF-07). La redacción del `body` crudo es harina de
   * otro costal (`redaction.ts`); aquí se comprueba lo que produce la regla dura.
   */
  it('los issues que el clasificador mete en el error no llevan texto libre', async () => {
    const spy = fetchReturning({
      errors: [
        {
          category: 'BAD_REQUEST',
          type: 'INVALID_VALUE',
          fieldPath: 'travelers[0].passport',
          description: 'Incorrect request data provided for Ana Perez',
          fieldValue: 'AB1234567',
        },
      ],
    });
    const outcome = await settle(newClient(spy).postJson(CREATE_BOOKING_PATH, {}));

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    const error = outcome.error as SabreApiError;
    const meta = JSON.stringify(error.toLogMeta());
    expect(meta).not.toContain('AB1234567');
    expect(meta).not.toContain('Ana Perez');
    // Y aun asi sirve para diagnosticar.
    expect(meta).toContain('INVALID_VALUE');
    expect(meta).toContain('travelers[0].passport');
  });
});

describe('puerta publica — el 200 legitimo sigue pasando', () => {
  /**
   * El falso positivo es el modo de fallo que mata la regla: si un sobre real y bueno empieza a
   * fallar, el equipo la desactiva y volvemos al agujero. La ronda anterior ya cazo uno —el
   * `type: "DEFAULT"` de BFM contiene la subcadena `"FAULT"`— y por eso los fixtures oficiales
   * entran aqui tambien por `postJson`, no solo por el clasificador.
   */
  it.each([
    ['adult', adultFixture],
    ['child-baggage', childFixture],
    ['family', familyFixture],
  ])('el fixture oficial de BFM v5 "%s" se entrega como exito', async (name, fixture) => {
    const spy = fetchReturning(fixture);
    const outcome = await settle(newClient(spy).postJson(SHOP_PATH, {}, { idempotent: true }));

    expect(outcome.kind, name).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    const result = outcome.value as { status: number; warnings: readonly unknown[] };
    expect(result.status, name).toBe(200);
    expect(result.warnings, name).toHaveLength(0);
  });

  it('el messages[] real de BFM v5, todo severity Info con type DEFAULT, es exito', async () => {
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
  });

  it('un warning de entitlement se entrega, pero marcado como degradacion', async () => {
    const spy = fetchReturning({
      warnings: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
      groupedItineraryResponse: { version: '5' },
    });
    const outcome = await settle(newClient(spy).postJson(SHOP_PATH, {}, { idempotent: true }));

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    const result = outcome.value as { partialUnauthorized: readonly unknown[] };
    expect(result.partialUnauthorized).toHaveLength(1);
  });
});

describe('un unico clasificador en todo el paquete', () => {
  /**
   * La sonda que habria cazado el duplicado: el simbolo publico y el de `errors.ts` tienen que ser
   * el MISMO objeto funcion. Cuando existian dos, `index` re-exportaba la debil porque el export
   * explicito del cliente HTTP ganaba al `export *` de `./errors`.
   */
  it('index.classifySabreEnvelope es exactamente el de errors.ts', () => {
    expect(packageIndex.classifySabreEnvelope).toBe(errorsModule.classifySabreEnvelope);
  });

  it('el clasificador publico ya trae la carga de la prueba invertida', () => {
    const verdict = packageIndex.classifySabreEnvelope({ errors: ['x'] });
    expect(verdict.ok).toBe(false);
    // `exhaustive` solo existe en la version endurecida: si falta, volvio la copia vieja.
    expect(verdict.exhaustive).toBe(true);
  });

  it('el cliente HTTP no reexporta un clasificador propio', async () => {
    const clientModule = (await import('./http/sabre-http.client')) as Record<string, unknown>;
    expect(clientModule['classifySabreEnvelope']).toBeUndefined();
  });

  /**
   * La huella del clasificador endurecido en el log de produccion. `nodesVisited` no existe en la
   * copia vieja, asi que si esto vuelve a ser `undefined` es que alguien recableo el cliente a otra
   * regla. Ademas es el unico dato con el que recalibrar `SABRE_ENVELOPE_NODE_BUDGET`.
   */
  it('el log de exito de postJson reporta cuantos nodos se recorrieron', async () => {
    const { logger, calls } = spyLogger();
    const spy = fetchReturning(adultFixture);
    await settle(newClient(spy, logger).postJson(SHOP_PATH, {}, { idempotent: true }));

    const ok = calls.find((call) => call.message === 'sabre.http.ok');
    expect(ok).toBeDefined();
    expect((ok?.meta as { envelopeNodes?: number } | undefined)?.envelopeNodes).toBeGreaterThan(0);
  });
});
