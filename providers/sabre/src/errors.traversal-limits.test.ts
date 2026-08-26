/**
 * Las barandillas del recorrido y la rama escalar, que llevaban cinco rondas sin fijar.
 *
 * `SABRE_ENVELOPE_MAX_DEPTH` (64) y `SABRE_ENVELOPE_NODE_BUDGET` (500 000) son load-bearing: los
 * dos deciden `exhaustive`, y `exhaustive === false` es la diferencia entre «sobre limpio» y
 * «sobre que no se pudo mirar» — que en este fichero significa error. Estaban sin un solo test.
 * Un número que nadie mide se puede tocar sin consecuencias, y aquí tocarlo cuesta reservas.
 *
 * También se fija la rama escalar (`scalarIssue`): no es fail-open, pero decide QUÉ del proveedor
 * llega al log, y ahí la regla es RNF-07 — un identificador con forma de código sí, texto libre
 * que puede arrastrar PII del pasajero no.
 *
 * Todo por la puerta pública salvo una excepción, marcada y razonada abajo.
 */

import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import {
  SABRE_ENVELOPE_MAX_DEPTH,
  SABRE_ENVELOPE_NODE_BUDGET,
  SabreApiError,
  classifySabreEnvelope,
} from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import type { SabreResult } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';

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

