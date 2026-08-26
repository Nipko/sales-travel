/**
 * Regresiones de la RONDA 5 sobre la regla dura de éxito.
 *
 * `case 'status'` llamaba a `scanStatusValue(value, scan)` y hacía `break`. Y `scanStatusValue`
 * sólo sabía leer escalares: con un objeto o un array hacía `sabreEnvelopeString(value) ===
 * undefined` y RETORNABA EN EL ACTO. Todo lo que colgara de una clave que normalizara a `STATUS`
 * —o que terminara en `PROCESSINGSTATUS`— era invisible para el recorrido.
 *
 * No es un caso sintético: `get-vehicle-availability-v1.yml:285` declara `Status` como
 * `type: object`. Un proveedor que devuelva sus fallos ahí dentro cobraba la reserva y el sobre
 * salía como CONFIRMADO.
 *
 * Es el mismo fallo de las rondas 3 y 4 con otro disfraz, y por eso el arreglo de esta ronda no
 * es «que `status` también baje»: es que **descender dejó de ser una decisión de cada rama**. La
 * guarda que impide que vuelva vive en `errors.traversal.guard.test.ts` y en
 * `errors.envelope.fuzz.test.ts`; este fichero fija los sobres concretos que se midieron
 * aceptados.
 *
 * Como en el resto de la familia, **todo entra por la puerta pública**: `postJson`, nunca
 * `classifySabreEnvelope`. Un test que llama a la función interna sólo demuestra que esa función
 * es correcta, jamás que sea la que corre en producción.
 *
 * ## RONDA 7 — la ruta de la operación entró en la ecuación
 *
 * `postJson` pasa ahora el contexto de la operación al clasificador, y una de las seis semánticas
 * depende de él: `ApplicationResults.Success` sólo concede benignidad en las ocho lecturas cuyo
 * contrato declara esa forma. Para los doce sobres de abajo eso no cambia nada —ninguno depende de
 * la concesión— y precisamente por eso se ejercitan ahora también sobre la lectura de hoteles: si
 * la ruta sólo APRIETA, los doce tienen que rechazarse en las dos. Un eje que aflojara en alguna
 * ruta reabriría la ronda 5 entera por la puerta de al lado.
 *
 * Y los guardarraíles de falso positivo que traen `ApplicationResults` pasan a correr sobre
 * `HOTEL_AVAIL_PATH`, que es de donde salen esos sobres: medirlos sobre la búsqueda de vuelos los
 * dejaba verdes por un motivo que no es el suyo.
 */

import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import type { SabreResult } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';
const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';
/** La lectura cuyo contrato declara `ApplicationResults`, o sea la que puede conceder benignidad. */
const HOTEL_AVAIL_PATH = '/v5/get/hotelavail';

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

/** El error, o `undefined` si el sobre se aceptó — que en un `expect` de instancia es un fallo. */
function errorOf(outcome: Settled): unknown {
  return outcome.kind === 'rejected' ? outcome.error : undefined;
}

type OkResult = SabreResult<unknown>;

/**
 * Los DOCE sobres que la ronda 5 midió aceptados como RESERVA CONFIRMADA extremo a extremo. Todos
 * comparten la misma forma: el fallo cuelga de una clave que el clasificador trataba como hoja.
 */
