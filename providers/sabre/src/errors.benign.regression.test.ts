/**
 * Regresiones de la RONDA 4 sobre la regla dura de éxito (`classifySabreEnvelope`).
 *
 * La cicatriz de este paquete tiene una sola forma y ya van cuatro veces: **un subárbol que el
 * recorrido deja de vigilar**. La ronda 3 cerró el subárbol de `messages[]` haciéndolo recorrer;
 * la ronda 4 encuentra el MISMO agujero por el lado contrario — el subárbol se recorre, pero se
 * recorre declarado **benigno**, y benigno significa «no mires nada de lo que cuelgue aquí».
 *
 * El defecto concreto: `benign` se concedía por el NOMBRE de la clave (cualquier cosa que
 * normalizara a `SUCCESS`/`SUCCESSES`), a cualquier profundidad, bajo cualquier padre, y se
 * propagaba sin fondo por todo el subárbol. El propio comentario del fichero decía que `benign`
 * «está reservado a los contenedores que el CONTRATO declara éxito (`ApplicationResults.Success[]`)»
 * — y la implementación nunca miraba el padre. Eso reabría el bypass 6 de la ronda 1 y deshacía
 * el pin A5 de la ronda 3.
 *
 * El control que cierra el argumento está abajo: `{wrapper:{messages:[…]}}` —idéntico salvo el
 * NOMBRE de la clave— siempre se rechazó. Sólo el nombre separaba una reserva fantasma de un
 * fallo detectado.
 *
 * Como en `envelope-bypass.e2e.test.ts` y `errors.subtree.regression.test.ts`, **todo entra por la
 * puerta pública**: `postJson`, no `classifySabreEnvelope`. Un test que llama a la función interna
 * sólo demuestra que esa función es correcta, jamás que sea la que corre en producción — que es
 * exactamente cómo la ronda 2 tuvo 347 tests verdes sobre un clasificador que nadie invocaba.
 *
 * ## RONDA 7 — la benignidad tiene ahora DOS condiciones, y la segunda es la operación
 *
 * La ronda 4 ató `benign` a la POSICIÓN (`Success` colgando de `ApplicationResults`). La ronda 7
 * añade la de encima: esa posición sólo concede nada si el contrato de **la operación que se está
 * llamando** declara `ApplicationResults`. Son ocho de los 21 contratos y los ocho son lecturas de
 * inventario (`SABRE_APPLICATION_RESULTS_PATHS`); ninguna operación de dinero, de emisión ni de
 * shopping lo declara. Sabre es un agregador que hace eco de contenido de terceros: un
 * `ApplicationResults.Success` llegando dentro de un `createBooking` no es la respuesta de la
 * operación, es una forma que ahí no pinta nada, y darle el poder de apagar el recorrido de un
 * subárbol entero es conceder benignidad por la forma suelta —el error de la ronda 4, un nivel más
 * arriba—.
 *
 * Consecuencia para este fichero: los sobres BUENOS que dependen de la concesión se ejercitan
 * sobre `/v5/get/hotelavail`, que es donde el contrato la declara, y **cada uno trae su
 * CONTRAPESO**: el mismo sobre sobre `/v1/trip/orders/createBooking` tiene que rechazarse. Un test
 * que sólo mide la dirección permisiva no mide la defensa, mide el permiso.
 */

import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';
const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';
/**
 * La lectura de inventario cuyo contrato declara `ApplicationResults` (`get-hotel-avail-v5.0.yml`),
 * o sea la única clase de operación que puede conceder benignidad por `Success`.
 */
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

interface OkResult {
  status: number;
  warnings: readonly unknown[];
  partialUnauthorized: readonly unknown[];
}

/**
 * Rechazar no basta: el cliente reventando con un `TypeError` o un `RangeError` de recursión
 * también «rechaza», y eso no es protección — es otra avería. Se exige el tipo y el status.
 */