function fetchReturning(payload: unknown): SabreFetch {
  return ((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) satisfies SabreFetch;
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

async function post(payload: unknown, logger?: LoggerPort): Promise<Settled> {
  const client = new SabreHttpClient(config(), fakeTokens(), {
    fetch: fetchReturning(payload),
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
    ...(logger ? { logger } : {}),
  });
  try {
    return { kind: 'resolved', value: await client.postJson(SHOP_PATH, {}) };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

/** El error, o `undefined` si el sobre se aceptó — que en un `expect` de instancia es un fallo. */
function errorOf(outcome: Settled): unknown {
  return outcome.kind === 'rejected' ? outcome.error : undefined;
}

function metaOf(outcome: Settled): string {
  return outcome.kind === 'rejected'
    ? JSON.stringify((outcome.error as SabreApiError).toLogMeta())
    : '';
}

/** `levels` objetos anidados con la hoja al fondo. La hoja queda a profundidad `levels`. */
function chain(levels: number, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let index = 0; index < levels; index += 1) node = { k: node };
  return node;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SABRE_ENVELOPE_MAX_DEPTH
 * ──────────────────────────────────────────────────────────────────────────── */

describe('puerta pública — el tope de anidamiento', () => {
  it('el tope es 64: los sobres reales de Sabre no pasan de ~20 niveles', () => {
    // Se fija el número, no sólo el comportamiento: subirlo acerca el desbordamiento de pila que
    // esta barandilla existe para evitar, y bajarlo empieza a rechazar tráfico legítimo.
    expect(SABRE_ENVELOPE_MAX_DEPTH).toBe(64);
  });

  it('un sobre limpio que llega justo al tope sigue siendo éxito', async () => {
    // `chain(63, hoja)` deja el escalar más profundo exactamente en `SABRE_ENVELOPE_MAX_DEPTH`.
    const outcome = await post(chain(SABRE_ENVELOPE_MAX_DEPTH - 1, { leafKey: 'x' }));

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as SabreResult<unknown>).warnings).toHaveLength(0);
  });

  it('un nivel más allá del tope NUNCA es éxito, ni aunque el contenido sea inocuo', async () => {
    const outcome = await post(chain(SABRE_ENVELOPE_MAX_DEPTH, { leafKey: 'x' }));

    // Este es el carril que importa: pasarse de profundidad no es «no había nada malo», es «no se
    // pudo mirar», y no verificable es error.
    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
    expect(metaOf(outcome)).toContain('ENVELOPE_NOT_VERIFIABLE');
  });

  it('los arrays gastan profundidad igual que los objetos: no son un atajo para pasarse', async () => {
    let node: unknown = { leafKey: 'x' };
    for (let index = 0; index < SABRE_ENVELOPE_MAX_DEPTH; index += 1) node = [node];

    const outcome = await post({ root: node });
    expect(outcome.kind).toBe('rejected');
    expect(metaOf(outcome)).toContain('ENVELOPE_NOT_VERIFIABLE');
  });

  it('un error enterrado a 58 niveles se encuentra con su categoría, no como opaco', async () => {
    const outcome = await post(chain(58, { errors: [{ category: 'APPLICATION_ERROR' }] }));

    expect(outcome.kind).toBe('rejected');
    // Sin esto, «rechazado» podría venir sólo de la barandilla de profundidad y el test no diría
    // nada sobre si el recorrido llega de verdad hasta el fondo.
    expect(metaOf(outcome)).toContain('APPLICATION_ERROR');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * SABRE_ENVELOPE_NODE_BUDGET
 * ──────────────────────────────────────────────────────────────────────────── */

/** `{ data: [0, 0, …] }`: 1 (raíz) + 1 (array) + `elements` nodos. */
function wideEnvelope(elements: number): Record<string, unknown> {
  return { data: new Array(elements).fill(0) as unknown[] };
}

describe('puerta pública — el presupuesto de nodos', () => {
  it('el presupuesto es 500 000 nodos', () => {
    expect(SABRE_ENVELOPE_NODE_BUDGET).toBe(500_000);
  });

  it('un sobre limpio de exactamente 500 000 nodos se entrega, y el log dice cuántos fueron', async () => {
    const { logger, calls } = spyLogger();
    const outcome = await post(wideEnvelope(SABRE_ENVELOPE_NODE_BUDGET - 2), logger);

    expect(outcome.kind).toBe('resolved');
    const ok = calls.find((call) => call.message === 'sabre.http.ok');
    // `envelopeNodes` es la única forma de recalibrar el presupuesto con tráfico real: si un sobre
    // de producción lo rozara, la llamada empezaría a fallar cerrada y hay que verlo venir.
    expect((ok?.meta as { envelopeNodes?: number } | undefined)?.envelopeNodes).toBe(
      SABRE_ENVELOPE_NODE_BUDGET,
    );
  });

  it('un nodo más que el presupuesto NUNCA es éxito', async () => {
    const outcome = await post(wideEnvelope(SABRE_ENVELOPE_NODE_BUDGET - 1));

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
    expect(metaOf(outcome)).toContain('ENVELOPE_NOT_VERIFIABLE');
  });

  /**
   * ÚNICA excepción a «todo por la puerta pública» en este fichero, y conviene justificarla.
   *
   * Lo que se fija aquí no es un veredicto —el veredicto de este mismo sobre ya está fijado por el
   * test de arriba, por `postJson`—, es **cuánto trabajo hizo el recorrido antes de rendirse**.
   * `nodesVisited` sólo cruza la frontera del cliente en el camino de ÉXITO (`sabre.http.ok`), y un
   * sobre que agota el presupuesto no tiene camino de éxito por definición. Sacarlo por el error
   * significaría ensanchar la API pública de `SabreApiError` para que un test pueda mirar; se
   * prefiere medir sobre `classifySabreEnvelope`, que es el símbolo público exportado y el mismo
   * que ejecuta el cliente (`envelope-bypass.e2e.test.ts` y `dist-artifact.guard.test.ts` fijan que
   * no hay una segunda copia, en fuente y en el artefacto compilado).
   *
   * Y lo que se fija importa: antes de esta ronda el presupuesto NO era un techo. `spend` marcaba
   * `exhaustive = false` y cortaba la rama, pero el bucle del padre seguía recorriendo hermanos y
   * cada hermano volvía a gastar. Con 1 800 000 elementos el contador terminaba en 1 800 002, no en
   * 500 001: el «tope» no acotaba nada.
   */
  it('EXCEPCIÓN DOCUMENTADA — el presupuesto es un techo DURO, no una sugerencia', () => {
    const hostile = {
      a: new Array(600_000).fill(0) as unknown[],
      b: new Array(600_000).fill(0) as unknown[],
      c: new Array(600_000).fill(0) as unknown[],
    };

    const verdict = classifySabreEnvelope(hostile);

    // Un solo nodo por encima del presupuesto: el que lo detecta. Ni uno más.
    expect(verdict.nodesVisited).toBe(SABRE_ENVELOPE_NODE_BUDGET + 1);
    expect(verdict.exhaustive).toBe(false);
    expect(verdict.ok).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * La rama escalar de las claves de problema
 * ──────────────────────────────────────────────────────────────────────────── */

describe('puerta pública — un problema escalar bajo una clave de problema', () => {
  it('un identificador con forma de código viaja al log', async () => {
    const outcome = await post({ errors: ['ERR.0161'] });

    expect(outcome.kind).toBe('rejected');
    const meta = metaOf(outcome);
    expect(meta).toContain('ERR.0161');
    expect(meta).toContain('UNSTRUCTURED');
  });

  it.each([
    ['texto libre con espacios', 'texto libre con espacios'],
    ['una tirada larguísima sin forma de código', 'x'.repeat(200)],
  ])(
    '%s NO viaja al log: es texto del proveedor y puede llevar PII (RNF-07)',
    async (_name, value) => {
      const outcome = await post({ errors: [value] });

      expect(outcome.kind).toBe('rejected');
      const meta = metaOf(outcome);
      // El problema se reporta; su contenido, deliberadamente, no.
      expect(meta).toContain('UNSTRUCTURED');
      expect(meta).not.toContain(value);
      expect(meta).not.toContain('"code"');
    },
  );

  it('un escalar que no es texto ni número se reporta opaco, no se descarta', async () => {
    const outcome = await post({ errors: [true] });

    expect(outcome.kind).toBe('rejected');
    expect(metaOf(outcome)).toContain('UNSTRUCTURED');
  });

  it('el `errors: 0` demostrablemente vacío sigue sin ser un problema', async () => {
    // CONTROL del carril de arriba: si esto fallara, la regla estaría inventándose problemas y el
    // coste sería un vendedor sin resultados.
    expect((await post({ errors: 0, data: { itineraryCount: 1 } })).kind).toBe('resolved');
    expect((await post({ errors: [], data: { itineraryCount: 1 } })).kind).toBe('resolved');
    expect((await post({ errors: {}, data: { itineraryCount: 1 } })).kind).toBe('resolved');
  });

  it('pero `errors: [0]` sí lo es: había contenido y no salió ni un issue', async () => {
    // El backstop. Un array con un elemento no está vacío, y que su único elemento no diga nada no
    // demuestra que no hubiera nada que decir.
    const outcome = await post({ errors: [0] });

    expect(outcome.kind).toBe('rejected');
    expect(metaOf(outcome)).toContain('UNSTRUCTURED');
  });

  /**
   * `message: "texto"` es texto suelto (`offer-price-ndc-v1.yml:876`); `messages: ["texto"]` es un
   * problema declarado sin forma. La distinción es un solo `inArray` y no estaba fijada: se podía
   * borrar sin que nada se pusiera rojo, y borrarla convierte cada respuesta NDC con un `message`
   * informativo en una búsqueda caída.
   */
  it('`message` con texto suelto NO es un problema', async () => {
    const outcome = await post({
      message: 'Offer priced successfully',
      pricedOffer: { totalAmount: '1234.00' },
    });

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as SabreResult<unknown>).warnings).toHaveLength(0);
  });

  it('pero `messages: ["texto"]` sí lo es: un array de textos bajo esa clave declara problemas', async () => {
    const outcome = await post({ messages: ['Booking failed'] });

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
  });

  it('un objeto sin identificadores bajo `errors` también cae al backstop', async () => {
    const outcome = await post({ errors: [{ detail: { note: 'sin categoría ni código' } }] });

    expect(outcome.kind).toBe('rejected');
    expect(metaOf(outcome)).toContain('UNSTRUCTURED');
  });
});
