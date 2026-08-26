import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import type { CachePort, LoggerPort } from '@sales-travel/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SabreTokenService, type SabreFetch, type SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';
import { SabreFlightSearchAdapter } from './sabre-flight-search.adapter';

/**
 * **La puerta única al `LoggerPort`**: nada del paquete llega a un transporte de logs sin pasar por
 * `logRedacted` de `redaction.ts`.
 *
 * ## Qué había antes
 *
 * La misma línea —`logger?.[level](message, redactMeta({ provider: 'sabre', ...meta }))`— escrita
 * BYTE A BYTE en tres clases: `SabreTokenService`, `SabreFlightSearchAdapter` y `SabreHttpClient`.
 * Y **una sola de las tres con test**.
 *
 * Medido al escribir este fichero, y con el número de la medición y no de memoria: dejando las dos
 * clases sin la pasada de redacción y corriendo el resto de la suite —todo menos los tres ficheros
 * que esta ronda añade—, **1203 de 1203 tests seguían verdes**. La del token service no era
 * decorativa: sin ella `sabre.token.cache_corrupta` publica
 * `cacheKey = 'sabre:atk:tenant-42:ZZ1A:0b23…'`, o sea el PCC de la oficina.
 *
 * Tres copias de una política de seguridad y un test es la forma exacta del incidente de la ronda 2
 * de este paquete: dos implementaciones de la regla dura, tests verdes sobre la endurecida, y la
 * débil corriendo en producción.
 *
 * ## Las dos capas, y por qué hacen falta las dos
 *
 * 1. **Estructural, por ALCANZABILIDAD DE TIPO.** Se construye el programa de TypeScript del
 *    paquete y se le pregunta al checker por el TIPO de cada expresión llamada. Toda llamada a un
 *    método de `LoggerPort` desde código de producción tiene que estar dentro de `logRedacted`.
 *
 *    No es una lista de nombres prohibidos, y la distinción es la lección de
 *    `dist-surface.guard.test.ts`: aquel guard AFIRMABA comprobar la propiedad y comprobaba un
 *    `RegExp` de nombres, así que sólo cazaba al polizón que se llamaba como esperábamos. Aquí, un
 *    campo con otro nombre (`sink`, `telemetry`), un alias local (`const l = this.deps.logger`),
 *    un logger pasado a una función auxiliar o una cuarta clase caen igual, porque lo que se mira
 *    es el tipo que el checker resuelve, no el identificador que alguien escribió.
 *
 * 2. **De comportamiento, por la PUERTA PÚBLICA.** Un testigo sensible entra por
 *    `SabreTokenService.getToken()`, por `SabreFlightSearchAdapter.search()` y por
 *    `SabreHttpClient.postJson()`, y se comprueba que no llega al `LoggerPort`.
 *
 * La capa 1 sola no basta: un `(this.deps.logger as any).warn(…)` deja de tener tipo `LoggerPort`
 * y el checker no lo ve. La capa 2 sí lo vería, porque el testigo saldría en claro. La capa 2 sola
 * tampoco basta: sólo mide los mensajes que alguien se acordó de ejercitar, y el log que se filtre
 * mañana todavía no está escrito. Escrito entero para que nadie lea ninguna de las dos como
 * cobertura total.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Capa 1 — estructural: alcanzabilidad de tipo hasta LoggerPort
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

const PKG_DIR = findPackageRoot();
const SRC_DIR = join(PKG_DIR, 'src');

const toRelative = (absolute: string): string =>
  relative(PKG_DIR, absolute).split(sep).join(posix.sep);

/**
 * El programa se construye con el MISMO `tsconfig.json` que compila el paquete, menos los tests:
 * lo que se audita es el código que se publica. Coste medido: ~0,5 s, una sola vez para todo el
 * fichero.
 */
function buildProgram(): ts.Program {
  const configPath = join(PKG_DIR, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  expect(raw.error, 'no se pudo leer tsconfig.json').toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, PKG_DIR);
  const production = parsed.fileNames.filter((file) => !file.endsWith('.test.ts'));
  return ts.createProgram(production, { ...parsed.options, noEmit: true });
}

const program = buildProgram();
const checker = program.getTypeChecker();

const isInsideSrc = (file: ts.SourceFile): boolean =>
  file.fileName.replace(/\\/g, '/').startsWith(`${SRC_DIR.replace(/\\/g, '/')}/`);

const productionFiles = program.getSourceFiles().filter(isInsideSrc);