function expectSabreApiError(outcome: Settled, name?: string): void {
  expect(outcome.kind, name).toBe('rejected');
  if (outcome.kind !== 'rejected') return;
  expect(outcome.error, name).toBeInstanceOf(SabreApiError);
  expect((outcome.error as SabreApiError).status, name).toBe(200);
}

/**
 * Los ocho sobres que la ronda 4 midió ACEPTADOS como éxito con `warnings.length === 0` por
 * `postJson('/v1/trip/orders/createBooking')` con HTTP 200. Cada uno es una reserva fantasma: el
 * cliente no vuela y ya se le cobró.
 */
const RONDA_4_BENIGN_ENVELOPES: ReadonlyArray<readonly [string, unknown]> = [
  [
    'C1. `success` en la raíz: ningún contrato declara éxito ahí',
    { success: { messages: [{ content: 'Booking failed' }] } },
  ],
  [
    'C2. dentro del Success[] que el contrato SÍ declara, un mensaje de fallo sin severidad',
    {
      ApplicationResults: {
        status: 'Complete',
        Success: [{ messages: [{ content: 'Ticketing failed' }] }],
      },
    },
  ],
  [
    'C3. `SUCCESS_`: el guion bajo lo borra la normalización de la clave',
    { SUCCESS_: { messages: [{ content: 'Booking failed' }] } },
  ],
  [
    'C4. `message` singular bajo un `success` de la raíz',
    { success: { message: { content: 'Booking failed' } } },
  ],
  [
    'C5. el contexto benigno se propagaba cinco niveles sin fondo',
    { success: { a: { b: { c: { messages: [{ content: 'Booking failed' }] } } } } },
  ],
  [
    'C6. escalar de texto bajo `messages` dentro de un `success`',
    { success: { messages: ['Booking failed'] } },
  ],
  [
    'C7. array en la raíz con el `success` dentro',
    [{ success: { messages: [{ content: 'Booking failed' }] } }],
  ],
  [
    // Encadenado tras el descenso que abrió la ronda 3: se baja por `messages[]` y abajo espera
    // un `success` que volvía a apagar el recorrido.
    'C8. `success` colgando de un item de messages[] con severity Info',
    { messages: [{ severity: 'Info', success: { messages: [{ content: 'fail' }] } }] },
  ],
];

