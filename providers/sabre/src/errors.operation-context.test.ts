/**
 * RONDA 7 — la prueba del OTRO lado de la balanza, y el contexto de operación que la resuelve.
 *
 * Seis rondas endurecieron el clasificador contra falsos NEGATIVOS (un sobre malo que pasa). La
 * ronda 6 hizo por fin la medición contraria —pasar los ejemplos de ÉXITO de los 21 contratos
 * oficiales por el clasificador— y encontró falsos POSITIVOS. Un falso positivo no es «un
 * reintento barato»: es el vendedor mirando un error en pantalla, delante del cliente, después de
 * que la operación SÍ se ejecutó. En una escritura además le invita a repetirla.
 *
 * Los rechazados son todos el mismo caso, y no es un descuido del proveedor:
 *
 *   `manage-ancillary-1.1.yml` declara para `POST /v1/ancillaries/remove` una respuesta cuyo
 *   ÚNICO campo es `errors[]` (`:932-940`). Sin errores no queda nada que devolver, y por eso sus
 *   ejemplos de éxito (`:837`, `:862`, `:887`) son literalmente `{ }`, con la descripción
 *   «Ancillaries have been successfully removed … We receive an empty response».
 *
 * La regla de la ronda 5 —«un sobre vacío no es éxito»— existe para cazar el `createBooking` que
 * responde `{}` con la reserva a medias, y esa sigue en pie. Lo que cambia es que ahora la matiza
 * el CONTRATO de la operación que se está llamando, con listas cerradas derivadas de los `.yml`
 * pineados por `spec-manifest.test.ts`.
 *
 * ## Qué entra por la puerta pública y qué no, y por qué
 *
 * La familia entera de tests de este paquete mide por `postJson` a propósito: un test que llama a
 * la función interna sólo demuestra que esa función es correcta, jamás que sea la que corre en
 * producción (ronda 2). Aquí ya se mantiene para TODO, porque el eje ya está cableado.
 *
 * **El cableado llegó tarde y esa es la lección de esta ronda.** Los dos ejes nacieron con la
 * política escrita, sus listas derivadas de los `.yml` y sus tests verdes… y el único sitio de
 * llamada real, `http/sabre-http.client.ts`, invocaba `classifySabreEnvelope(payload)` sin
 * segundo argumento. Trabajo entero inalcanzable en producción: la ronda 2 en pequeño, otra vez.
 * Hoy la línea pasa `{ path }` y por eso §8 de este fichero fija el cableado por dos vías —
 * comportamiento observable y estructura de la fuente—: sin ese pin, alguien vuelve a quitar el
 * argumento y ningún test se entera.
 *
 * ## Qué mide cada bloque
 *
 *   - §1 mide falsos positivos contra los 252 ejemplos oficiales de los 21 contratos, y lo hace
 *     dos veces: por el clasificador (aislando la política) y por `postJson` (que es lo que corre).
 *     El número que hay que mirar cuando alguien endurezca la regla otra vez está ahí.
 *   - §2 y §3 miden los dos ejes derivados del contrato: el cuerpo vacío y la concesión de
 *     benignidad. Cada afirmación permisiva viene con su contrapeso sobre una ruta de dinero.
 *   - §5 y §8 miden la puerta pública: qué corre de verdad, con la ruta que le pasa el cliente.
 *
 * El precio del DEFAULT sin ruta —el que se aplica si alguien llama al clasificador a pelo— sigue
 * medido y fijado abajo: 3 rechazos sobre 252, los tres sobres vacíos de `/v1/ancillaries/remove`.
 * Ese default falla cerrado a propósito y por eso el número no es cero: olvidar la ruta no puede
 * fabricar una reserva fantasma.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import {
  SABRE_APPLICATION_RESULTS_PATHS,
  SABRE_EMPTY_BODY_SUCCESS_PATHS,
  SABRE_ISSUE_NOT_VERIFIABLE,
  SabreApiError,
  classifySabreEnvelope,
  sabreOperationToken,
} from './errors';
import { SabreHttpClient, isNonIdempotentSabrePath } from './http/sabre-http.client';

/* ──────────────────────────────────────────────────────────────────────────────
 * Arnés de la puerta pública (mismo que el resto de la familia)
 * ────────────────────────────────────────────────────────────────────────────── */

const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';
const REMOVE_ANCILLARIES_PATH = '/v1/ancillaries/remove';
const HOTEL_AVAIL_PATH = '/v5/get/hotelavail';
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

type Settled = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: unknown };

/**
 * `rejects.toBeInstanceOf` pasaría igual si el cliente reventara con un `TypeError`. Aquí se
 * distingue resolver de lanzar, y lanzar-otra-cosa es fallo.
 */
async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return { kind: 'resolved', value: await promise };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