/**
 * El ancla del análisis: el símbolo de `LoggerPort`, sacado de la FIRMA del helper y no de un
 * nombre escrito aquí.
 *
 * Se toma el primer parámetro de `logRedacted`, se le quita el `undefined` de la unión y se pide su
 * símbolo. Anclar así tiene una propiedad que un `import type` en este test no tendría: si alguien
 * afloja la firma del helper a `any`, el ancla no se resuelve y este bloque se pone rojo en vez de
 * quedarse ciego en silencio.
 */
function loggerPortSymbol(): ts.Symbol {
  const redactionFile = productionFiles.find((file) => file.fileName.endsWith('redaction.ts'));
  expect(redactionFile, 'redaction.ts no está en el programa').toBeDefined();
  let parameterType: ts.Type | undefined;
  ts.forEachChild(redactionFile as ts.SourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== 'logRedacted') return;
    const first = node.parameters[0];
    if (first !== undefined) parameterType = checker.getTypeAtLocation(first);
  });
  expect(parameterType, 'no se encontró `logRedacted(logger, …)` en redaction.ts').toBeDefined();
  const constituents = (parameterType as ts.Type).isUnion()
    ? (parameterType as ts.UnionType).types
    : [parameterType as ts.Type];
  const named = constituents
    .map((type) => type.aliasSymbol ?? type.getSymbol())
    .filter((symbol): symbol is ts.Symbol => symbol !== undefined);
  expect(
    named.map((symbol) => symbol.getName()),
    'el primer parámetro de `logRedacted` dejó de estar tipado como `LoggerPort`: sin ese tipo ' +
      'esta guarda no puede ver nada y hay que arreglar la firma, no la guarda',
  ).toContain('LoggerPort');
  return named.find((symbol) => symbol.getName() === 'LoggerPort') as ts.Symbol;
}

const LOGGER_PORT = loggerPortSymbol();

function isLoggerPortType(type: ts.Type): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents.some((part) => (part.aliasSymbol ?? part.getSymbol()) === LOGGER_PORT);
}

/** Una posición de TIPO (`logger?: LoggerPort`) no es un uso del logger: no se cuenta. */
function isInTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isTypeNode(current) ||
      ts.isImportDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    )
      return true;
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

interface LoggerCall {
  readonly file: string;
  readonly line: number;
  readonly enclosing: string;
  readonly node: ts.CallExpression;
}

/** Nombre de la función/método que ENVUELVE al nodo. `<top-level>` si no hay ninguna. */
function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
      return current.name === undefined ? '<anónima>' : current.name.getText();
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return '<anónima>';
  }
  return '<top-level>';
}

function collectLoggerCalls(): { calls: LoggerCall[]; filesWithLoggerValues: Set<string> } {
  const calls: LoggerCall[] = [];
  const filesWithLoggerValues = new Set<string>();

  for (const file of productionFiles) {
    const visit = (node: ts.Node): void => {
      // Toda llamada `X.m(…)` / `X[m](…)` cuyo receptor `X` sea, según el checker, un `LoggerPort`.
      // Cubre `logger.warn(…)`, `this.deps.logger?.[level](…)` y cualquier alias intermedio.
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          if (isLoggerPortType(checker.getTypeAtLocation(callee.expression))) {
            calls.push({
              file: toRelative(file.fileName),
              line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              enclosing: enclosingName(node),
              node,
            });
          }
        }
      }
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
        !isInTypePosition(node) &&
        isLoggerPortType(checker.getTypeAtLocation(node))
      ) {
        filesWithLoggerValues.add(toRelative(file.fileName));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return { calls, filesWithLoggerValues };
}

const { calls: LOGGER_CALLS, filesWithLoggerValues: LOGGER_FILES } = collectLoggerCalls();

