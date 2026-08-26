import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError, type SabreIssue } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * SELLO INDEPENDIENTE DE LA RONDA 12 — FALSOS NEGATIVOS.
 *
 * La pregunta que responde este fichero es la única que importa de verdad en este paquete:
 * **¿puede un sobre con un problema dentro entregarse como éxito?** Un falso positivo cuesta un
 * reintento; un falso negativo confirma una reserva que no existe, y el cliente ya pagó.
 *
 * El generador es PROPIO. No reutiliza ni una familia de los ficheros que fijan la defensa: se
 * construye desde el otro lado —desde cómo un agregador esconde un error— y no desde la lista de
 * formas que el clasificador ya sabe reconocer. Si las dos coinciden, coinciden midiendo.
 *
 * Se barre bajo los CUATRO contextos de operación que el paquete distingue, porque el contexto
 * relaja el clasificador y una relajación mal puesta es exactamente donde vive un falso negativo:
 * la operación que declara el cuerpo vacío como éxito, las que pueden conceder benignidad por
 * `ApplicationResults`, una escritura con dinero, y una ruta cualquiera sin privilegio.
 */

const CONTEXTS: ReadonlyArray<readonly [label: string, path: string]> = [
  ['sin privilegio (busqueda)', '/v5/offers/shop'],
  ['cuerpo vacio = exito', '/v1/ancillaries/remove'],
  ['ApplicationResults permitido', '/v5/get/hotelavail'],
  ['escritura con dinero', '/v1/trip/orders/createBooking'],
];

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'U9PK',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sello',
  };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SELLO-SECRETO'),
  invalidate: () => Promise.resolve(),
};

interface Verdict {
  readonly rejected: boolean;
  readonly warnings: readonly SabreIssue[];
  readonly leaked: readonly string[];
}