const RONDA_5_STATUS_ENVELOPES: ReadonlyArray<readonly [string, unknown]> = [
  [
    'S1. el caso del informe: errors[] dentro de un `status` objeto',
    { status: { errors: [{ category: 'APPLICATION_ERROR' }] } },
  ],
  [
    'S2. el mismo, con el objeto dentro de un array',
    { status: [{ errors: [{ category: 'APPLICATION_ERROR' }] }] },
  ],
  [
    'S3. la forma del contrato de coches: `Status` objeto con `Error[]` dentro',
    { Status: { Error: [{ type: 'Validation' }] } },
  ],
  [
    'S4. ProcessingStatus objeto (la otra clave que la regla trata como estado)',
    { ProcessingStatus: { errors: [{ category: 'APPLICATION_ERROR' }] } },
  ],
  [
    'S5. processingStatus con un ApplicationResults.status NotProcessed debajo',
    { processingStatus: { ApplicationResults: { status: 'NotProcessed' } } },
  ],
  [
    'S6. cualquier clave terminada en ProcessingStatus, con un Fatal dentro de warnings[]',
    { OrderProcessingStatus: { warnings: [{ severity: 'Fatal' }] } },
  ],
  [
    'S7. el error a cuatro niveles por debajo del `status` objeto',
    {
      status: {
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
    },
  ],
  [
    'S8. messages[] sin severidad declarada, escondido bajo un `status` objeto',
    { data: { status: { messages: [{ content: 'Booking failed' }] } } },
  ],
  [
    'S9. el literal NotProcessed un nivel por debajo del `status` objeto',
    { status: { status: 'NotProcessed' } },
  ],
  [
    'S10. `status` objeto dentro de un ApplicationResults con Success[] al lado',
    {
      ApplicationResults: {
        Success: [{ timeStamp: '2024-05-30T00:17:56.715-05:00' }],
        status: { errors: [{ category: 'APPLICATION_ERROR' }] },
      },
    },
  ],
  [
    'S11. array de arrays colgando de `status`',
    { status: [[{ errors: [{ category: 'APPLICATION_ERROR' }] }]] },
  ],
  [
    'S12. el code ERR.* de hoteles enterrado bajo un `Status` objeto',
    { Status: { SystemSpecificResults: [{ Message: [{ code: 'ERR.0161' }] }] } },
  ],
];

describe('puerta pública — el subárbol ciego de `status`', () => {
  it.each(RONDA_5_STATUS_ENVELOPES)(
    '%s lanza SabreApiError desde postJson',
    async (name, payload) => {
      const outcome = await post(payload);

      expect(outcome.kind, `${name}: el sobre se aceptó como éxito`).toBe('rejected');
      if (outcome.kind !== 'rejected') return;
      // Lanzar OTRA cosa (TypeError, RangeError por recursión…) tampoco es protección.
      expect(errorOf(outcome), name).toBeInstanceOf(SabreApiError);
      expect((outcome.error as SabreApiError).status, name).toBe(200);
    },
  );

  /**
   * Los mismos doce sobre la lectura de hoteles, que es la ruta MÁS permisiva que existe: la única
   * clase de operación donde `ApplicationResults.Success` puede apagar el recorrido de un subárbol.
   * Si el eje de la ronda 7 sólo aprieta, aquí no cambia ni un veredicto. S10 es el que de verdad
   * lo mide —lleva un `Success[]` al lado del `status` envenenado— y los otros once son el suelo
   * que impide que este bloque se vuelva una copia decorativa del de arriba.
   */
  it.each(RONDA_5_STATUS_ENVELOPES)(
    '%s tampoco pasa en la lectura que sí concede benignidad',
    async (name, payload) => {
      const outcome = await post(payload, HOTEL_AVAIL_PATH);

      expect(outcome.kind, `${name}: la ruta permisiva lo dejó pasar`).toBe('rejected');
      expect(errorOf(outcome), name).toBeInstanceOf(SabreApiError);
    },
  );

  it('el error escondido bajo `status` llega al log con su categoría, no como opaco', async () => {
    const outcome = await post({
      status: { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    const meta = JSON.stringify((outcome.error as SabreApiError).toLogMeta());
    expect(meta).toContain('APPLICATION_ERROR');
    expect(meta).toContain('UNABLE_TO_CREATE');
  });

  /**
   * Estos dos salieron de MUTAR la propia defensa, no del informe.
   *
   * El anotador de `status` no puede limitarse a «no digo nada» cuando el valor es un objeto:
   * tiene que devolver el contexto HEREDADO. Si devolviera `benign`, las dos claves que el
   * contrato declara portadoras del contexto benigno (`Message`, `SystemSpecificResults`) lo
   * transportarían hacia abajo y un mensaje sin severidad declarada —que es error por defecto—
   * quedaría silenciado. El mutante que devolvía `benign` pasaba los doce sobres de arriba y los
   * 5 000 del fuzz: sobrevivía a todo porque su marcador cuelga de `errors`, y `errors` no lo
   * rebaja ni el contrato. Sólo lo mata un mensaje MUDO bajo una clave portadora.
   */
  it('un Message mudo bajo un `status` objeto no hereda benignidad de la nada', async () => {
    const outcome = await post({ Status: { Message: [{ content: 'Booking failed' }] } });

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
  });

  it('lo mismo por la otra clave portadora, SystemSpecificResults', async () => {
    const outcome = await post({
      status: { SystemSpecificResults: [{ Message: [{ content: 'Booking failed' }] }] },
    });

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
  });

  it('una operación con dinero no se reintenta ni cuando el fallo viaja bajo `status`', async () => {
    const spy = fetchReturning({ status: { errors: [{ category: 'APPLICATION_ERROR' }] } });
    await settle(newClient(spy).postJson(CREATE_BOOKING_PATH, {}));
    expect(spy.calls).toBe(1);
  });
});

/**
 * El literal del enum sigue leyéndose donde SÍ es un literal. Que `status` pase de hoja a rama no
 * puede costar la comprobación que ya existía: `Complete` es el único valor que demuestra que la
 * operación terminó (`get-hotel-avail-v5.0.yml:2005-2012`).
 */
describe('puerta pública — el literal de `status` se sigue leyendo', () => {
  it.each([
    ['NotProcessed', 'NOT_PROCESSED'],
    ['Incomplete', 'STATUS_INCOMPLETE'],
    ['Unknown', 'STATUS_UNKNOWN'],
  ])('ApplicationResults.status %s falla con categoría %s', async (value, category) => {
    const outcome = await post({ ApplicationResults: { status: value } }, SHOP_PATH);

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(JSON.stringify((outcome.error as SabreApiError).toLogMeta())).toContain(category);
  });

  it('el literal dentro de un array también se lee: bajar por el array no lo esconde', async () => {
    const outcome = await post({ ApplicationResults: { status: ['NotProcessed'] } }, SHOP_PATH);

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(JSON.stringify((outcome.error as SabreApiError).toLogMeta())).toContain('NOT_PROCESSED');
  });
});

/**
 * El falso positivo es el modo de fallo que MATA la regla: si un sobre real y bueno empieza a
 * fallar, el equipo la desactiva en una semana y volvemos al agujero. Un `status` que ahora es
 * rama, y no hoja, es exactamente el cambio que podría empezar a inventarse problemas.
 *
 * Los guardarraíles de las rondas 3 y 4 se repiten aquí A PROPÓSITO: si el fix de esta ronda los
 * rompiera, el fichero que lo introduce tiene que ser el que se ponga rojo.
 */
describe('puerta pública — cero falsos positivos nuevos', () => {
  it('un `Status` objeto de negocio (la forma del contrato de coches) sigue siendo éxito', async () => {
    const outcome = await post(
      {
        VehAvailRSCore: {
          Status: { code: 'HK', text: 'Confirmed', timeStamp: '2024-05-30T00:17:56.715-05:00' },
          VehVendorAvails: [{ Vendor: { Code: 'ZE' } }],
        },
      },
      SHOP_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  it('un `status` de negocio ajeno al enum tampoco dispara nada al descender', async () => {
    const outcome = await post(
      {
        order: {
          status: { code: 'TICKETED', segments: [{ status: 'HK' }, { status: 'Confirmed' }] },
        },
      },
      SHOP_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  it('ApplicationResults.status Complete con Success[] sigue siendo éxito sin warnings', async () => {
    const outcome = await post(
      {
        GetHotelAvailRS: {
          ApplicationResults: {
            status: 'Complete',
            Success: [{ timeStamp: '2024-05-30T00:17:56.715-05:00' }],
          },
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  it.each([
    ['adult', adultFixture],
    ['child-baggage', childFixture],
    ['family', familyFixture],
  ])(
    'el fixture oficial de BFM v5 "%s" se entrega como éxito y sin warnings',
    async (name, fixture) => {
      const outcome = await post(fixture, SHOP_PATH);

      expect(outcome.kind, name).toBe('resolved');
      if (outcome.kind !== 'resolved') return;
      const result = outcome.value as OkResult;
      expect(result.status, name).toBe(200);
      expect(result.warnings, name).toHaveLength(0);
    },
  );

  it('el `type: "DEFAULT"` de BFM contiene "FAULT" y sigue sin disparar nada', async () => {
    const outcome = await post(
      {
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
      },
      SHOP_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  /** El ejemplo oficial de `get-hotel-avail-v5.0.yml:141-205`, literal. Degrada, no tumba. */
  it('el warning REST oficial de hoteles sigue degradando y NO tumba la búsqueda', async () => {
    const outcome = await post(
      {
        GetHotelAvailRS: {
          ApplicationResults: {
            status: 'Complete',
            Success: [{ timeStamp: '2024-05-30T00:17:56.715-05:00' }],
            Warning: [
              {
                type: 'Application',
                timeStamp: '2024-05-30T00:17:56.709-05:00',
                SystemSpecificResults: [
                  {
                    Message: [
                      { code: 'WARN.0724', value: 'Vendor response error' },
                      { code: 'WarningDetails', value: '112 - No Results Available' },
                    ],
                  },
                ],
              },
            ],
          },
          HotelAvailInfos: { OffSet: 1 },
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings.length).toBeGreaterThanOrEqual(2);
  });

  const CONTRACT_SHAPED_SUCCESS = {
    GetHotelAvailRS: {
      ApplicationResults: {
        status: 'Complete',
        Success: [
          {
            type: 'Application',
            timeStamp: '2024-05-30T00:17:56.715-05:00',
            SystemSpecificResults: [
              {
                timeStamp: '2024-05-30T00:17:56.715-05:00',
                HostCommand: { LNIATA: 'AAVTYZ' },
                Message: [{ code: 'INF.0001', value: 'Search completed' }],
              },
            ],
          },
        ],
      },
    },
  };

  it('los Message dentro de un Success[] con forma de contrato siguen sin ser problemas', async () => {
    const outcome = await post(CONTRACT_SHAPED_SUCCESS, HOTEL_AVAIL_PATH);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  it('CONTRAPESO: ese sobre de hoteles dentro de un createBooking no es un éxito', async () => {
    // El guardarraíl de falso positivo tiene su propio riesgo: si se midiera sólo por el lado
    // permisivo, borrar el filtro de operación no pondría rojo nada. Aquí lo único que cambia es
    // la ruta, y el veredicto tiene que invertirse.
    const outcome = await post(CONTRACT_SHAPED_SUCCESS, CREATE_BOOKING_PATH);

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
  });

  it('el entitlement parcial sigue degradando, no fallando', async () => {
    const outcome = await post(
      {
        warnings: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
        groupedItineraryResponse: { version: '5' },
      },
      SHOP_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).partialUnauthorized).toHaveLength(1);
  });
});
