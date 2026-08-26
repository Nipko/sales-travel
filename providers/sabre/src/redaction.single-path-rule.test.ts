import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';

/**
 * UNA sola implementación de la política de rutas, y un guard que se pone rojo si vuelve a haber dos.
 *
 * Historia, porque explica por qué este fichero existe en vez de un comentario: la regla —«conservar
 * la ruta, tirar la query y el fragmento, tapar las formas que sí se pueden confirmar»— vivió dos
 * veces. `redactPath` en `redaction.ts` y `safeErrorPath` en `errors.ts`. El informe de la ronda 5
 * declaró los duplicados consolidados; para éste era FALSO —lo que se hizo fue extraer `redactPath`
 * y DEJAR la copia— y durante una ronda entera hubo además un comentario afirmando en pasado algo
 * que no había ocurrido.
 *
 * Y la copia ya había divergido: no aplicaba NINGUNA pasada por forma, así que un `Bearer`, un JWT o
 * el `secret` de Sabre metidos en un segmento de ruta llegaban enteros a `error.path` y a
 * `error.message`. Es la forma exacta del incidente de la ronda 2 (dos implementaciones de la misma
 * política de seguridad, y la que corría en producción era la débil).
 *
 * El guard tiene tres capas y hacen falta las tres:
 *
 * 1. **Estructural** — el símbolo no existe y la huella de la regla aparece una sola vez en la
 *    fuente. Caza la reintroducción literal, que es la que ocurrió.
 * 2. **De deriva** — las dos observaciones de la MISMA ruta cruda (`error.path` y el `path` del log)
 *    coinciden. Caza una copia escrita de otra manera, que la capa 1 no vería.
 * 3. **De comportamiento** — lo que la copia dejaba escapar sigue tapado, y lo que la copia existía
 *    para preservar sigue vivo. Es la que dice qué se pierde de verdad si el guard se cae.
 */

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

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

interface LogCall {
  message: string;
  meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    () =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ message, meta });
    };
  const logger: LoggerPort = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => logger,
  };
  return { logger, calls };
}

function clientWith(fetchImpl: SabreFetch, logger: LoggerPort): SabreHttpClient {
  return new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
}

/** La ruta tal y como sale por el camino del ERROR: `error.path`, `error.message` y el log. */
async function throughError(rawPath: string): Promise<{ error: SabreApiError; logDump: string }> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response('{"message":"oops"}', { status: 500 }));
  const { logger, calls } = spyLogger();
  const error = (await clientWith(fetchImpl, logger)
    .postJson(rawPath, {})
    .catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return { error, logDump: JSON.stringify(calls) };
}

/** La misma ruta por el camino del ÉXITO, donde sólo la mira la regla canónica vía `redactMeta`. */
async function pathLoggedOnSuccess(rawPath: string): Promise<string> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ groupedItineraryResponse: { version: '5' } }), { status: 200 }),
    );
  const { logger, calls } = spyLogger();
  await clientWith(fetchImpl, logger).postJson(rawPath, {});
  const ok = calls.find((call) => call.message === 'sabre.http.ok');
  expect(ok, 'sin sabre.http.ok no hay ruta cruda que observar').toBeDefined();
  const logged = ok?.meta?.['path'];
  expect(typeof logged, 'sabre.http.ok dejó de publicar `path`').toBe('string');
  return logged as string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Capa 1 — estructural
 * ──────────────────────────────────────────────────────────────────────────── */

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

const SRC_DIR = join(findPackageRoot(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(full);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [full];
  });
}

/**
 * La huella de CUALQUIER regla de redacción, no sólo la de rutas: para tapar algo hay que emitir
 * una marca, y las marcas son dos y están declaradas en `redaction.ts`.
 *
 * Se prefiere a la huella «corte por `?`/`#`» que se probó primero, y que era demasiado gruesa: la
 * comparte `sabreOperationToken` de `errors.ts`, que normaliza una ruta para compararla con el
 * CONTRATO —minúsculas, sin barra final— y no redacta nada. Confundir esas dos reglas habría hecho
 * el guard ruidoso, y un guard ruidoso se borra.
 *
 * La marca, en cambio, sólo la escribe quien redacta. Cubre por tanto la reintroducción de
 * `safeErrorPath` y también la de cualquier otra copia —la de la ronda 2 fue de otra regla—, que es
 * la clase entera de fallo, no el caso concreto.
 */
const REDACTION_MARKER = /\bREDACTED\b|\bFREE_TEXT\b/;

/** Un re-export no es una implementación: `index.ts` publica la marca, no la fabrica. */
const PURE_REEXPORT = /^export \{[^}]*\} from '\.\/redaction';$/;