describe('capa 1 — sólo un sitio del paquete llama al LoggerPort', () => {
  it('el ancla de tipo se resolvió: si esto falla, todo lo demás sería vacuo', () => {
    expect(LOGGER_PORT.getName()).toBe('LoggerPort');
    const declaration = LOGGER_PORT.getDeclarations()?.[0];
    expect(declaration, '`LoggerPort` sin declaración').toBeDefined();
    // El puerto vive en `@sales-travel/core`, no en este paquete: una definición local sería una
    // segunda copia del contrato de logging, que es la clase de duplicado que se está cerrando.
    expect((declaration as ts.Declaration).getSourceFile().fileName.replace(/\\/g, '/')).toContain(
      '/packages/core/',
    );
  });

  it('toda llamada a un método de LoggerPort está dentro de `logRedacted`', () => {
    const outsiders = LOGGER_CALLS.filter(
      (call) => call.file !== 'src/redaction.ts' || call.enclosing !== 'logRedacted',
    ).map((call) => `${call.file}:${call.line} (dentro de ${call.enclosing})`);

    expect(
      outsiders,
      'alguien volvió a hablarle al LoggerPort sin pasar por `logRedacted` de redaction.ts. ' +
        'Ahí es donde se etiqueta el proveedor y se pasa la meta por `redactMeta`; saltárselo es ' +
        'la fuga que costó el PCC de la oficina en `sabre.token.cache_corrupta`.',
    ).toEqual([]);
  });

  it('y hay exactamente UNA, porque cero llamadas también pasaría el test de arriba', () => {
    expect(
      LOGGER_CALLS.map((call) => `${call.file}:${call.enclosing}`),
      'o el helper dejó de llamar al logger, o el análisis se quedó ciego',
    ).toEqual(['src/redaction.ts:logRedacted']);
  });

  it('esa única llamada pasa la meta por `redactMeta`, y se comprueba por SÍMBOLO', () => {
    const call = LOGGER_CALLS[0] as LoggerCall;
    const meta = call.node.arguments[1];
    expect(meta, '`logRedacted` dejó de pasar meta al logger').toBeDefined();
    expect(
      ts.isCallExpression(meta as ts.Expression),
      'el segundo argumento del logger ya no es una llamada: la pasada de redacción desapareció',
    ).toBe(true);

    // Por símbolo y no por texto: un `const r = redactMeta` o un import renombrado seguirían
    // siendo la misma función, y una función DISTINTA que se llamara `redactMeta` no lo sería.
    const callee = (meta as ts.CallExpression).expression;
    const used = checker.getSymbolAtLocation(callee);
    const resolved =
      used !== undefined && (used.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(used)
        : used;
    expect(resolved?.getName(), 'la meta ya no pasa por `redactMeta`').toBe('redactMeta');
    const declaredIn = resolved?.getDeclarations()?.[0]?.getSourceFile().fileName ?? '';
    expect(declaredIn.replace(/\\/g, '/')).toContain('/src/redaction.ts');
  });

  it('los ficheros que MANEJAN un LoggerPort son exactamente estos cuatro', () => {
    // Anti-ceguera, no la defensa. La defensa es el test de arriba; esto es lo que impide que se
    // quede vacuo sin avisar: si alguien afloja `logger?: LoggerPort` a `any`, ese fichero
    // DESAPARECE de esta lista y el test se pone rojo, en vez de que sus llamadas dejen de verse.
    //
    // Escrito como igualdad y no como `toContain` a propósito: una quinta clase con logger es un
    // camino nuevo al transporte de logs, y quien lo abra tiene que mirar esta guarda a la cara.
    expect([...LOGGER_FILES].sort()).toEqual([
      'src/auth/token.service.ts',
      'src/http/sabre-http.client.ts',
      'src/redaction.ts',
      'src/sabre-flight-search.adapter.ts',
      'src/sabre-offer-price.adapter.ts',
      'src/sabre-order-create.adapter.ts',
      'src/sabre-order-manage.adapter.ts',
    ]);
    // Los tres adapters de price/create/manage entraron con el cableado de la Fase 2.b/3. La
    // capa 1 —que es la defensa— los cubre sin tocar nada: no llaman al logger, se lo pasan a
    // `logRedacted`. La capa 2 ejercita abajo la puerta pública de `snapshotForDisplay`; las de
    // `priceQuote` y `createBooking` NO están ejercitadas todavía, y por eso el bloque de la
    // cabecera dice que la capa 2 no es cobertura total. Es una carencia conocida, no una promesa.
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Capa 2 — comportamiento, por la puerta pública de cada una de las tres clases
 * ──────────────────────────────────────────────────────────────────────────── */

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

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZ1A',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
    ...overrides,
  };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

describe('capa 2a — SabreTokenService.getToken(): el PCC no sale en la clave de caché', () => {
  /**
   * El caso MEDIDO de esta ronda, y el que demuestra que la copia del token service era
   * load-bearing: una entrada corrupta en Redis dispara `sabre.token.cache_corrupta`, cuya meta
   * lleva `cacheKey` entera — `sabre:atk:{tenant}:{PCC}:{huella}` —. Sin la pasada de redacción, el
   * pseudo-city de la oficina se publica en un canal que nadie trata como sensible.
   */
  it('`sabre.token.cache_corrupta` no publica el pseudo-city', async () => {
    const store = new Map<string, unknown>([]);
    const cache: CachePort = {
      // Corrupta a propósito: no pasa `CachedTokenSchema`, que es lo que dispara el warning.
      get: () => Promise.resolve({ valor: 'no-es-el-schema' } as never),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
      invalidatePattern: () => Promise.resolve(),
    };
    const fetchImpl: SabreFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'ATK-NUEVO', expires_in: 604800 }), {
          status: 200,
        }),
      );
    const { logger, calls } = spyLogger();

    const service = new SabreTokenService(config(), { fetch: fetchImpl, cache, logger });
    await service.getToken();

    const corrupt = calls.find((call) => call.message === 'sabre.token.cache_corrupta');
    expect(corrupt, 'sin el warning no hay nada que observar').toBeDefined();
    const dump = JSON.stringify(corrupt?.meta);
    expect(dump, 'el pseudo-city de la oficina salió en el log').not.toContain('ZZ1A');
    expect(dump).toContain(REDACTED);
    // La clave sigue existiendo: lo que se tapa es el valor, no el diagnóstico.
    expect(Object.keys(corrupt?.meta ?? {})).toContain('cacheKey');
    // Y el resto de la meta no se lleva por delante la etiqueta de proveedor.
    expect(corrupt?.meta?.['provider']).toBe('sabre');
  });
});

