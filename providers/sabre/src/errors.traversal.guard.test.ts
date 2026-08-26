/**
 * LA GUARDA ANTI-RECURRENCIA del recorrido del sobre.
 *
 * Cinco rondas de auditoría encontraron el MISMO fallo con cinco disfraces distintos: un `case`
 * del clasificador que no descendía por su subárbol. Ronda 3 fue `message`, ronda 4 fue `benign`
 * propagado sin fondo, ronda 5 fue `status`. Cada ronda parcheó su caso, la suite se puso verde y
 * el agujero reapareció con otro nombre.
 *
 * Este fichero no vigila un caso: vigila **la propiedad**. Y lo hace por tres vías que fallan por
 * separado, a propósito, porque cada una tapa el punto ciego de las otras:
 *
 *   (1) **Totalidad.** La lista de semánticas que el recorrido reconoce (`SABRE_ENVELOPE_KEY_KINDS`)
 *       se deriva de la tabla real de anotadores, no se escribe a mano. Aquí se cruza con un mapa
 *       de muestras tipado `Record<SabreEnvelopeKeyKind, …>`: añadir una semántica sin darle sobre
 *       de muestra rompe el typecheck Y la comparación de conjuntos en runtime. Una lista rancia
 *       —que es lo que tienen todas las suites que se quedaron verdes— no puede existir.
 *
 *   (2) **Comportamiento, por la puerta pública.** Para CADA semántica se entierra un marcador de
 *       error bajo su clave, en cinco formas distintas, y se exige que `postJson` lance Y que el
 *       marcador llegue al log. Que lance no basta: la clave `errors` lanza por sí sola aunque no
 *       baje. Que el MARCADOR aparezca sólo puede pasar si el recorrido llegó hasta él.
 *
 *   (2b) **Totalidad medida, no prometida.** `envelopeNodes` —el `nodesVisited` del veredicto, que
 *       el cliente publica en el `debug sabre.http.ok`— se compara con el conteo exacto de nodos
 *       del sobre. Saltarse una clave, vaciar el argumento del descenso o abortar el recorrido a
 *       mano bajan ese número, y ninguna de las tres necesita una palabra prohibida para colarse
 *       por (3).
 *
 *   (3) **Estructura de la fuente.** Lo anterior demuestra que las seis semánticas de HOY bajan.
 *       No demuestra que la SÉPTIMA vaya a bajar. Eso lo acota la forma del código: el descenso es
 *       una única llamada, sentencia incondicional de primer nivel del cuerpo del bucle, y los
 *       anotadores son funciones puras que ni reciben `scan` ni reciben `depth` —así que no pueden
 *       ni registrar hallazgos ni recursar—. Esta parte lee el fichero. Es la única del paquete que
 *       lo hace, y se acepta la fragilidad a cambio de lo que compra: reintroducir una rama que
 *       decide si baja deja de ser posible en silencio.
 *
 *   (3b) **La guarda estructural, atacada.** El predicado de (3) se ejecuta contra nueve cuerpos de
 *       bucle sintéticos que reintroducen la clase de fallo, y tiene que rechazarlos todos. Un
 *       predicado que nadie ataca es una afirmación: la versión anterior de (3) prometía «no está
 *       dentro de ningún condicional» y sólo prohibía cinco palabras, así que un
 *       `if (kind !== 'status') { scanNode(…); }` reabría la ronda 5 con los seis tests verdes.
 *       Ese disfraz concreto está fijado en `SURVIVED_BEFORE`, con la comprobación vieja al lado
 *       para que la diferencia se vea.
 *
 * Sobre la elección de (3): la alternativa considerada fue medir sólo comportamiento. Se descartó
 * porque el comportamiento es exactamente lo que estuvo verde durante cinco rondas. El fallo no
 * era que faltara un caso de prueba: era que la ESTRUCTURA permitía que cada caso nuevo naciera
 * roto. Un test que no mire la estructura no puede ver eso.
 *
 * Y el límite de (3), escrito para que nadie lo lea como totalidad: comprueba que la LLAMADA es
 * incondicional, no que sus ARGUMENTOS lleven el subárbol ni que nadie neutralice el recorrido por
 * otra vía. Eso lo miden (2) y (2b). Ver `descentIsUnconditionalStatement`.
 *
 * ## RONDA 7 — por qué cada semántica trae ahora SU ruta
 *
 * El clasificador recibe el contexto de la operación (`{ path }`) y una de las seis semánticas
 * depende de él: `benign` sólo la concede la posición `ApplicationResults.Success` **y** sólo en
 * las ocho lecturas cuyo contrato declara `ApplicationResults`. Con la rejilla entera corriendo
 * sobre `/v5/offers/shop` —que no es una de las ocho—, la fila `benign` medía el descenso por un
 * subárbol al que ya nadie concedía nada: el marcador salía porque la ruta negaba la benignidad,
 * no porque el recorrido bajara. Verde por el motivo equivocado, que es la avería que este fichero
 * existe para no tener.
 *
 * Por eso `KindSample` lleva la ruta sobre la que ESA semántica existe según el contrato. La fila
 * `benign` corre sobre la lectura de hoteles, donde la concesión es real y el descenso es lo único
 * que puede encontrar el marcador; y el par control/contrapeso del final mide el eje nuevo en las
 * dos direcciones.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_ENVELOPE_KEY_KINDS, SabreApiError, type SabreEnvelopeKeyKind } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import type { SabreResult } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';
/** Una de las ocho lecturas cuyo contrato declara `ApplicationResults` (`get-hotel-avail-v5.0.yml`). */
const HOTEL_AVAIL_PATH = '/v5/get/hotelavail';
/** Operación de dinero: su contrato no menciona `ApplicationResults` en ningún sitio. */
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