async function post(payload: unknown, path = CREATE_BOOKING_PATH): Promise<Settled> {
  const fetchImpl = ((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as SabreFetch;
  const client = new SabreHttpClient(config(), fakeTokens(), {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  return settle(client.postJson(path, {}));
}

/* ──────────────────────────────────────────────────────────────────────────────
 * El corpus: los ejemplos oficiales de los 21 contratos
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Se leen los `.yml` en tiempo de test, no se copian aquí: copiarlos dejaría dos originales
 * divergiendo, que es contra lo que existe `spec-manifest.test.ts` (RNF-15).
 *
 * No hay parser de YAML en el monorepo y meter uno para esto cargaría 3,9 MB de esquemas. Lo que
 * se necesita es mucho menos: los ejemplos son BLOQUES JSON literales colgando de `value:` /
 * `example:`, y la cadena de claves ancestro se reconstruye por indentación. Es suficiente para
 * saber si un bloque es un ejemplo con nombre (`components.examples.X.value`) y desde qué
 * operación lo cita `paths:`.
 */

interface CorpusItem {
  readonly src: string;
  readonly line: number;
  readonly name: string;
  /** Ruta de la operación que cita el ejemplo, si el `.yml` la declara. */
  readonly opPath: string | undefined;
  /** `contract` = citado desde una respuesta `'200'`; `docs` = ejemplo suelto o documentación. */
  readonly tier: 'contract' | 'docs';
  readonly payload: unknown;
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

const SPEC_DIR = join(findRepoRoot(), 'docs', 'sabre', 'evidence', 'specs');

const indentOf = (line: string): number => (/^(\s*)/.exec(line)?.[1] ?? '').length;

/** Cadena de claves ancestro: se camina hacia atrás por niveles de indentación decrecientes. */
function ancestors(lines: readonly string[], index: number): string[] {
  const chain: string[] = [];
  let want = indentOf(lines[index] ?? '');
  for (let j = index - 1; j >= 0; j -= 1) {
    const line = lines[j] ?? '';
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    if (ind >= want) continue;
    const key = /^\s*(?:-\s*)?(['"]?)([^:]+?)\1\s*:/.exec(line);
    chain.unshift(key?.[2]?.trim() ?? '-');
    want = ind;
    if (want === 0) break;
  }
  return chain;
}

/** Todo lo que cuelga (más indentado) de la línea `index`. */
function blockUnder(lines: readonly string[], index: number): string {
  const base = indentOf(lines[index] ?? '');
  const out: string[] = [];
  for (let j = index + 1; j < lines.length; j += 1) {
    const line = lines[j] ?? '';
    if (line.trim().length === 0) {
      out.push('');
      continue;
    }
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out.join('\n');
}

function parseObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `basePath` del contrato: swagger 2.0 lo pone en raíz, OpenAPI 3 en `servers.variables`. */
function basePathOf(lines: readonly string[]): string {
  for (let i = 0; i < lines.length; i += 1) {
    const flat = /^basePath:\s*(\S+)\s*$/.exec(lines[i] ?? '');
    if (flat) return flat[1] === '/' ? '' : (flat[1] ?? '');
    if (/^\s{4,}basePath:\s*$/.test(lines[i] ?? '')) {
      const def = /default:\s*'?([^'\s]+)'?/.exec(lines[i + 1] ?? '');
      if (def) return def[1] ?? '';
    }
  }
  return '';
}

/**
 * Un ejemplo es «de error declarado» si el contrato lo etiqueta como tal o si su propio payload
 * trae un portador de problemas con contenido. La segunda mitad es la importante: la etiqueta la
 * escribe un humano y a veces falta, el payload no miente.
 */
const ERROR_LABEL =
  /\[error\]|\[warning\]|error\s*response|errorresponse|failure|invalid|unable to|unauthor/i;

function declaresProblem(payload: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const token = key.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const empty =
        child === null ||
        child === undefined ||
        (Array.isArray(child) && child.length === 0) ||
        (typeof child === 'string' && child.trim().length === 0) ||
        (typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0);
      const carrier =
        token.endsWith('ERROR') ||
        token.endsWith('ERRORS') ||
        token.endsWith('WARNING') ||
        token.endsWith('WARNINGS') ||
        token === 'FAULT' ||
        token === 'EXCEPTION';
      if (!empty && carrier) return true;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(payload);
}

function walkFiles(root: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function collectCorpus(): CorpusItem[] {
  const items: CorpusItem[] = [];

  for (const file of readdirSync(SPEC_DIR).filter((name) => name.endsWith('.yml'))) {
    const lines = readFileSync(join(SPEC_DIR, file), 'utf8').split(/\r?\n/);
    const base = basePathOf(lines);

    // Dónde cita `paths:` cada ejemplo con nombre, y si lo cita desde una respuesta `'200'`.
    const opByName = new Map<string, string>();
    const successRefs = new Set<string>();
    for (let i = 0; i < lines.length; i += 1) {
      const ref = /\$ref:\s*['"]#\/components\/examples\/([^'"]+)['"]/.exec(lines[i] ?? '');
      if (!ref?.[1]) continue;
      const chain = ancestors(lines, i);
      if (chain[0] === 'paths' && chain[1]?.startsWith('/')) opByName.set(ref[1], base + chain[1]);
      const responses = chain.indexOf('responses');
      const label = chain[chain.length - 1] ?? '';
      if (responses >= 0 && chain[responses + 1] === '200' && !ERROR_LABEL.test(label))
        successRefs.add(ref[1]);
    }

    for (let i = 0; i < lines.length; i += 1) {
      const kv = /^\s*(value|example)\s*:\s*(.*)$/.exec(lines[i] ?? '');
      if (!kv) continue;
      const inline = (kv[2] ?? '').trim();
      const payload = parseObject(inline.length > 0 ? inline : blockUnder(lines, i));
      if (payload === undefined) continue;

      const chain = ancestors(lines, i);
      const named =
        chain[0] === 'components' && chain[1] === 'examples' && chain.length === 3
          ? chain[2]
          : undefined;
      const label = named ?? chain[chain.length - 1] ?? '';
      if (ERROR_LABEL.test(label) || declaresProblem(payload)) continue;

      items.push({
        src: file,
        line: i + 1,
        name: label,
        opPath: named === undefined ? undefined : opByName.get(named),
        tier: named !== undefined && successRefs.has(named) ? 'contract' : 'docs',
        payload,
      });
    }
  }

  // La documentación oficial (`help/`) trae más sobres reales que los propios `.yml`: bloques JSON
  // pegados bajo un encabezado. Se toman todos los que parsean y no declaran problemas.
  for (const path of walkFiles(join(SPEC_DIR, 'help'))) {
    if (!/\.(txt|json)$/.test(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*[{[]\s*$/.test(lines[i] ?? '')) continue;
      let depth = 0;
      let end = -1;
      for (let j = i; j < lines.length; j += 1) {
        for (const ch of lines[j] ?? '') {
          if (ch === '{' || ch === '[') depth += 1;
          else if (ch === '}' || ch === ']') depth -= 1;
        }
        if (depth <= 0) {
          end = j;
          break;
        }
      }
      if (end < 0) continue;
      const payload = parseObject(lines.slice(i, end + 1).join('\n'));
      i = end;
      if (payload === undefined || declaresProblem(payload)) continue;
      let heading = '';
      for (let j = i - 1; j >= 0 && j > i - 8; j -= 1) {
        const text = (lines[j] ?? '').trim();
        if (text.length > 0) {
          heading = text;
          break;
        }
      }
      if (ERROR_LABEL.test(heading)) continue;
      items.push({
        src: relative(SPEC_DIR, path).split(/[\\/]/).join('/'),
        line: i + 1,
        name: heading.slice(0, 60),
        opPath: undefined,
        tier: 'docs',
        payload,
      });
    }
  }

  return items;
}

const CORPUS = collectCorpus();

function rejectedBy(item: CorpusItem, withPath: boolean): boolean {
  const path = withPath ? item.opPath : undefined;
  return !classifySabreEnvelope(item.payload, path === undefined ? {} : { path }).ok;
}

function describeItem(item: CorpusItem): string {
  return `${item.src}:${item.line} (${item.tier}) ${item.name} → ${item.opPath ?? 'sin ruta'}`;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 1. La medición de falsos positivos
 * ────────────────────────────────────────────────────────────────────────────── */

describe('falsos positivos contra los ejemplos oficiales', () => {
  it('el corpus no se puede vaciar en silencio', () => {
    // Sin este suelo, un cambio que rompa la extracción deja el test en verde con cero ejemplos y
    // la medición entera se convierte en decorado. Es el mismo riesgo que un fuzz de cero casos.
    expect(CORPUS.length).toBeGreaterThanOrEqual(250);
    expect(CORPUS.filter((item) => item.tier === 'contract').length).toBeGreaterThanOrEqual(15);
    expect(new Set(CORPUS.map((item) => item.src)).size).toBeGreaterThanOrEqual(15);
    expect(CORPUS.filter((item) => item.opPath !== undefined).length).toBeGreaterThanOrEqual(40);
  });

  it('con la ruta de su operación, CERO ejemplos oficiales se rechazan', () => {
    const rejected = CORPUS.filter((item) => rejectedBy(item, true)).map(describeItem);
    expect(rejected).toEqual([]);
  });

  it('sin la ruta, el precio exacto son los tres sobres vacíos de /v1/ancillaries/remove', () => {
    // Éste es el número que hay que mirar cuando alguien endurezca el clasificador otra vez: si
    // sube, el endurecimiento se está pagando con resultados que el vendedor no va a ver.
    //
    // No es cero y no debe serlo: éste es el DEFAULT sin contexto, que falla cerrado. Lo que mide
    // es cuánto cuesta olvidarse de la ruta, no lo que corre en producción — eso lo mide el test
    // de abajo, que sí pasa por `postJson`.
    const rejected = CORPUS.filter((item) => rejectedBy(item, false));
    expect(rejected.map(describeItem).sort()).toEqual([
      'manage-ancillary-1.1.yml:837 (contract) RemoveAncillariesWithSeatsResponse → /v1/ancillaries/remove',
      'manage-ancillary-1.1.yml:862 (contract) RemoveSeatsResponse → /v1/ancillaries/remove',
      'manage-ancillary-1.1.yml:887 (contract) RemoveAncillariesResponse → /v1/ancillaries/remove',
    ]);
    for (const item of rejected) expect(item.payload).toEqual({});
  });

  /**
   * La misma medición, pero por donde corre: `postJson` con la ruta que el ACL le pasa.
   *
   * Antes del cableado esta medición no se podía hacer —el cliente descartaba la ruta y el corpus
   * habría acusado los mismos 3 falsos positivos aunque la política fuera perfecta—, y por eso el
   * agujero sobrevivió a una ronda entera con todo verde. Ahora los dos números tienen que
   * coincidir; el día que dejen de coincidir es que alguien desconectó el contexto otra vez.
   */
  it('por la puerta pública y con la ruta de su operación, CERO ejemplos oficiales se rechazan', async () => {
    const rejected: string[] = [];
    for (const item of CORPUS) {
      if (item.opPath === undefined) continue;
      const outcome = await post(item.payload, item.opPath);
      if (outcome.kind === 'rejected') rejected.push(describeItem(item));
    }
    expect(rejected).toEqual([]);
  });

  it('los tres sobres vacíos que costaba el cableado ausente ya se entregan por postJson', async () => {
    // Las tres líneas exactas del contrato que pagaban el precio. Reapuntadas: dejaron de ser el
    // coste de la ronda 7 y pasaron a ser la prueba de que el contexto llega hasta el clasificador.
    const empties = CORPUS.filter(
      (item) => item.opPath === REMOVE_ANCILLARIES_PATH && rejectedBy(item, false),
    );
    expect(empties.map(describeItem).sort()).toEqual([
      'manage-ancillary-1.1.yml:837 (contract) RemoveAncillariesWithSeatsResponse → /v1/ancillaries/remove',
      'manage-ancillary-1.1.yml:862 (contract) RemoveSeatsResponse → /v1/ancillaries/remove',
      'manage-ancillary-1.1.yml:887 (contract) RemoveAncillariesResponse → /v1/ancillaries/remove',
    ]);
    for (const item of empties) {
      expect(item.payload, describeItem(item)).toEqual({});
      const outcome = await post(item.payload, REMOVE_ANCILLARIES_PATH);
      expect(outcome.kind, describeItem(item)).toBe('resolved');
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 2. El cuerpo vacío: excepción del CONTRATO, no relajación global
 * ────────────────────────────────────────────────────────────────────────────── */

describe('el cuerpo vacío sólo es éxito donde el contrato lo declara', () => {
  it('la lista de operaciones es cerrada y contiene sólo /remove', () => {
    expect([...SABRE_EMPTY_BODY_SUCCESS_PATHS]).toEqual([REMOVE_ANCILLARIES_PATH]);
  });

  it('`{}` es éxito en /v1/ancillaries/remove', () => {
    expect(classifySabreEnvelope({}, { path: REMOVE_ANCILLARIES_PATH }).ok).toBe(true);
  });

  it('`{}` NO es éxito en createBooking, que es para lo que existe la regla', () => {
    const verdict = classifySabreEnvelope({}, { path: CREATE_BOOKING_PATH });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.category).toBe(SABRE_ISSUE_NOT_VERIFIABLE);
  });

  it('`{}` NO es éxito en las hermanas /add y /exchange, que sí declaran datos', () => {
    // `AddAncillariesResponse` y `ExchangeAncillariesResponse` declaran `ancillaryDetails`
    // (`manage-ancillary-1.1.yml:920-960`): ahí un `{}` es un fallo silencioso, no un éxito.
    expect(classifySabreEnvelope({}, { path: '/v1/ancillaries/add' }).ok).toBe(false);
    expect(classifySabreEnvelope({}, { path: '/v1/ancillaries/exchange' }).ok).toBe(false);
  });

  it('sin ruta el default es el estricto: `{}` se rechaza', () => {
    expect(classifySabreEnvelope({}).ok).toBe(false);
    expect(classifySabreEnvelope({}, {}).ok).toBe(false);
  });

  it('la excepción es de un objeto vacío, no de todo lo "demostrablemente ausente"', () => {
    // El contrato publica `{ }`. Un array vacío, un escalar o `null` no son esa forma, y no hay
    // razón para regalarles el 200 sólo por caer en el mismo `isProvablyAbsent`.
    for (const payload of [[], 'OK', '', 0, false, null, undefined, 42, true]) {
      expect(classifySabreEnvelope(payload, { path: REMOVE_ANCILLARIES_PATH }).ok).toBe(false);
    }
  });

  it('un /remove con contenido se sigue clasificando entero', () => {
    const verdict = classifySabreEnvelope(
      { errors: [{ category: 'APPLICATION_ERROR', type: 'PROCESSING_ERROR' }] },
      { path: REMOVE_ANCILLARIES_PATH },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.category).toBe('APPLICATION_ERROR');
  });

  it('la excepción sobrevive a la query y a la barra final, y no a un prefijo cualquiera', () => {
    expect(classifySabreEnvelope({}, { path: `${REMOVE_ANCILLARIES_PATH}?pcc=ZZZZ` }).ok).toBe(
      true,
    );
    expect(classifySabreEnvelope({}, { path: `${REMOVE_ANCILLARIES_PATH}/` }).ok).toBe(true);
    expect(classifySabreEnvelope({}, { path: '/V1/ANCILLARIES/REMOVE' }).ok).toBe(true);
    expect(classifySabreEnvelope({}, { path: '/v1/ancillaries/remove-all' }).ok).toBe(false);
    expect(classifySabreEnvelope({}, { path: '/v1/ancillaries/removex' }).ok).toBe(false);
    expect(classifySabreEnvelope({}, { path: '/remove' }).ok).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 3. La benignidad la concede el contrato de la operación, no la forma suelta
 * ────────────────────────────────────────────────────────────────────────────── */

/** `ApplicationResults.Success` con un mensaje sin severidad declarada dentro del portador. */
const SUCCESS_CARRYING_MESSAGE = {
  ApplicationResults: {
    status: 'Complete',
    Success: [{ SystemSpecificResults: [{ Message: [{ content: 'Booking failed' }] }] }],
  },
};

describe('ApplicationResults.Success sólo concede benignidad donde el contrato lo declara', () => {
  it('las ocho operaciones son las de los ocho contratos que declaran ApplicationResults', () => {
    // Los ocho son LECTURAS de inventario. Ninguna operación de dinero declara la forma.
    expect([...SABRE_APPLICATION_RESULTS_PATHS].sort()).toEqual([
      '/v1.0.0/get/vehavail',
      '/v2.0.0/get/hoteldetails',
      '/v2.0.0/get/vehavail',
      '/v3.0.0/get/hotelavail',
      '/v4.0.0/get/hotelavail',
      '/v4.0.0/hotel/pricecheck',
      '/v5/get/hotelavail',
      '/v5/hotel/pricecheck',
    ]);
    for (const path of SABRE_APPLICATION_RESULTS_PATHS) {
      expect(isNonIdempotentSabrePath(path)).toBe(false);
    }
  });

  it('en una lectura de hoteles el mensaje sin severidad hereda benignidad', () => {
    expect(classifySabreEnvelope(SUCCESS_CARRYING_MESSAGE, { path: HOTEL_AVAIL_PATH }).ok).toBe(
      true,
    );
  });

  it('el MISMO sobre en una operación de dinero se rechaza', () => {
    // `booking-management-v1.yml` no menciona `ApplicationResults` en ningún sitio: esa forma
    // llegando en un `createBooking` no es una respuesta de hoteles, es eco de un tercero, y no
    // puede apagar el recorrido de su subárbol.
    for (const path of [
      CREATE_BOOKING_PATH,
      '/v1/trip/orders/fulfillFlightTickets',
      '/v1/trip/orders/refundFlightTickets',
      REMOVE_ANCILLARIES_PATH,
      '/v5/offers/shop',
    ]) {
      expect(classifySabreEnvelope(SUCCESS_CARRYING_MESSAGE, { path }).ok).toBe(false);
    }
  });

  it('sin ruta se mantiene el comportamiento medido de las seis rondas anteriores', () => {
    // Este eje sólo APRIETA cuando hay contexto. Denegar por defecto convertiría cada búsqueda de
    // hotel en un error mientras nadie pase la ruta: sería cambiar un falso positivo medido de
    // 3/252 por uno masivo y no medido.
    expect(classifySabreEnvelope(SUCCESS_CARRYING_MESSAGE).ok).toBe(true);
  });

  it('quitar la benignidad no toca lo que ya se rechazaba dentro de Success', () => {
    // La clave que no declara el contrato dentro de `Success[]` seguía cortando el contexto: eso
    // es la ronda 4 y sigue en pie con y sin ruta.
    const outsideCarrier = {
      ApplicationResults: { Success: [{ wrapper: { messages: [{ content: 'Booking failed' }] } }] },
    };
    expect(classifySabreEnvelope(outsideCarrier).ok).toBe(false);
    expect(classifySabreEnvelope(outsideCarrier, { path: HOTEL_AVAIL_PATH }).ok).toBe(false);
  });

  it('un error declarado dentro de Success se rechaza también en la lectura que sí lo declara', () => {
    const declared = {
      ApplicationResults: {
        Success: [{ SystemSpecificResults: [{ Message: [{ code: 'ERR.0161' }] }] }],
      },
    };
    expect(classifySabreEnvelope(declared, { path: HOTEL_AVAIL_PATH }).ok).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 4. PUERTA PÚBLICA — el sufijo `*ProcessingStatus`, que no lo fijaba ningún test
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * `envelopeKeyKind` trata como estado cualquier clave que termine en `PROCESSINGSTATUS`. Borrar
 * esa mitad de la condición dejaba los 719 tests en verde: los dos casos que la mencionaban
 * (`errors.status-subtree.regression.test.ts` S4 y S6) meten un `errors[]`/`warnings[]` DENTRO del
 * objeto, y eso lo encuentra el descenso, no el anotador de estado. Lo que nadie medía es el
 * escalar: `{orderProcessingStatus:'NotProcessed'}` es un fallo declarado por el proveedor y sin
 * el sufijo cae en `neutral`, o sea en RESERVA CONFIRMADA.
 *
 * La clave no sale de ningún `.yml` —ninguno de los 21 la usa— y por eso no puede producir un
 * falso positivo contra el corpus: es defensa por variante de nombre, y el corpus de arriba lo
 * confirma con 0 rechazos.
 */

describe('el sufijo *ProcessingStatus, por la puerta pública', () => {
  const NOT_COMPLETE = ['NotProcessed', 'Incomplete', 'Unknown'] as const;

  for (const value of NOT_COMPLETE) {
    it(`{ProcessingStatus:'${value}'} no es una reserva confirmada`, async () => {
      const outcome = await post({ ProcessingStatus: value });
      expect(outcome.kind).toBe('rejected');
      expect(outcome.kind === 'rejected' ? outcome.error : undefined).toBeInstanceOf(SabreApiError);
    });

    it(`{orderProcessingStatus:'${value}'} tampoco, con la clave prefijada`, async () => {
      const outcome = await post({ orderProcessingStatus: value });
      expect(outcome.kind).toBe('rejected');
    });

    it(`{status:'${value}'} sigue rechazándose (la otra mitad de la condición)`, async () => {
      const outcome = await post({ status: value });
      expect(outcome.kind).toBe('rejected');
    });
  }

  it('los issues nombran el estado, no un genérico', async () => {
    const outcome = await post({ ticketingProcessingStatus: 'Incomplete' });
    const error = outcome.kind === 'rejected' ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SabreApiError);
    expect((error as SabreApiError).issues.map((issue) => issue.category)).toContain(
      'STATUS_INCOMPLETE',
    );
  });

  it('`Complete` y las claves que sólo CONTIENEN el token siguen pasando', async () => {
    // El contrapeso del falso positivo: la regla compara el sufijo, no una subcadena. Una clave
    // como `processingStatusText` no es el enum y no puede tumbar una respuesta legítima.
    for (const payload of [
      { ProcessingStatus: 'Complete' },
      { orderProcessingStatus: 'Complete' },
      { processingStatusText: 'Unknown' },
      { processingStatusDetails: 'Incomplete' },
    ]) {
      const outcome = await post(payload);
      expect(outcome.kind).toBe('resolved');
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 5. PUERTA PÚBLICA — lo que corre HOY no se ha aflojado
 * ────────────────────────────────────────────────────────────────────────────── */

describe('la puerta pública conserva el default estricto', () => {
  /**
   * Este test ERA la medición honesta de que el cableado faltaba: mientras `postJson` descartaba la
   * ruta, `{}` se rechazaba en las tres. Se pone rojo en cuanto el cliente pasa la ruta, y por eso
   * se reapunta en vez de borrarse — la afirmación que vale ahora es más fuerte que la de antes:
   * la excepción existe en UNA operación y en ninguna otra, y quien la mide es la puerta pública.
   */
  it('el sobre vacío sólo se acepta en la operación cuyo contrato lo declara', async () => {
    const accepted: string[] = [];
    for (const path of [
      CREATE_BOOKING_PATH,
      REMOVE_ANCILLARIES_PATH,
      HOTEL_AVAIL_PATH,
      SHOP_PATH,
      '/v1/ancillaries/add',
      '/v1/ancillaries/exchange',
      '/v1/trip/orders/cancelBooking',
      '/',
    ]) {
      if ((await post({}, path)).kind === 'resolved') accepted.push(path);
    }
    expect(accepted).toEqual([REMOVE_ANCILLARIES_PATH]);
  });

  it('la excepción es del objeto vacío y de nada más, tampoco en /remove', async () => {
    // El contrato publica `{ }`. Un array vacío, un escalar o `null` no son esa forma, y regalarles
    // el 200 sólo por caer en el mismo `isProvablyAbsent` es ampliar la excepción por descuido.
    for (const path of [CREATE_BOOKING_PATH, REMOVE_ANCILLARIES_PATH, HOTEL_AVAIL_PATH]) {
      for (const payload of [[], 'OK', '', 0, false]) {
        const outcome = await post(payload, path);
        expect(outcome.kind, `${path} ${JSON.stringify(payload)}`).toBe('rejected');
      }
    }
  });

  it('un /remove con problemas dentro se sigue clasificando entero por postJson', async () => {
    // La excepción es «sin errores no queda nada que devolver», no «este endpoint no se mira».
    const outcome = await post(
      { errors: [{ category: 'APPLICATION_ERROR', type: 'PROCESSING_ERROR' }] },
      REMOVE_ANCILLARIES_PATH,
    );

    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' ? outcome.error : undefined).toBeInstanceOf(SabreApiError);
  });

  it('un sobre con datos reales sigue resolviendo', async () => {
    const outcome = await post({ groupedItineraryResponse: { version: '5' } }, '/v5/offers/shop');
    expect(outcome.kind).toBe('resolved');
  });

  it('el identificador escalar de un problema sigue llegando al issue (ronda 6)', async () => {
    const outcome = await post({ errors: 'ERR.0161' });
    const error = outcome.kind === 'rejected' ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SabreApiError);
    expect((error as SabreApiError).issues.map((issue) => issue.code)).toContain('ERR.0161');
  });

  it('la guarda de profundidad sigue rechazando el sobre patológico (ronda 6)', async () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 80; i += 1) deep = { wrap: deep };
    const outcome = await post(deep, '/v5/offers/shop');
    expect(outcome.kind).toBe('rejected');
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 6. PUERTA PÚBLICA — un warning no salda la deuda de una clave de error
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Hallazgo del fuzz independiente de esta ronda, y es el patrón fail-open de siempre visto desde
 * abajo: la guarda que existe para que una clave de problema con contenido no se quede sin issue
 * («había algo bajo `errors` y no salió nada») se conformaba con CUALQUIER issue. Un warning
 * emitido por otra clave dentro del subárbol la satisfacía.
 *
 * La sonda que lo demuestra son dos sobres equivalentes —los dos tienen la clave `errors` con
 * contenido— con veredictos opuestos, y el ACEPTADO era el que además decía explícitamente que
 * hubo un problema. La política ya estaba escrita en `worstSeverity`: en un conflicto gana la más
 * grave. Aquí el subárbol degradaba a su padre.
 */

describe('una clave de error no se salda con un warning del subárbol', () => {
  const EQUIVALENTES: ReadonlyArray<readonly [string, unknown]> = [
    ['P1. errors con contenido opaco (ya se rechazaba)', { errors: { data: 'x' } }],
    [
      'P2. errors cuyo subárbol sólo produjo un warning',
      { errors: { warnings: [{ category: 'X' }] } },
    ],
    ['P3. fault con un warning dentro', { fault: { warning: { code: 'WARN.1' } } }],
    [
      'P4. errorDetails con un Message de severidad Warning',
      { errorDetails: { messages: [{ severity: 'Warning' }] } },
    ],
    ['P5. errorCode objeto con un warning colgando', { errorCode: { warning: 'x' } }],
    [
      'P6. processingError cuyo subárbol degrada',
      { processingError: { detail: { warnings: ['aviso'] } } },
    ],
  ];

  for (const [name, payload] of EQUIVALENTES) {
    it(`${name} — nunca es una reserva confirmada`, async () => {
      const outcome = await post(payload);
      expect(outcome.kind).toBe('rejected');
      const error = outcome.kind === 'rejected' ? outcome.error : undefined;
      expect(error).toBeInstanceOf(SabreApiError);
      expect((error as SabreApiError).issues.some((issue) => issue.severity === 'error')).toBe(
        true,
      );
    });
  }

  it('la clave de WARNING sí se conforma con cualquier issue', async () => {
    // Un error dentro de `warnings` ya escala por `worstSeverity`; contarlo dos veces no añade
    // nada y sí añadiría un issue opaco de ruido en cada sobre de hoteles con avisos.
    const outcome = await post({ warnings: { errors: [{ category: 'APPLICATION_ERROR' }] } });
    expect(outcome.kind).toBe('rejected');
    const error = outcome.kind === 'rejected' ? outcome.error : undefined;
    expect((error as SabreApiError).issues.map((issue) => issue.category)).toEqual([
      'APPLICATION_ERROR',
    ]);
  });

  it('un warning limpio sigue resolviendo, con su warning en el resultado', async () => {
    // El contrapeso: esto es lo que hace un sobre real de hoteles con un aviso del proveedor de
    // fondo, y tiene que seguir entregándose.
    const outcome = await post({ warnings: [{ category: 'AVISO', severity: 'Warning' }] });
    expect(outcome.kind).toBe('resolved');
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 7. Anti-deriva: una sola normalización de rutas
 * ────────────────────────────────────────────────────────────────────────────── */

describe('la normalización de rutas no tiene dos copias divergentes', () => {
  /**
   * `isNonIdempotentSabrePath` (cliente HTTP) y `sabreOperationToken` (aquí) hacen hoy la misma
   * normalización con código distinto: quitar query, quitar barras finales, minúsculas. Dos copias
   * de la misma regla es el patrón que ya costó un incidente en este paquete (`asRecord`/`str`).
   * Mientras el cliente no pase a usar la canónica, este test es lo que impide que diverjan en
   * silencio.
   *
   * **Ya divergen en un caso, y no se fija aquí porque el arreglo está en el otro fichero:** la
   * copia del cliente parte sólo por `?`, así que un `#` en la ruta la deja sin reconocer el path
   * de dinero y `postJson` volvería a permitir reintentos de una escritura. La canónica parte por
   * `[?#]`, igual que `safeErrorPath` en este mismo fichero. Por eso el barrido de abajo excluye
   * los fragmentos: pinear el comportamiento roto lo volvería rojo el día que se arregle.
   */
  const PATHS = [
    '/v1/trip/orders/createBooking',
    '/v1/trip/orders/createBooking/',
    '/v1/trip/orders/createBooking//',
    '/v1/trip/orders/createBooking?pcc=ZZZZ',
    '/V1/TRIP/ORDERS/CREATEBOOKING',
    '/v1/trip/orders/createBookingX',
    '/v1/trip/orders/modifyBooking',
    '/v5/offers/shop',
    '/v1/ancillaries/remove',
    '',
    '/',
  ];

  for (const path of PATHS) {
    it(`coinciden sobre ${JSON.stringify(path)}`, () => {
      const token = sabreOperationToken(path);
      const viaToken = ['/v1/trip/orders/createbooking', '/v1/trip/orders/modifybooking'].some(
        (known) => token.endsWith(known),
      );
      expect(viaToken).toBe(isNonIdempotentSabrePath(path));
    });
  }

  it('la canónica corta el fragmento, que es lo que la query ya hacía', () => {
    expect(sabreOperationToken('/v1/ancillaries/remove#tramo')).toBe('/v1/ancillaries/remove');
    expect(sabreOperationToken('/v1/ancillaries/remove?a=1#tramo')).toBe('/v1/ancillaries/remove');
    expect(classifySabreEnvelope({}, { path: '/v1/ancillaries/remove#tramo' }).ok).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 8. EL CABLEADO — que la ruta llegue al clasificador
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Lo que faltaba, y lo que nadie fijaba. Los dos ejes de esta ronda se escribieron enteros, con
 * sus listas derivadas de los `.yml` y sus tests verdes, sobre un llamador que invocaba
 * `classifySabreEnvelope(payload)` a secas. Todo el trabajo era inalcanzable en producción y la
 * suite no tenía forma de decirlo: sin ruta el clasificador cae al modo estricto, que es
 * fail-closed, así que nada explota — simplemente el eje no existe.
 *
 * Es la ronda 2 otra vez (347 tests verdes sobre un clasificador que nadie invocaba) en pequeño, y
 * la lección es la misma: **una política sin un test que la ate a su sitio de llamada es
 * documentación**. Se fija por dos vías que fallan por separado:
 *
 *   (1) COMPORTAMIENTO. Dos pares de sobres idénticos cuyo único cambio es la ruta y cuyo
 *       veredicto se invierte. Ninguna otra cosa del cliente puede producir esa diferencia: si el
 *       argumento se cae, o si alguien lo sustituye por una constante, los dos pares colapsan.
 *   (2) ESTRUCTURA. La única línea de clasificación de la fuente pasa el `path` que recibió, no
 *       otra cosa. El comportamiento demuestra que HOY llega; la estructura es lo que impide que
 *       vuelva a desaparecer en un refactor sin que ningún test se entere.
 */

/** Sobre bueno de hoteles: sólo la operación decide si su `Success[]` concede algo. */
const HOTEL_SUCCESS_ENVELOPE = {
  ApplicationResults: {
    status: 'Complete',
    Success: [{ SystemSpecificResults: [{ Message: [{ content: 'Search completed' }] }] }],
  },
};

describe('el cableado (1) — la ruta llega al clasificador, medido por comportamiento', () => {
  it('el mismo `{}` se invierte según la operación, que es lo único que cambia', async () => {
    expect((await post({}, REMOVE_ANCILLARIES_PATH)).kind).toBe('resolved');
    expect((await post({}, SHOP_PATH)).kind).toBe('rejected');
  });

  it('el mismo ApplicationResults.Success se invierte según la operación', async () => {
    expect((await post(HOTEL_SUCCESS_ENVELOPE, HOTEL_AVAIL_PATH)).kind).toBe('resolved');
    expect((await post(HOTEL_SUCCESS_ENVELOPE, CREATE_BOOKING_PATH)).kind).toBe('rejected');
  });

  it('la ruta que llega es la que se pasó, no una constante ni la primera de la lista', async () => {
    // Un cableado que pasara siempre `SABRE_EMPTY_BODY_SUCCESS_PATHS[0]` pasaría el primer test.
    // Aquí se barren las ocho lecturas y las rutas de dinero: cada una tiene que decidir por sí
    // misma, y las ocho tienen que coincidir con lo que declara su contrato.
    for (const path of SABRE_APPLICATION_RESULTS_PATHS) {
      expect((await post(HOTEL_SUCCESS_ENVELOPE, path)).kind, path).toBe('resolved');
      expect((await post({}, path)).kind, path).toBe('rejected');
    }
    for (const path of [CREATE_BOOKING_PATH, '/v1/trip/orders/voidFlightTickets', SHOP_PATH]) {
      expect((await post(HOTEL_SUCCESS_ENVELOPE, path)).kind, path).toBe('rejected');
    }
  });

  it('la normalización también llega: query, fragmento, barra final y mayúsculas', async () => {
    // Si el cliente pasara la ruta CRUDA a una comparación literal, cualquiera de estas cuatro
    // formas —todas legítimas cuando alguien construye la URL a mano— perdería la excepción.
    for (const path of [
      `${REMOVE_ANCILLARIES_PATH}?pcc=ZZZZ`,
      `${REMOVE_ANCILLARIES_PATH}#tramo`,
      `${REMOVE_ANCILLARIES_PATH}/`,
      REMOVE_ANCILLARIES_PATH.toUpperCase(),
    ]) {
      expect((await post({}, path)).kind, path).toBe('resolved');
    }
  });
});

/**
 * Fuente del cliente HTTP sin comentarios: un `classifySabreEnvelope(...)` citado en prosa no puede
 * hacer pasar —ni suspender— el recuento de sitios de llamada. No hay `//` dentro de literales en
 * ese fichero, así que basta con quitar comentarios.
 */
const CLIENT_SOURCE = readFileSync(
  join(findRepoRoot(), 'providers', 'sabre', 'src', 'http', 'sabre-http.client.ts'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

/** Los argumentos de la llamada a `name(`, con los paréntesis emparejados. */
function callArgs(source: string, name: string): string {
  const at = source.indexOf(`${name}(`);
  expect(at, `no se encontró la llamada a ${name}`).toBeGreaterThanOrEqual(0);
  const open = at + name.length;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`llamada sin cerrar a ${name}`);
}

describe('el cableado (2) — la estructura que impide que vuelva a desaparecer', () => {
  it('el cliente HTTP tiene un solo sitio de clasificación', () => {
    // Dos sitios es cómo este paquete acabó con dos clasificadores en la ronda 2, y entonces uno
    // de los dos se queda sin contexto y nadie lo nota.
    expect(CLIENT_SOURCE.split('classifySabreEnvelope(').length - 1).toBe(1);
  });

  it('ese sitio pasa el contexto de la operación, y el contexto lleva el path', () => {
    const args = callArgs(CLIENT_SOURCE, 'classifySabreEnvelope');
    expect(args, 'la llamada no pasa segundo argumento').toContain(',');
    expect(args.replace(/\s+/g, '')).toContain('{path}');
  });

  it('el `path` que pasa es el parámetro del método, no una constante del módulo', () => {
    // La clasificación vive dentro de `attempt(path, …)`, que recibe el mismo `path` que
    // `postJson`. Se comprueban las tres cosas que hacen que ese `path` sea el de la llamada: que
    // la firma lo declare, que la clasificación esté dentro del método, y que nadie lo reasigne
    // por el camino — un `path = SOME_CONSTANT` intermedio pasaría los tests de comportamiento
    // de arriba sólo si la constante fuera la ruta correcta, y dejaría de pasarlos para el resto.
    const at = CLIENT_SOURCE.indexOf('private async attempt<T>(');
    expect(at, 'no se encontró el método que clasifica').toBeGreaterThanOrEqual(0);
    const attempt = CLIENT_SOURCE.slice(at);

    expect(attempt.slice(0, attempt.indexOf(')')).replace(/\s+/g, '')).toContain('path:string');

    const callAt = attempt.indexOf('classifySabreEnvelope(');
    expect(callAt, 'la clasificación no está dentro de `attempt`').toBeGreaterThan(0);
    expect(attempt.slice(0, callAt)).not.toMatch(/\bpath\s*=[^=]/);
  });
});