async function drive(payload: unknown, path: string, witness?: string): Promise<Verdict> {
  const seen: string[] = [];
  const capture =
    () =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (witness !== undefined) seen.push(JSON.stringify({ message, meta }));
    };
  const logger: LoggerPort = {
    debug: capture(),
    info: capture(),
    warn: capture(),
    error: capture(),
    child: () => logger,
  };

  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-sello',
  });

  const outcome = await http.postJson(path, {}).then(
    (result) => result,
    (err: unknown) => err,
  );
  if (!(outcome instanceof SabreApiError) && outcome instanceof Error) throw outcome;

  if (outcome instanceof SabreApiError) {
    const surfaces: Record<string, string> = {
      message: outcome.message,
      body: outcome.body,
      code: outcome.code ?? '',
      issues: JSON.stringify(outcome.issues),
      logMeta: JSON.stringify(outcome.toLogMeta()),
      logDump: seen.join(''),
    };
    return {
      rejected: true,
      warnings: [],
      leaked:
        witness === undefined
          ? []
          : Object.keys(surfaces).filter((name) => (surfaces[name] ?? '').includes(witness)),
    };
  }

  const ok = outcome as { warnings: readonly SabreIssue[] };
  const dump = `${JSON.stringify(ok.warnings)}${seen.join('')}`;
  return {
    rejected: false,
    warnings: ok.warnings,
    leaked: witness !== undefined && dump.includes(witness) ? ['respuesta ok'] : [],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * El generador
 * ──────────────────────────────────────────────────────────────────────────── */

/** PRNG determinista: un fuzz que no se puede volver a correr igual no fija nada. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Las MANERAS de escribir un problema. Se eligen por cómo un agregador REDACTA un fallo —item con
 * casillas, item con la caja cambiada, escalar suelto, escalar no-string, forma anidada— y no por
 * lo que el clasificador sepa leer.
 */
const MARKERS: readonly unknown[] = [
  { severity: 'Error', code: 'ERR.0161' },
  { Severity: 'ERROR', Code: 'ERR.0161' },
  { severity: 'Fatal', category: 'APPLICATION_ERROR' },
  { type: 'FAULT_RESPONSE', fieldPath: 'travelers[0].passport' },
  'algo salio mal',
  42,
  true,
  { detail: { nested: 'boom' } },
  [{ severity: 'Error' }],
];

/**
 * Claves cuya SEMÁNTICA es «lo que cuelga de mí es un problema»: la familia de error. Es sobre
 * ésta —y sólo sobre ésta— sobre la que se puede afirmar «0 supervivientes», porque las otras
 * familias que el clasificador conoce no significan lo mismo:
 *
 *   - la familia `WARNING*` produce un aviso, y un aviso NO tumba la respuesta a propósito;
 *   - `status` / `*ProcessingStatus` deciden por el VALOR (`NotProcessed`, `Incomplete`,
 *     `Unknown`), no por la clave;
 *   - `ApplicationResults` no es un portador de error: es el padre de `status` y de `Success`.
 *
 * Meterlas todas en el mismo saco produciría un número grande y falso. Cada familia se mide por
 * lo que promete.
 */
const ERROR_CARRIER_KEYS: readonly string[] = [
  'errors',
  'Errors',
  'ERRORS',
  'error',
  'Error',
  'errorList',
  'errorCode',
  'errorCodes',
  'errorDetail',
  'errorDetails',
  'errorMessage',
  'errorMessages',
  'errorDescription',
  'errorInfo',
  'fault',
  'faults',
  'soapFault',
  'faultCode',
  'faultString',
  'exception',
  'exceptions',
  'validationErrors',
  'processingErrors',
  'applicationError',
];

/**
 * LA FRONTERA MEDIDA. Estas claves NO las reconoce la regla, así que un problema colgado de
 * cualquiera de ellas se entrega como ÉXITO por las cuatro operaciones, incluida la escritura con
 * dinero. Se fijan aparte —y no se meten en el fuzz de arriba— para que el hueco quede escrito y
 * visible en vez de escondido detrás de un número verde.
 *
 * `diagnostics` NO es hipotética: `offer-price-ndc-v1.yml:138` la declara, y su propia descripción
 * dice «internal-use-only diagnostics to help debug and troubleshoot possible processing errors».
 */
const UNDETECTED_CARRIER_KEYS: readonly string[] = [
  'issues',
  'Issue',
  'problems',
  'errores',
  'diagnostics',
  'Diagnostic',
  'failures',
  'rejections',
  'alerts',
  'notices',
  'conditions',
  'validationResults',
];

/** Claves inocentes con las que se rellena el sobre para enterrar el problema. */
const FILLER_KEYS: readonly string[] = [
  'itineraries',
  'legs',
  'meta',
  'data',
  'payload',
  'results',
  'summary',
  'statistics',
  'links',
  'page',
];

const pick = <T>(random: () => number, list: readonly T[], fallback: T): T =>
  list[Math.floor(random() * list.length)] ?? fallback;

function buildEnvelope(random: () => number, witness: string): unknown {
  const depth = 1 + Math.floor(random() * 7);
  const marker = pick(random, MARKERS, 'boom');
  const carrier = pick(random, ERROR_CARRIER_KEYS, 'errors');

  const wrap = Math.floor(random() * 4);
  let node: unknown =
    wrap === 0
      ? { [carrier]: [marker] }
      : wrap === 1
        ? { [carrier]: marker }
        : wrap === 2
          ? { [carrier]: [[marker]] }
          : { [carrier]: [{ detail: marker, fieldValue: witness }] };

  for (let level = 0; level < depth; level += 1) {
    const filler = pick(random, FILLER_KEYS, 'data');
    // Un `Success` PRESTADO en el camino: el intento clásico de apagar la carga de la prueba con
    // una forma que la operación no declara.
    const sibling =
      random() < 0.35
        ? { ApplicationResults: { status: 'Complete', Success: [{ timeStamp: 'x' }] } }
        : { note: 'ok' };
    node =
      random() < 0.5 ? { [filler]: [sibling, node] } : { [filler]: { ...sibling, nested: node } };
  }
  return node;
}

/* ────────────────────────────────────────────────────────────────────────────
 * (4) FALSOS NEGATIVOS
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(4) sello — falsos negativos bajo los cuatro contextos de operacion', () => {
  it('10.400 sobres hostiles, 4 contextos: ni uno solo se entrega como exito', async () => {
    const perContext = 2_600;
    const survivors: string[] = [];
    let total = 0;

    for (const [label, path] of CONTEXTS) {
      const random = makeRandom(0xc0ffee);
      for (let i = 0; i < perContext; i += 1) {
        const payload = buildEnvelope(random, 'AB1234567');
        total += 1;
        if (!(await drive(payload, path)).rejected) {
          survivors.push(`${label} #${i}: ${JSON.stringify(payload)}`);
        }
      }
    }

    expect(total).toBe(10_400);
    expect(
      survivors.slice(0, 5),
      `${survivors.length} de ${total} sobres hostiles se entregaron como exito`,
    ).toEqual([]);
  }, 180_000);

  it('el endurecimiento del MENSAJE no apago la DETECCION: rechazo y silencio a la vez', async () => {
    // La sospecha razonable tras la ronda 12 es que tapar el valor apague la senal que lo
    // encontraba. Se mide lo contrario en el mismo sobre: rechazado Y sin el testigo dentro.
    const random = makeRandom(0x5ea1ed);
    const bad: string[] = [];
    for (let i = 0; i < 1_200; i += 1) {
      const payload = buildEnvelope(random, 'AB1234567');
      const verdict = await drive(payload, '/v5/offers/shop', 'AB1234567');
      if (!verdict.rejected) bad.push(`no rechazado #${i}`);
      if (verdict.leaked.length > 0) bad.push(`fuga #${i} por ${verdict.leaked.join(', ')}`);
    }
    expect(bad.slice(0, 5), `${bad.length} casos malos de 1200`).toEqual([]);
  }, 120_000);

  it('un `Success` prestado NO apaga la carga de la prueba en ninguna operacion', async () => {
    const payload = {
      ApplicationResults: { status: 'Complete', Success: [{ timeStamp: 'x' }] },
      errors: [{ severity: 'Error', code: 'ERR.0161' }],
    };
    for (const [label, path] of CONTEXTS) {
      expect((await drive(payload, path)).rejected, `${label} entrego un error dentro`).toBe(true);
    }
  });

  it('la familia WARNING no tumba la respuesta pero TAMPOCO se traga el aviso', async () => {
    // Un aviso silenciado es la otra forma de falso negativo: la respuesta vale, pero el vendedor
    // no se entera de que iba capada.
    for (const key of ['warnings', 'Warning', 'warningDetails', 'warningMessages']) {
      const verdict = await drive(
        { [key]: [{ severity: 'Warning', code: 'WARN.0788' }] },
        '/v5/offers/shop',
      );
      expect(verdict.rejected, `${key} tumbo la respuesta`).toBe(false);
      expect(verdict.warnings.length, `${key} se trago el aviso`).toBeGreaterThan(0);
    }
  });

  /**
   * EL HUECO, ESCRITO. La cabecera de `errors.ts` afirma que la regla «no enumera formas malas»
   * y que «todo lo que no se pueda demostrar benigno cuenta como error, en cualquier forma y a
   * cualquier profundidad». La medición dice otra cosa: la detección ES una enumeración de
   * NOMBRES DE CLAVE (`SABRE_ERROR_KEYS`, `SABRE_WARNING_KEYS` y cuatro reglas de sufijo), y un
   * problema colgado de una clave que no esté en ella se entrega como éxito por las cuatro
   * operaciones — incluida la escritura con dinero.
   *
   * Este test NO es un deseo: fija el comportamiento REAL para que el día que se cierre el hueco
   * la suite se ponga roja aquí y alguien tenga que venir a borrarlo a mano. Es lo contrario de
   * dejarlo dicho en un comentario.
   */
  it('FRONTERA: un problema bajo una clave no enumerada se entrega como EXITO', async () => {
    const delivered: string[] = [];
    for (const key of UNDETECTED_CARRIER_KEYS) {
      for (const [label, path] of CONTEXTS) {
        if (!(await drive({ [key]: [{ severity: 'Error', code: 'ERR.0161' }] }, path)).rejected) {
          delivered.push(`${key} @ ${label}`);
        }
      }
    }
    expect(delivered.length).toBe(UNDETECTED_CARRIER_KEYS.length * CONTEXTS.length);
  });

  it('FRONTERA: ni la severidad ni el escalar rescatan a la clave no enumerada', async () => {
    // Lo unico que rescata es una clave ANIDADA que si este enumerada: `errorCode` dentro de
    // `issues[]` se detecta. Depende del nombre, nunca del contenido.
    const shop = '/v5/offers/shop';
    expect((await drive({ issues: [{ severity: 'Fatal' }] }, shop)).rejected).toBe(false);
    expect((await drive({ issues: ['boom'] }, shop)).rejected).toBe(false);
    expect((await drive({ issues: [{ errorCode: 'ERR.0161' }] }, shop)).rejected).toBe(true);
    expect((await drive({ problems: [{ status: 'NotProcessed' }] }, shop)).rejected).toBe(true);
  });

  it('el cuerpo vacio solo es exito donde el contrato lo declara', async () => {
    const results = await Promise.all(
      CONTEXTS.map(async ([label, path]) => [label, (await drive({}, path)).rejected] as const),
    );
    expect(Object.fromEntries(results)).toEqual({
      'sin privilegio (busqueda)': true,
      'cuerpo vacio = exito': false,
      'ApplicationResults permitido': true,
      'escritura con dinero': true,
    });
  });
});