function fetchReturning(payload: unknown): SabreFetch {
  return ((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) satisfies SabreFetch;
}

type Settled = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: unknown };

async function post(payload: unknown, path: string = SHOP_PATH): Promise<Settled> {
  const client = new SabreHttpClient(config(), fakeTokens(), {
    fetch: fetchReturning(payload),
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  try {
    return { kind: 'resolved', value: await client.postJson(path, {}) };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

/** El error, o `undefined` si el sobre se aceptó — que en un `expect` de instancia es un fallo. */
function errorOf(outcome: Settled): unknown {
  return outcome.kind === 'rejected' ? outcome.error : undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * (1) + (2) — toda semántica reconocida desciende, medido por la puerta pública
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * El marcador. Es un error inequívoco EN CUALQUIER CONTEXTO —cuelga de una clave `errors`, y esa
 * semántica no la rebaja ni el contrato— y lleva identificadores propios para poder exigir que
 * lleguen al log. Si el recorrido no bajó hasta aquí, `MARCADOR_ENTERRADO` no aparece.
 */
const MARKER = { errors: [{ category: 'MARCADOR_ENTERRADO', type: 'MARCADOR_TIPO' }] } as const;
const MARKER_CATEGORY = 'MARCADOR_ENTERRADO';

/** Hoja inocua con la misma forma que el marcador ocupa, para el control de falsos positivos. */
const INERT = { timeStamp: '2024-05-30T00:17:56.715-05:00' } as const;

interface KindSample {
  /** La clave real del contrato que produce esta semántica. */
  readonly key: string;
  /**
   * Ruta sobre la que esa semántica EXISTE según el contrato. Cinco de las seis son
   * independientes de la operación y corren sobre la búsqueda; `benign` no lo es —la concesión la
   * gobierna `SABRE_APPLICATION_RESULTS_PATHS`— y medirla en una ruta que no la concede convierte
   * su fila en decorado.
   */
  readonly path: string;
  /**
   * Coloca el hijo en la POSICIÓN que le da esa semántica. Envuelve lo mínimo imprescindible: si
   * el andamiaje declarara problemas por su cuenta, el test se volvería tautológico.
   */
  readonly place: (child: unknown) => unknown;
  /**
   * El andamiaje por sí solo no declara nada, así que el mismo sobre con una hoja inocua tiene que
   * salir aceptado. `false` para las claves que SIEMPRE declaran un problema por su nombre
   * (`errors`, `warnings`): ahí el control no puede existir y lo que se mide es el marcador.
   */
  readonly silentScaffold: boolean;
}

/**
 * `Record<SabreEnvelopeKeyKind, …>`: el compilador exige una muestra por semántica, y el test de
 * totalidad de abajo exige que las semánticas sean EXACTAMENTE las que el recorrido reconoce.
 */
const KIND_SAMPLES: Readonly<Record<SabreEnvelopeKeyKind, KindSample>> = {
  error: {
    key: 'errors',
    path: SHOP_PATH,
    place: (child) => ({ errors: child }),
    silentScaffold: false,
  },
  warning: {
    key: 'warnings',
    path: SHOP_PATH,
    place: (child) => ({ warnings: child }),
    silentScaffold: false,
  },
  message: {
    // `severity: 'Info'` hace que el mensaje sea demostrablemente inocuo: la ÚNICA forma de
    // encontrar el marcador es bajar por debajo de él. Es el bypass literal de la ronda 3.
    key: 'messages',
    path: SHOP_PATH,
    place: (child) => ({ messages: [{ severity: 'Info', detail: child }] }),
    silentScaffold: true,
  },
  status: {
    // El bypass literal de la ronda 5: `Status` como objeto (`get-vehicle-availability-v1.yml:285`).
    key: 'status',
    path: SHOP_PATH,
    place: (child) => ({ status: child }),
    silentScaffold: true,
  },
  benign: {
    // La única posición que el contrato declara éxito. El bypass literal de la ronda 4. Y la
    // lectura de hoteles es la única de las seis filas que necesita su ruta: sobre `/v5/offers/shop`
    // la concesión no llega a existir, así que el marcador saldría por la ruta y no por el
    // descenso — la fila entera se volvería tautológica.
    key: 'Success',
    path: HOTEL_AVAIL_PATH,
    place: (child) => ({ ApplicationResults: { status: 'Complete', Success: [child] } }),
    silentScaffold: true,
  },
  neutral: {
    key: 'payload',
    path: SHOP_PATH,
    place: (child) => ({ payload: child }),
    silentScaffold: true,
  },
};

/** Cómo se envuelve el marcador por debajo de la clave. Arrays, anidamiento y arrays de arrays. */
const SHAPES: ReadonlyArray<readonly [string, (leaf: unknown) => unknown]> = [
  ['directo', (leaf) => leaf],
  ['dentro de un array', (leaf) => [leaf]],
  ['a tres niveles de objeto', (leaf) => ({ a: { b: { c: leaf } } })],
  ['dentro de un array de arrays', (leaf) => [[{ d: leaf }]]],
  ['objeto → array → objeto', (leaf) => ({ nested: [{ deeper: leaf }] })],
];

describe('guarda anti-recurrencia (1) — la lista de semánticas no puede quedarse rancia', () => {
  it('hay una muestra por cada semántica que el recorrido reconoce, y ninguna de más', () => {
    expect(new Set(Object.keys(KIND_SAMPLES))).toEqual(new Set(SABRE_ENVELOPE_KEY_KINDS));
  });

  it('la lista de semánticas no está vacía: un `Object.keys` roto no puede hacer pasar el test', () => {
    expect(SABRE_ENVELOPE_KEY_KINDS.length).toBeGreaterThanOrEqual(6);
  });
});

const DESCENT_CASES = SABRE_ENVELOPE_KEY_KINDS.flatMap((kind) =>
  SHAPES.map(
    ([shapeName, wrap]) =>
      [`${kind} (${KIND_SAMPLES[kind].key}) — marcador ${shapeName}`, kind, wrap] as const,
  ),
);

describe('guarda anti-recurrencia (2) — TODA semántica desciende, por la puerta pública', () => {
  it.each(DESCENT_CASES)(
    '%s: postJson lanza y el marcador llega al log',
    async (name, kind, wrap) => {
      const payload = KIND_SAMPLES[kind].place(wrap(MARKER));
      const outcome = await post(payload, KIND_SAMPLES[kind].path);

      expect(outcome.kind, `${name}: el sobre se aceptó como éxito`).toBe('rejected');
      if (outcome.kind !== 'rejected') return;
      expect(errorOf(outcome), name).toBeInstanceOf(SabreApiError);
      // Que lance no basta: `errors`/`warnings` lanzan por su nombre aunque no bajen. Que el
      // MARCADOR esté en el log sólo puede pasar si el recorrido llegó hasta él.
      expect(JSON.stringify((outcome.error as SabreApiError).toLogMeta()), name).toContain(
        MARKER_CATEGORY,
      );
    },
  );

  const SILENT = SABRE_ENVELOPE_KEY_KINDS.filter((kind) => KIND_SAMPLES[kind].silentScaffold);

  it.each(
    SILENT.flatMap((kind) =>
      SHAPES.map(([shapeName, wrap]) => [`${kind} — ${shapeName}`, kind, wrap] as const),
    ),
  )(
    'CONTROL %s: el mismo andamiaje con una hoja inocua sigue siendo éxito',
    async (name, kind, wrap) => {
      const outcome = await post(KIND_SAMPLES[kind].place(wrap(INERT)), KIND_SAMPLES[kind].path);

      expect(outcome.kind, `${name}: falso positivo`).toBe('resolved');
      if (outcome.kind !== 'resolved') return;
      expect((outcome.value as SabreResult<unknown>).warnings, name).toHaveLength(0);
    },
  );
});

/**
 * El marcador MUDO, y por qué hace falta un segundo.
 *
 * `MARKER` cuelga de `errors`, y esa semántica no la rebaja nada: eso es justo lo que lo hace un
 * buen marcador para medir descenso… y un mal marcador para medir CONTEXTO. Mutando la defensa
 * apareció un superviviente: un anotador que devolviera `benign` en vez del contexto heredado
 * pasaba los 5 000 casos del fuzz y los doce sobres de la ronda 5. `benign` sólo se propaga por las
 * dos claves que el contrato declara portadoras (`Message`, `SystemSpecificResults`), y sólo
 * silencia lo que no declara severidad por su cuenta.
 *
 * De ahí este segundo marcador: un `Message` MUDO bajo una clave portadora. Es error por defecto
 * —«lo que no se puede demostrar inocuo no lo es»— y deja de serlo en cuanto alguien regala
 * benignidad. `warning` y `benign` quedan fuera de esta rejilla a propósito: un warning no tumba el
 * sobre, y un `Message` mudo dentro de `ApplicationResults.Success[]` es EXACTAMENTE lo que el
 * contrato declara inocuo — ése es el control de abajo.
 */
const MUTE_MARKER = { Message: [{ content: 'Booking failed' }] } as const;

const MUTE_KINDS: readonly SabreEnvelopeKeyKind[] = ['error', 'message', 'status', 'neutral'];

describe('guarda anti-recurrencia (2 bis) — ningún anotador puede regalar benignidad', () => {
  it.each(MUTE_KINDS.map((kind) => [`${kind} (${KIND_SAMPLES[kind].key})`, kind] as const))(
    '%s: un Message mudo bajo esa clave sigue siendo error',
    async (name, kind) => {
      const outcome = await post(KIND_SAMPLES[kind].place(MUTE_MARKER), KIND_SAMPLES[kind].path);

      expect(outcome.kind, `${name}: el mensaje mudo se dio por inocuo`).toBe('rejected');
      expect(errorOf(outcome), name).toBeInstanceOf(SabreApiError);
    },
  );

  /**
   * El control y su contrapeso, que juntos son la medición del eje de la ronda 7. Por separado
   * ninguno de los dos vale: el control solo mide la dirección permisiva —y una defensa que sólo
   * se mide por donde afloja no está medida—, y el contrapeso solo pasaría igual si la benignidad
   * hubiera desaparecido del clasificador entero.
   */
  it('CONTROL: en la lectura que declara ApplicationResults, ese Message mudo sí es inocuo', async () => {
    const outcome = await post(KIND_SAMPLES.benign.place(MUTE_MARKER), HOTEL_AVAIL_PATH);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect((outcome.value as SabreResult<unknown>).warnings).toHaveLength(0);
  });

  it('CONTRAPESO: el MISMO sobre en una operación de dinero no concede nada', async () => {
    // `booking-management-v1.yml` no menciona `ApplicationResults` en ningún sitio. Esa forma
    // llegando en un `createBooking` es eco de un tercero, no la respuesta de la operación, y no
    // puede apagar el recorrido de su subárbol: ahí el `Message` mudo vuelve a ser lo que es.
    const outcome = await post(KIND_SAMPLES.benign.place(MUTE_MARKER), CREATE_BOOKING_PATH);

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
  });

  it('CONTRAPESO: tampoco en la búsqueda de vuelos, que tampoco lo declara', async () => {
    // `/v5/offers/shop` es donde corría toda esta rejilla antes del cableado. Fijarlo aquí es lo
    // que impide volver a medir la fila `benign` sobre una ruta que no concede benignidad.
    const outcome = await post(KIND_SAMPLES.benign.place(MUTE_MARKER), SHOP_PATH);

    expect(outcome.kind).toBe('rejected');
    expect(errorOf(outcome)).toBeInstanceOf(SabreApiError);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) — la estructura que hace imposible la clase de fallo
 * ──────────────────────────────────────────────────────────────────────────── */

/** Mismo idiom que `dist-artifact.guard.test.ts`: vitest puede arrancar desde la raíz o el paquete. */
function findPackageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/sabre') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromWorkspace = resolvePath(process.cwd(), 'providers', 'sabre');
  if (existsSync(join(fromWorkspace, 'package.json'))) return fromWorkspace;
  throw new Error('no se encontró la raíz de @sales-travel/sabre desde el cwd');
}

/**
 * Quita comentarios y literales de cadena antes de mirar la estructura. Sin esto, un `{` dentro de
 * un comentario descuadra el emparejado de llaves y el guard se vuelve una ruleta.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    const char = source[index] ?? '';
    if (char === '"' || char === "'" || char === '`') {
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      out += '""';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Cuerpo `{…}` que sigue a `header`, con las llaves emparejadas. */
function blockAfter(source: string, header: string): string {
  const at = source.indexOf(header);
  expect(at, `no se encontró «${header}» en la fuente`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at + header.length);
  expect(open, `«${header}» no abre bloque`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`bloque sin cerrar para «${header}»`);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * ¿`needle` está en posición de SENTENCIA, o cuelga de algo?
 *
 * Se mira el carácter no-blanco anterior: `;`, `{` o `}` significan «sentencia suelta»; cualquier
 * otra cosa —típicamente el `)` de un `if (…)`— significa que alguien colgó la llamada de una
 * condición. Es el ataque que sobrevivió al primer borrador de este guard: `if (kind !== 'status')`
 * delante del descenso no contiene ni `continue` ni `break` ni `case`, y reabre la ronda 5 entera.
 */
function precededByStatementBoundary(block: string, needle: string): boolean {
  const at = block.indexOf(needle);
  expect(at, `no se encontró «${needle}»`).toBeGreaterThan(0);
  let index = at - 1;
  while (index >= 0 && /\s/.test(block[index] ?? '')) index -= 1;
  return [';', '{', '}'].includes(block[index] ?? '');
}

/**
 * Profundidad de llaves a la que aparece `needle` dentro de `block`, contando desde la `{` con la
 * que `blockAfter` abre. Una sentencia de PRIMER NIVEL del cuerpo está a profundidad 1; cualquier
 * `if { … }`, bloque suelto, `try`, o función anidada que la envuelva la baja a 2 o más.
 *
 * Es la mitad que le faltaba a la comprobación anterior. `precededByStatementBoundary` sola no ve
 * un `if (…) { scanNode(…); }`: el carácter anterior es `{`, o sea «sentencia suelta», y el veredicto
 * salía true. Con la profundidad, ese envoltorio deja de pasar.
 */
function braceDepthAt(block: string, needle: string): number {
  const at = block.indexOf(needle);
  expect(at, `no se encontró «${needle}»`).toBeGreaterThan(0);
  let depth = 0;
  for (let index = 0; index < at; index += 1) {
    if (block[index] === '{') depth += 1;
    if (block[index] === '}') depth -= 1;
  }
  return depth;
}

/**
 * **La propiedad que este bloque SÍ comprueba**, en una sola función para poder atacarla.
 *
 * «La llamada recursiva es una sentencia incondicional del cuerpo del bucle»: aparece una única
 * vez, a primer nivel de llaves, precedida por un final de sentencia, y ninguna sentencia del
 * cuerpo puede saltarse el resto (`continue`/`break`/`return`/`throw`/`switch`/`case`).
 *
 * Lo que **NO** comprueba, y queda escrito para que nadie lo lea como una garantía de totalidad:
 * que los ARGUMENTOS de la llamada lleven el subárbol de verdad (un `kind === 'status' ? undefined
 * : value` la deja incondicional y vacía), y que ninguna sentencia anterior neutralice el recorrido
 * por otra vía (poner `scan.aborted` a mano corta el bucle sin usar ninguna palabra prohibida).
 * Esas dos las cubre la capa (2), que mide COMPORTAMIENTO por la puerta pública para las seis
 * semánticas y en cinco formas cada una, más el conteo de nodos de (2b).
 *
 * Esta capa compra una cosa concreta y sólo esa: que volver a colgar el descenso de una decisión
 * por rama —el disfraz común de las cinco recurrencias— deje de ser posible en silencio.
 */
function descentIsUnconditionalStatement(block: string): boolean {
  const escapes = ['continue', 'break', 'return', 'throw', 'switch', 'case '];
  if (escapes.some((escape) => block.includes(escape))) return false;
  if (occurrences(block, 'scanNode(') !== 1) return false;
  if (braceDepthAt(block, 'scanNode(') !== 1) return false;
  return precededByStatementBoundary(block, 'scanNode(');
}

const SOURCE = stripCommentsAndStrings(
  readFileSync(join(findPackageRoot(), 'src', 'errors.ts'), 'utf8'),
);
const SCAN_NODE = blockAfter(SOURCE, 'function scanNode(');
const KEY_LOOP = blockAfter(SCAN_NODE, 'for (let index = 0; index < keys.length');

describe('guarda anti-recurrencia (3) — descender es el default, no una decisión de cada rama', () => {
  it('el bucle de claves tiene UNA sola llamada recursiva', () => {
    expect(occurrences(KEY_LOOP, 'scanNode(')).toBe(1);
  });

  it('esa llamada es una sentencia INCONDICIONAL de primer nivel del cuerpo del bucle', () => {
    // RONDA 8 — el enunciado anterior era «no está dentro de ningún condicional ni se puede
    // saltar» y lo único que comprobaba era que el bucle no contuviera las palabras `continue`,
    // `break`, `return`, `switch` ni `case`. Eso no es la propiedad, y el hueco es literal:
    //
    //     if (kind !== 'status') { scanNode(value, …); }
    //
    // no contiene ninguna de las cinco palabras, y `precededByStatementBoundary` ve un `{` justo
    // delante —«sentencia suelta»— así que también pasaba. O sea: reabrir la ronda 5 entera dejaba
    // los seis tests de este bloque verdes. Este paquete ya tiene tres precedentes de comentarios
    // que prometen lo que el código no da; éste era el cuarto.
    //
    // Lo que se comprueba ahora está en `descentIsUnconditionalStatement`, y su límite —qué
    // NO garantiza— está escrito ahí y lo cubre la capa (2).
    expect(braceDepthAt(KEY_LOOP, 'scanNode(')).toBe(1);
    expect(precededByStatementBoundary(KEY_LOOP, 'scanNode(')).toBe(true);
    expect(descentIsUnconditionalStatement(KEY_LOOP)).toBe(true);
  });

  it('la recursión por arrays tampoco cuelga de ninguna condición', () => {
    const arrayLoop = blockAfter(SCAN_NODE, 'for (let index = 0; index < node.length');
    expect(occurrences(arrayLoop, 'scanNode(')).toBe(1);
    expect(descentIsUnconditionalStatement(arrayLoop)).toBe(true);
  });

  it('no hay `switch` en todo el recorrido', () => {
    expect(SCAN_NODE).not.toContain('switch');
  });

  it('sólo hay cuatro sitios en el fichero que nombren el recorrido: definición y tres llamadas', () => {
    // Definición + recursión por arrays + recursión por claves + el ARRANQUE ÚNICO. Un quinto
    // sitio es una segunda puerta de entrada al recorrido, y una segunda puerta es exactamente
    // cómo la ronda 2 acabó con dos clasificadores, uno de ellos corriendo en producción.
    //
    // RONDA 13 — el arranque salió de `classifySabreEnvelope` a `runEnvelopeScan` porque ahora hay
    // DOS preguntas que se responden con el mismo recorrido: el veredicto del sobre entero y el
    // del sobre sin su portador de desenlace (`isDeclaredPartialOutcome`). La salida barata era
    // un segundo `scanNode(` para la segunda pregunta; se factorizó en vez de añadirlo, y este
    // bloque fija DÓNDE vive el cuarto sitio para que «cuatro» no se pueda cumplir moviéndolo.
    expect(occurrences(SOURCE, 'scanNode(')).toBe(4);
    expect(occurrences(blockAfter(SOURCE, 'function runEnvelopeScan('), 'scanNode(')).toBe(1);
  });

  it('la segunda pregunta entra por el mismo arranque, no por su propia puerta', () => {
    const partial = blockAfter(SOURCE, 'function isDeclaredPartialOutcome(');
    expect(partial).toContain('runEnvelopeScan(');
    expect(partial).not.toContain('scanNode(');
  });

  it('los dos bucles del recorrido miran el corte de presupuesto en su CONDICIÓN', () => {
    // En la condición y no en el cuerpo: en el cuerpo haría falta un `break`, y un `break` en el
    // bucle de claves es justo lo que el test de arriba prohíbe. Además es lo que convierte
    // `SABRE_ENVELOPE_NODE_BUDGET` en un techo duro (ver `errors.traversal-limits.test.ts`).
    expect(SCAN_NODE).toContain('index < node.length && !scan.aborted');
    expect(SCAN_NODE).toContain('index < keys.length && !scan.aborted');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3b) — la guarda estructural, atacada
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un guard que lee la fuente no vale más que su predicado, y un predicado que nadie ataca es una
 * afirmación. Aquí el predicado se ejecuta contra cuerpos de bucle SINTÉTICOS que reintroducen la
 * clase de fallo con siete disfraces —el primero es exactamente el que sobrevivía a la versión
 * anterior— y se exige que los rechace a todos.
 *
 * Sin este bloque, aflojar `descentIsUnconditionalStatement` no tendría efecto observable en
 * ninguna parte de la suite: los tests de arriba sólo lo llaman con la fuente BUENA, así que un
 * predicado que devolviera `true` a secas los dejaría verdes.
 */
/** El disfraz que sobrevivía: llaves alrededor, ninguna palabra prohibida, `{` justo delante. */
const SURVIVED_BEFORE = '{ const k = 1; if (k) { scanNode(v); } }';

const DESCENT_ATTACKS: ReadonlyArray<readonly [string, string]> = [
  ['`if` con llaves alrededor del descenso', SURVIVED_BEFORE],
  ['`if` sin llaves', '{ const k = 1; if (k) scanNode(v); }'],
  ['cortocircuito con `&&`', '{ const k = 1; k && scanNode(v); }'],
  ['ternario', '{ const k = 1; k ? scanNode(v) : undefined; }'],
  ['bloque suelto', '{ const k = 1; { scanNode(v); } }'],
  ['dentro de un `try`', '{ const k = 1; try { scanNode(v); } catch {} }'],
  ['dentro de un callback', '{ const k = 1; [k].forEach(() => { scanNode(v); }); }'],
  ['salto anticipado antes del descenso', '{ if (k) continue; scanNode(v); }'],
  ['dos puertas de descenso', '{ scanNode(v); if (k) { scanNode(w); } }'],
];

describe('guarda anti-recurrencia (3b) — el predicado estructural rechaza los disfraces', () => {
  it.each(DESCENT_ATTACKS)('rechaza: %s', (_name, body) => {
    expect(descentIsUnconditionalStatement(body)).toBe(false);
  });

  it('acepta la forma honesta, para que el predicado no sea un `false` constante', () => {
    expect(descentIsUnconditionalStatement('{ const k = 1; scanNode(v); k; }')).toBe(true);
  });

  it('EVIDENCIA de que la comprobación anterior no comprobaba la propiedad', () => {
    // Se ejecuta la comprobación vieja —«el bucle no contiene ninguna de estas cinco palabras»—
    // sobre el disfraz, y sale VERDE. Junto con el `precededByStatementBoundary`, que también salía
    // verde, ése era todo el respaldo de la frase «no está dentro de ningún condicional».
    const viejaComprobacion = ['continue', 'break', 'return', 'switch', 'case '].every(
      (escape) => !SURVIVED_BEFORE.includes(escape),
    );

    expect(viejaComprobacion, 'la comprobación vieja ya rechazaba el disfraz').toBe(true);
    expect(precededByStatementBoundary(SURVIVED_BEFORE, 'scanNode(')).toBe(true);
    // Y la nueva lo rechaza. La diferencia entre estas dos líneas es lo que compró esta ronda.
    expect(descentIsUnconditionalStatement(SURVIVED_BEFORE)).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2b) — «desciende por TODA clave», medido en vez de prometido
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La totalidad que la capa (3) NO puede garantizar, medida por la puerta pública.
 *
 * `verdict.nodesVisited` sale en la meta del `debug sabre.http.ok` (`envelopeNodes`), y es el
 * contador que `spend` incrementa **una vez por nodo visitado**. Si el recorrido se saltara una
 * clave —por una condición, por un argumento vaciado, por un `scan.aborted` puesto a mano o por
 * cualquier disfraz que la estructura no vea—, el subárbol entero dejaría de contarse y el número
 * bajaría. Que coincida EXACTAMENTE con el conteo de nodos del sobre es la afirmación «bajó por
 * todas las claves y por todos los elementos», y aquí es una medición, no un comentario.
 */
function nodeCount(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((n, item) => n + nodeCount(item), 0);
  if (value !== null && typeof value === 'object')
    return 1 + Object.values(value).reduce<number>((n, item) => n + nodeCount(item), 0);
  return 1;
}

/** Claves de una sola letra: ninguna cae en una semántica, así que lo que se mide es el descenso. */
const TOTALITY_ENVELOPE = {
  a: 1,
  b: 'x',
  c: { d: 2, e: { f: 3 } },
  g: [1, 2, { h: 4 }],
  i: null,
  j: true,
  k: [[{ l: 'm' }]],
} as const;

async function envelopeNodesFor(payload: unknown): Promise<number> {
  const metas: Array<Record<string, unknown> | undefined> = [];
  const push =
    () =>
    (_message: string, meta?: Record<string, unknown>): void => {
      metas.push(meta);
    };
  const logger: LoggerPort = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => logger,
  };

  const client = new SabreHttpClient(config(), fakeTokens(), {
    fetch: fetchReturning(payload),
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  await client.postJson(SHOP_PATH, {});
  const ok = metas.find((meta) => meta?.['envelopeNodes'] !== undefined);
  expect(ok, 'el cliente no publicó `envelopeNodes`').toBeDefined();
  return ok?.['envelopeNodes'] as number;
}

describe('guarda anti-recurrencia (2b) — el recorrido visita TODOS los nodos, y se cuenta', () => {
  it('`envelopeNodes` es exactamente el número de nodos del sobre', async () => {
    expect(await envelopeNodesFor(TOTALITY_ENVELOPE)).toBe(nodeCount(TOTALITY_ENVELOPE));
  });

  it('CONTROL: quitar un subárbol baja el número — el contador no es una constante', async () => {
    const { c: _c, ...sinSubarbol } = TOTALITY_ENVELOPE;
    const conSubarbol = await envelopeNodesFor(TOTALITY_ENVELOPE);
    const sin = await envelopeNodesFor(sinSubarbol);

    expect(sin).toBe(nodeCount(sinSubarbol));
    // `c` aporta 3 nodos (`c`, `c.d`, `c.e`) más `c.e.f`: si el recorrido no bajara por `c`, el
    // sobre completo ya habría medido lo mismo que éste.
    expect(conSubarbol - sin).toBe(4);
  });
});

const ANNOTATORS = ['annotateInert', 'annotateIssue', 'annotateMessage', 'annotateStatus'];

describe('guarda anti-recurrencia (3) — los anotadores no pueden descender ni registrar nada', () => {
  it.each(ANNOTATORS)('%s no recibe `scan` ni `depth`', (name) => {
    const at = SOURCE.indexOf(`function ${name}(`);
    expect(at, `no se encontró la función ${name}`).toBeGreaterThanOrEqual(0);
    const signature = SOURCE.slice(at, SOURCE.indexOf('{', at));
    // Sin `scan` no puede tocar el veredicto; sin `depth` no puede llamar al recorrido. No es
    // disciplina del que edite: es la firma.
    expect(signature, `${name} recibe scan`).not.toContain('scan');
    expect(signature, `${name} recibe depth`).not.toContain('depth');
  });

  it.each(ANNOTATORS)('%s no nombra el recorrido', (name) => {
    expect(blockAfter(SOURCE, `function ${name}(`)).not.toContain('scanNode');
  });

  it('la tabla de anotadores tampoco: no se puede colar un descenso por ahí', () => {
    expect(blockAfter(SOURCE, 'SABRE_ENVELOPE_ANNOTATORS: Readonly<')).not.toContain('scanNode');
  });

  it('la lista de semánticas se DERIVA de la tabla, no se escribe a mano', () => {
    // Una lista escrita a mano se queda atrás en silencio, y entonces el test de totalidad de
    // arriba deja de proteger nada.
    expect(SOURCE).toContain('Object.keys(SABRE_ENVELOPE_ANNOTATORS)');
  });
});