describe('capa 2b — SabreFlightSearchAdapter.search(): la meta del llamador también se redacta', () => {
  /**
   * La meta de este adapter no la fabrica el paquete: `tenantId` y `requestId` cruzan el port desde
   * el fan-out, y el segundo acaba dentro del `conversationId`. Son datos de fuera —lo que pegue
   * quien llame— y por eso pasan por la misma pasada (RNF-07).
   */
  it('ni el tenantId ni el conversationId del llamador salen en claro', async () => {
    const PAN = '4111111111111111';
    const SECRET = 'VmpFNlpYQnlPbkJqWXpwQlFRPT06Y0dGemN3PT0=';
    const fetchImpl: SabreFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ groupedItineraryResponse: { version: '5', messages: [] } }), {
          status: 200,
        }),
      );
    const { logger, calls } = spyLogger();

    const adapter = new SabreFlightSearchAdapter(config(), {
      fetch: fetchImpl,
      logger,
      tokens,
      now: () => 1_700_000_000_000,
    });
    await adapter.search(
      {
        origin: 'BOG',
        destination: 'LIM',
        departureDate: '2026-09-11',
        paxCount: { adults: 1, children: 0, infants: 0 },
        currency: 'USD',
      },
      { tenantId: `tenant-${PAN}`, requestId: SECRET },
    );

    // Se mira SÓLO lo que loguea el adapter (`sabre.shop.*`). El cliente HTTP loguea en la misma
    // llamada, y si el dump fuera conjunto este test podría ponerse rojo por una fuga del cliente
    // —que ya tiene la suya en 2c— y quedarse verde con el adapter roto.
    const own = calls.filter((call) => call.message.startsWith('sabre.shop.'));
    expect(
      own.map((call) => call.message),
      'el adapter no logueó nada que observar',
    ).toContain('sabre.shop.ok');
    const dump = JSON.stringify(own);
    expect(dump, 'el adapter publicó un PAN del llamador').not.toContain(PAN);
    expect(dump, 'el adapter publicó un secreto del llamador').not.toContain(SECRET);
    expect(dump, 'no hay ni una marca de redacción: la pasada no corrió').toContain(REDACTED);
  });
});

describe('capa 2c — SabreHttpClient.postJson(): el conversationId del llamador se redacta', () => {
  it('`sabre.http.ok` no publica el secreto que venía en el Conversation-ID', async () => {
    const SECRET = 'VmpFNlpYQnlPbkJqWXpwQlFRPT06Y0dGemN3PT0=';
    const fetchImpl: SabreFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ groupedItineraryResponse: { version: '5' } }), {
          status: 200,
        }),
      );
    const { logger, calls } = spyLogger();
    const http = new SabreHttpClient(config(), tokens, { fetch: fetchImpl, logger });

    await http.postJson('/v5/offers/shop', {}, { conversationId: `sales-travel-${SECRET}` });

    const ok = calls.find((call) => call.message === 'sabre.http.ok');
    expect(ok, 'sin sabre.http.ok no hay meta que observar').toBeDefined();
    const dump = JSON.stringify(ok?.meta);
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain(REDACTED);
  });
});