describe('puerta pública — el contexto benigno tiene fondo y lo concede el contrato', () => {
  it.each(RONDA_4_BENIGN_ENVELOPES)(
    '%s lanza SabreApiError desde postJson',
    async (name, payload) => {
      const outcome = await post(payload);

      expect(outcome.kind, `${name}: el sobre se aceptó como éxito`).toBe('rejected');
      if (outcome.kind !== 'rejected') return;
      // Lanzar OTRA cosa (TypeError, RangeError por recursión…) tampoco es protección.
      expect(outcome.error, name).toBeInstanceOf(SabreApiError);
      expect((outcome.error as SabreApiError).status, name).toBe(200);
    },
  );

  /**
   * El control que cierra el argumento: el MISMO sobre con la clave renombrada siempre se
   * rechazó. Si esto se pusiera verde-por-el-otro-lado (es decir, si empezara a aceptarse),
   * el arnés estaría midiendo otra cosa.
   */
  it('CONTROL: el mismo sobre con la clave `wrapper` se rechazaba ya, y sigue rechazándose', async () => {
    const outcome = await post({ wrapper: { messages: [{ content: 'Booking failed' }] } });

    expectSabreApiError(outcome);
  });

  /**
   * C2 es el único de los ocho que vive DENTRO de la posición que el contrato declara, así que
   * desde la ronda 7 lo cubren dos defensas distintas: la ruta de dinero le niega la concesión, y
   * el SUELO de la ronda 4 se la negaría igual porque `messages` no es clave portadora
   * (`SABRE_BENIGN_CARRIER_KEYS` son `SystemSpecificResults` y `Message`, nada más).
   *
   * Dos defensas superpuestas es exactamente cómo una de las dos se muere sin que nadie lo note.
   * Este test corre C2 sobre la lectura donde la concesión SÍ existe: ahí la ruta no lo salva y lo
   * único que puede rechazarlo es el suelo. Si alguien ampliara la lista de claves portadoras, este
   * test se pone rojo aunque el de arriba siga verde.
   */
  it('C2 se rechaza también en la lectura que sí concede benignidad: lo para el suelo, no la ruta', async () => {
    const outcome = await post(
      {
        ApplicationResults: {
          status: 'Complete',
          Success: [{ messages: [{ content: 'Ticketing failed' }] }],
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });

  it('una operación con dinero no se reintenta ni cuando el fallo viaja bajo un `success`', async () => {
    const spy = fetchReturning({ success: { messages: [{ content: 'Booking failed' }] } });
    await settle(newClient(spy).postJson(CREATE_BOOKING_PATH, {}));
    expect(spy.calls).toBe(1);
  });
});

/**
 * Sondas de comportamiento sobre la defensa nueva. Cada par aísla UNA de las tres condiciones que
 * ahora conceden `benign` — el contrato de la OPERACIÓN, la posición del padre y la clave
 * portadora — y comprueba que el sobre bueno y el malo caen a lados distintos. Si una de las tres
 * dejara de ser determinante, el par se pondría rojo: es la prueba de que ninguna es un mutante
 * equivalente.
 *
 * Los sobres BUENOS corren sobre `HOTEL_AVAIL_PATH`, no sobre la búsqueda de vuelos: la concesión
 * no existe fuera de las ocho lecturas, y medir «esto pasa» donde nada puede pasar no es medir.
 * Los MALOS corren sobre la ruta de dinero *y* sobre la lectura, para que se vea cuál de las tres
 * condiciones los está parando.
 */
describe('puerta pública — qué concede benign, en las dos direcciones', () => {
  const CONTRACT_SUCCESS = {
    ApplicationResults: {
      status: 'Complete',
      Success: [{ SystemSpecificResults: [{ Message: [{ value: 'ok' }] }] }],
    },
  };

  it('la posición del contrato lo concede: Success bajo ApplicationResults pasa sin warnings', async () => {
    const outcome = await post(CONTRACT_SUCCESS, HOTEL_AVAIL_PATH);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  it('CONTRAPESO: el MISMO sobre en una operación que no declara ApplicationResults se rechaza', async () => {
    // Sin este contrapeso el test de arriba sólo dice «la forma buena pasa donde todo pasa». Aquí
    // está el eje entero de la ronda 7: la misma forma, distinta operación, veredicto opuesto.
    for (const path of [CREATE_BOOKING_PATH, SHOP_PATH, '/v1/ancillaries/remove']) {
      expectSabreApiError(await post(CONTRACT_SUCCESS, path), path);
    }
  });

  it('el MISMO subárbol sin el padre ApplicationResults ya no lo concede', async () => {
    // En la lectura que SÍ concede: así lo que rechaza es la posición del padre (ronda 4) y no la
    // ruta (ronda 7). Sobre `createBooking` este test pasaría por el motivo equivocado.
    const outcome = await post(
      { Success: [{ SystemSpecificResults: [{ Message: [{ value: 'ok' }] }] }] },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });

  it('sólo las claves que el contrato declara dentro de Success[] lo transportan', async () => {
    const outcome = await post(
      {
        ApplicationResults: {
          status: 'Complete',
          Success: [{ detail: { Message: [{ value: 'ok' }] } }],
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });

  /**
   * Y el fondo: que un `Message` dentro de `Success[]` sea inocuo no dice NADA de lo que cuelgue
   * de él. Es la misma frase que la ronda 3 escribió para `severity: 'Info'`, aplicada al único
   * contexto que el contrato sí autoriza.
   */
  it('benign no sobrevive a una clave ajena al contrato colgada de un Message', async () => {
    const outcome = await post(
      {
        ApplicationResults: {
          status: 'Complete',
          Success: [
            {
              SystemSpecificResults: [
                { Message: [{ value: 'ok', messages: [{ content: 'Booking failed' }] }] },
              ],
            },
          ],
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });

  /**
   * El caso que separa el suelo de `scanNode` del suelo de `scanMessageValue`, y que existe
   * porque `Message` es una clave PORTADORA: si el descenso desde un item de mensaje conservara
   * `benign`, un `Message` anidado dentro de otro `Message` volvería a estar dentro del
   * salvoconducto y el ciclo se podría repetir tantas veces como hiciera falta. El contrato
   * declara `Message[]` con `code` y `value` y nada más (`get-hotel-avail-v5.0.yml:2065-2079`):
   * un `Message` dentro de un `Message` no es forma de contrato y no hereda su permiso.
   */
  it('benign tampoco se recicla anidando la propia clave portadora', async () => {
    const outcome = await post(
      {
        ApplicationResults: {
          status: 'Complete',
          Success: [
            {
              SystemSpecificResults: [
                { Message: [{ value: 'ok', Message: [{ content: 'Booking failed' }] }] },
              ],
            },
          ],
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });

  /**
   * La dirección contraria del mismo hilo: `ApplicationResults` dentro de un ARRAY sigue siendo la
   * posición que el contrato declara. Un array no cambia de posición a nadie, y si el recorrido
   * perdiera el rastro del padre al bajar por él, este sobre bueno empezaría a fallar.
   */
  const CONTRACT_SUCCESS_IN_ARRAY = {
    ApplicationResults: [
      {
        status: 'Complete',
        Success: [{ SystemSpecificResults: [{ Message: [{ value: 'ok' }] }] }],
      },
    ],
  };

  it('el Success sigue siendo contrato aunque ApplicationResults venga dentro de un array', async () => {
    const outcome = await post(CONTRACT_SUCCESS_IN_ARRAY, HOTEL_AVAIL_PATH);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  it('CONTRAPESO: dentro de un array o fuera, en una operación de dinero no concede nada', async () => {
    // El array no cambia de posición a nadie, y tampoco cambia de operación a nadie: los dos ejes
    // se miden por separado y ninguno tapa al otro.
    expectSabreApiError(await post(CONTRACT_SUCCESS_IN_ARRAY, CREATE_BOOKING_PATH));
  });

  /**
   * SONDA DE MUTANTE EQUIVALENTE. `envelopeKeyKind` concedía `benign` también a `SUCCESSES`, que
   * no es clave de ningún contrato; se quitó. Devolverla NO pone rojo ningún test, y eso no es un
   * hueco de test: es que la mutación es equivalente. Este par lo demuestra por comportamiento —
   * el sobre hostil se rechaza por el SUELO de claves portadoras, esté `SUCCESSES` en la lista de
   * concesión o no, porque `messages` no transporta el permiso en ninguno de los dos casos.
   *
   * Se quita igualmente: una clave que el contrato no declara no puede declarar éxito, y dejarla
   * es superficie que sólo protege el suelo. Si alguien tocara el suelo, esto se pone rojo.
   */
  it('`Successes` bajo ApplicationResults tampoco salva un mensaje de fallo', async () => {
    const outcome = await post(
      {
        ApplicationResults: {
          status: 'Complete',
          Successes: [{ messages: [{ content: 'fail' }] }],
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });

  it('un Error dentro de Success[] sigue siendo un error, como siempre', async () => {
    // En la lectura que concede benignidad: es el único sitio donde este test dice algo. Sobre una
    // ruta de dinero lo pararía la ronda 7 y nunca sabríamos si el `Error` se sigue leyendo.
    const outcome = await post(
      {
        ApplicationResults: {
          status: 'Complete',
          Success: [{ Error: [{ type: 'Validation', code: 'ERR.0161' }] }],
        },
      },
      HOTEL_AVAIL_PATH,
    );

    expectSabreApiError(outcome);
  });
});

/**
 * HALLAZGO 9 — homoglifo. `{"еrrors":[…]}` con «е» CIRÍLICA (U+0435) se leía como `errors` en
 * pantalla y como `RRORS` en la normalización, que borra todo lo que no es `[A-Za-z0-9]`.
 *
 * La decisión y su porqué están en `errors.ts` (ver `SABRE_KEY_NON_ASCII`). Resumen: **toda clave
 * de los 21 contratos de Sabre es ASCII**, así que una clave con un carácter fuera de ASCII no es
 * comparable con el contrato — el recorrido no puede interpretarla — y no interpretable es error.
 * NFKC no servía: no mapea cirílico a latino, eso es tabla de confundibles, no forma de
 * normalización Unicode.
 */
describe('puerta pública — una clave que no se puede interpretar no es un éxito', () => {
  it('el homoglifo cirílico en la clave `errors` ya no pasa como éxito', async () => {
    const outcome = await post({ еrrors: [{ category: 'APPLICATION_ERROR' }] });

    expectSabreApiError(outcome);
  });

  it('el mismo homoglifo en una clave cualquiera tampoco pasa: la regla es la clave, no el nombre', async () => {
    const outcome = await post({ еstado: { ok: true } });

    expectSabreApiError(outcome);
  });

  /**
   * La otra dirección, que es la que evita el falso positivo: los VALORES sí llevan acentos y
   * caracteres no ASCII —nombres de ciudad, de pasajero— y eso no toca la regla para nada.
   */
  it('un valor con caracteres no ASCII sigue siendo un 200 limpio', async () => {
    const outcome = await post(
      {
        groupedItineraryResponse: {
          version: '5',
          messages: [{ severity: 'Info', type: 'DEFAULT', text: 'São Paulo — Bogotá' }],
        },
      },
      SHOP_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });
});

/**
 * HALLAZGO BAJO — `status`. El enum de `ApplicationResults.status` es
 * `Complete | Incomplete | NotProcessed | Unknown` (`get-hotel-avail-v5.0.yml:2005-2012`,
 * idéntico en v4). `Incomplete` y `Unknown` se entregaban como ÉXITO con un warning.
 *
 * En un `createBooking` eso es literalmente el estado de reserva a medias, que es el caso que este
 * paquete existe para no entregar. El razonamiento completo del coste está en `errors.ts`, sobre
 * `SABRE_STATUS_NOT_COMPLETE`.
 */
describe('puerta pública — sólo `Complete` demuestra que la operación terminó', () => {
  it.each([
    ['Incomplete', 'Incomplete'],
    ['Unknown', 'Unknown'],
    ['NotProcessed', 'NotProcessed'],
  ])('status %s lanza SabreApiError en un path de dinero', async (_name, status) => {
    const outcome = await post({ ApplicationResults: { status } });

    expectSabreApiError(outcome);
  });

  it('status Complete sigue siendo éxito sin warnings', async () => {
    const outcome = await post({ ApplicationResults: { status: 'Complete' } }, SHOP_PATH);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });

  /**
   * `status` es una clave frecuentísima fuera de `ApplicationResults` (estado de un segmento, de
   * un pago, de un pasajero). La regla mira tres literales concretos y no «todo lo que no sea
   * Complete»: si se invirtiera, cada `status: 'Confirmed'` tumbaría la llamada.
   */
  it('un `status` de negocio ajeno al enum no dispara nada', async () => {
    const outcome = await post(
      { order: { status: 'Confirmed', segments: [{ status: 'HK' }] } },
      SHOP_PATH,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as OkResult).warnings).toHaveLength(0);
  });
});

/**
 * HALLAZGO MEDIO — la rama muerta de `UNAUTHORIZED`.
 *
 * `classifyApplication` desempataba los siete `UNAUTHORIZED` con `signal.description`, y NINGUNO
 * de los cuatro sitios de llamada reales rellena ese campo: el cliente HTTP construye la señal
 * desde `verdict.failures[0]`, que es un `SabreIssue`, y `SabreIssue` deja fuera el texto libre A
 * PROPÓSITO (RNF-07, PII del pasajero). La rama `AUTH_EXPIRED` no podía ejecutarse en producción
 * — el patrón de la ronda 2 en pequeño — y el único test que la tocaba llamaba a
 * `classifySabreFailure` directamente.
 *
 * Estos dos tests son de CARACTERIZACIÓN, no de regresión: pasan igual antes y después de borrar
 * la rama, y ese es justamente el punto — demuestran por la puerta pública que borrarla no cambia
 * ningún comportamiento observable.
 */
describe('puerta pública — UNAUTHORIZED dentro de un 200 se resuelve sin texto libre', () => {
  it('un UNAUTHORIZED con texto de token expirado sale como ENTITLEMENT, no como AUTH_EXPIRED', async () => {
    const outcome = await post({
      errors: [
        {
          category: 'UNAUTHORIZED',
          type: 'UNAUTHORIZED_ACCESS',
          description: 'Expired or invalid security token',
        },
      ],
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    const error = outcome.error as SabreApiError;
    expect(error.failure.kind).toBe('ENTITLEMENT');
    expect(error.failure.retry).toBe('NO_RETRY');
    expect(error.retryable).toBe(false);
  });

  it('el texto libre del proveedor no llega al log ni por el issue ni por el mensaje', async () => {
    const outcome = await post({
      errors: [{ category: 'UNAUTHORIZED', description: 'Expired or invalid security token' }],
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    const meta = JSON.stringify((outcome.error as SabreApiError).toLogMeta());
    expect(meta).toContain('UNAUTHORIZED');
    expect(meta).not.toContain('Expired or invalid security token');
  });
});

/**
 * El falso positivo es el modo de fallo que MATA la regla: si un sobre real y bueno empieza a
 * fallar, el equipo la desactiva en una semana y volvemos al agujero. Estos son los guardarraíles
 * de la ronda 4, repetidos aquí a propósito — si el fix de `benign` los rompiera, el fichero que
 * lo introduce tiene que ser el que se ponga rojo.
 */
describe('puerta pública — cero falsos positivos nuevos', () => {
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

  /**
   * El ejemplo oficial de `get-hotel-avail-v5.0.yml:141-205`, literal: `Success[]` con sólo un
   * `timeStamp` y los `Warning[]` con sus `Message[]` cuatro niveles abajo. Tiene que degradar —
   * warnings > 0 — y NO tumbar la búsqueda.
   */
  it('el warning REST oficial de hoteles sigue degradando y NO tumba la búsqueda', async () => {
    // Sobre la ruta de hoteles, que es de donde sale el ejemplo. Correrlo sobre la búsqueda de
    // vuelos lo dejaba verde igual —los `Warning[]` no dependen de la concesión— pero medía la
    // operación equivocada, y el día que `Success[]` traiga algo más que un `timeStamp` esa
    // diferencia deja de ser cosmética.
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

  /**
   * El `Success[]` legítimo con la forma completa que declara `ElementStructure`: los `Message`
   * de dentro no son problemas, ni al descender.
   */
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

  it('CONTRAPESO: ese mismo sobre en un createBooking no es un éxito, es eco de un tercero', async () => {
    // `INF.0001 Search completed` dentro de una reserva no es la respuesta de la reserva. Que sea
    // un sobre de hoteles PERFECTO es justo lo que lo hace buen contrapeso: lo único que cambia
    // entre este test y el de arriba es la operación.
    expectSabreApiError(await post(CONTRACT_SHAPED_SUCCESS, CREATE_BOOKING_PATH));
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