describe('capa 1 — en la FUENTE sólo hay una implementación de la regla de ruta', () => {
  it('`safeErrorPath` ya no existe en ningún fichero de producción', () => {
    const offenders = sourceFiles(SRC_DIR).filter((file) =>
      readFileSync(file, 'utf8').includes('safeErrorPath('),
    );
    expect(
      offenders,
      'volvió a haber una segunda regla de ruta: colápsala en `redactPath` de redaction.ts',
    ).toEqual([]);
  });

  it('`errors.ts` importa la regla canónica en vez de escribirla', () => {
    const errorsSource = readFileSync(join(SRC_DIR, 'errors.ts'), 'utf8');
    expect(errorsSource).toMatch(/import \{[^}]*\bredactPath\b[^}]*\} from '\.\/redaction'/);
    // Y la usa: importarla y no llamarla sería consolidación de mentira, la misma de la ronda 5.
    expect(errorsSource).toContain('redactPath(path)');
  });

  it('ningún fichero de producción fuera de redaction.ts emite una marca de redacción', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => file !== join(SRC_DIR, 'redaction.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((line, index) => ({ file, line: line.trim(), number: index + 1 }))
          .filter((entry) => REDACTION_MARKER.test(entry.line) && !PURE_REEXPORT.test(entry.line)),
      );

    expect(
      offenders,
      'alguien volvió a escribir política de redacción fuera de redaction.ts',
    ).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Capa 2 — deriva observable
 * ──────────────────────────────────────────────────────────────────────────── */

describe('capa 2 — las dos observaciones de la misma ruta coinciden', () => {
  it.each([
    ['sin query', SHOP_PATH],
    ['con query', '/v1/trip/orders/getBookingSummary?pnr=XKCD12&passportNumber=AB1234567'],
    ['con fragmento', '/v1/trip/orders/fulfillFlightTickets#XKCD12'],
    ['con secreto en un segmento', '/v1/session/VmpFNkVQUjpQQ0M6QUE6cGFzc3dvcmQxMjM=/status'],
    ['con un JWT en un segmento', '/v1/session/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.QQ/status'],
  ])('%s: `error.path` y el `path` del log dan lo mismo', async (_name, raw) => {
    // Una copia que se escriba de otra manera —`indexOf('?')`, un `URL()`— pasaría la capa 1 y
    // moriría aquí en cuanto se comportara distinto en cualquiera de estos cinco casos.
    const { error } = await throughError(raw);
    expect(await pathLoggedOnSuccess(raw)).toBe(error.path);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Capa 3 — comportamiento: lo que la copia dejaba escapar y lo que preservaba
 * ──────────────────────────────────────────────────────────────────────────── */

describe('capa 3a — lo que la copia de errors.ts dejaba escapar', () => {
  it.each([
    ['el secret de Sabre', 'VmpFNkVQUjpQQ0M6QUE6cGFzc3dvcmQxMjM='],
    ['el clientId en claro', 'V1:500001:ZZZZ:AA'],
    ['un JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.QWxhZGRpbjpvcGVuc2VzYW1l'],
    ['un PAN', '4111111111111111'],
  ])('%s en un SEGMENTO no llega a error.path ni a error.message', async (_name, witness) => {
    const raw = `/v1/session/${witness}/status`;
    const { error, logDump } = await throughError(raw);

    // Las tres salidas del error, que es donde la copia lo publicaba entero.
    expect(error.path, 'la regla de ruta volvió a saltarse las pasadas por forma').not.toContain(
      witness,
    );
    expect(error.message).not.toContain(witness);
    expect(logDump).not.toContain(witness);
    // Se tapa el segmento, no la traza: la ruta que lo envuelve sigue ahí para diagnosticar.
    expect(error.path).toContain('/v1/session/');
    expect(error.path).toContain(REDACTED);
  });

  it('la query se va entera aunque el parámetro no esté en ninguna lista', async () => {
    // `pnr` no cae en `SECRET_KEYS` ni en `PII_KEYS`: lo que lo salva es que la query se tira
    // ENTERA en vez de enumerar lo que se salva.
    const { error, logDump } = await throughError(`${SHOP_PATH}?pnr=XKCD12&lang=es`);
    expect(error.path).toBe(`${SHOP_PATH}?${REDACTED}`);
    expect(logDump).not.toContain('XKCD12');
  });
});

describe('capa 3b — la propiedad por la que la copia existía sigue en pie', () => {
  /**
   * La copia existía por una razón REAL y hay que conservarla: una ruta no puede pasar por
   * `redactText` entero, porque `LONG_BASE64_RUN` incluye `/` en su alfabeto y se comería la ruta.
   * Si alguien "simplifica" `redactPath` a `redactText(stripUrlQuery(x))`, esto se pone rojo.
   */
  it.each(['/v1/trip/orders/getBookingSummary', '/v1/trip/orders/fulfillFlightTickets'])(
    'la ruta %s sobrevive entera en error.path',
    async (route) => {
      // La premisa, para que el test no pase por accidente: la ruta cumple las tres condiciones de
      // `LONG_BASE64_RUN`, así que `redactText` la borraría entera.
      expect(route.replace(/^\//, '')).toMatch(/^[A-Za-z0-9+/]{32,}$/);
      expect(route).toMatch(/[a-z]/);
      expect(route).toMatch(/[A-Z]/);
      expect(route).toMatch(/\d/);

      const { error } = await throughError(route);
      expect(
        error.path,
        'la ruta desapareció del error: una operación con dinero quedaría sin traza',
      ).toBe(route);
      expect(error.message).toContain(route);
    },
  );
});