describe('(4b) sello — la benignidad se concede por CONTRATO, no por forma', () => {
  /**
   * Mata «`benignAllowed: true` para todas las operaciones».
   *
   * El testigo tiene que llevar el problema por la via que la benignidad SI apaga: un `Message[]`
   * dentro de `SystemSpecificResults[]`, dentro de `Success[]`, dentro de `ApplicationResults`
   * —la forma literal que declara `get-hotel-avail-v5.0.yml:2023-2072`—. Una clave de error
   * explicita no sirve de testigo: sobrevive a la concesion y el mutante quedaria vivo.
   */
  const payload = {
    ApplicationResults: {
      status: 'Complete',
      Success: [
        {
          SystemSpecificResults: [{ Message: [{ content: 'Booking failed' }] }],
        },
      ],
    },
  };

  it('la lectura de inventario que lo declara SI puede conceder', async () => {
    expect((await drive(payload, '/v5/get/hotelavail')).rejected).toBe(false);
  });

  it('la escritura con dinero y la busqueda NO pueden conceder', async () => {
    expect(
      (await drive(payload, '/v1/trip/orders/createBooking')).rejected,
      'createBooking no declara ApplicationResults en su contrato',
    ).toBe(true);
    expect(
      (await drive(payload, '/v5/offers/shop')).rejected,
      'bargain-finder-max tampoco lo declara',
    ).toBe(true);
  });
});
