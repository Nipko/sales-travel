import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import {
  SABRE_ISSUE_FREE_TEXT,
  SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED,
  SABRE_ISSUE_OPAQUE_VALUE,
  SabreApiError,
  type SabreIssue,
} from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * El carril de PUBLICACIÓN del `SabreIssue`: qué del proveedor puede acabar en `error.issues` y,
 * por `toLogMeta()`, en el `LoggerPort`.
 *
 * ## Lo que medía la ronda 11 y por qué no bastaba la puerta anterior
 *
 * `safeIssueField` filtraba por FORMA —«sin espacios y corta»— con la regla escrita así: «se
 * conserva el vocabulario cerrado, se pierde la prosa». La suposición de debajo es que lo
 * peligroso trae espacios. La PII de viajes es justo lo contrario: un pasaporte, un localizador,
 * un billete, un teléfono, un EPR y un PCC son cortos y no tienen ni un espacio, así que pasaban
 * la forma y se publicaban LITERALES en `category` / `type` / `code` / `fieldPath`.
 *
 * §1 es esa medición, hecha por la puerta pública (`SabreHttpClient.postJson`): 12 datos reales
 * de viaje × las 4 casillas del issue, por los TRES caminos de publicación (`errors[]` de record,
 * `messages[]` y el escalar suelto) y con el dato pelado y ETIQUETADO (`ref.<dato>`), que es como
 * un agregador hace eco de verdad. El bloque incluye su propio suelo —los 12 testigos pasan la
 * forma antigua— para que la matriz no pueda volverse vacua: sin ese suelo, un testigo que ya
 * fallara la forma por otro motivo daría verde sin probar nada.
 *
 * Medición antes / después, por `postJson`: **48 de 48 llegaban literales, 0 de 48 llegan hoy.**
 *
 * ## Lo que NO se hizo, medido, y por qué
 *
 * La alternativa de fondo era sustituir el filtro por una LISTA CERRADA de `category`/`type`
 * derivada de los `.yml` congelados. **No se puede derivar**: de los 21 contratos, CERO declaran
 * un `enum` para `category`, `type` o `errorCode` — los declaran `type: string` con un `example:`
 * (`booking-management-v1.yml:4278-4285`, `flight-reshop-api-1.0.yml:4797-4803`). Lo único
 * enumerable es la documentación, y sólo Booking Management ya lista 527 valores distintos en sus
 * `*-error-list*.txt` / `*-warning-list*.txt`. Una lista cerrada ahí sería una lista escrita a
 * mano contra un vocabulario que el contrato no fija y que Sabre amplía sin cambiar el `.yml`:
 * cada valor nuevo saldría redactado en silencio.
 *
 * Lo que sí se puede derivar del expediente es la ESTRUCTURA, y es lo que se implementó: el
 * vocabulario está hecho de palabras, los identificadores de viaje no. §2 mide el falso positivo
 * de esa regla contra el expediente entero (655 valores) por la misma puerta pública.
 *
 * ## Regla de este fichero
 *
 * Todo entra por `postJson`. Un test que llame a una función interna demuestra que la función es
 * correcta, jamás que sea la que corre. Y cada bloque nombra el MUTANTE exacto que mata: si un
 * bloque no puede nombrarlo, sobra.
 */

const SHOP_PATH = '/v5/offers/shop';
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

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

interface Observed {
  readonly rejected: boolean;
  readonly issues: readonly SabreIssue[];
  /** Serialización de todo lo que se le entregó al `LoggerPort`, ya redactado. */
  readonly logDump: string;
}

/** Puerta pública: el sobre entra por `postJson` y sale por `error.issues` y por el log. */
async function post(payload: unknown, path: string = SHOP_PATH): Promise<Observed> {
  const calls: unknown[] = [];
  const record =
    () =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ message, meta });
    };
  const logger: LoggerPort = {
    debug: record(),
    info: record(),
    warn: record(),
    error: record(),
    child: () => logger,
  };
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });

  const outcome = await http.postJson(path, {}).then(
    () => null,
    (err: unknown) => err,
  );
  const rejected = outcome instanceof SabreApiError;
  return { rejected, issues: rejected ? outcome.issues : [], logDump: JSON.stringify(calls) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * (1) La matriz 4 × 12: ningún dato de viaje llega literal a una casilla
 * ──────────────────────────────────────────────────────────────────────────── */

/** Las cuatro casillas del `SabreIssue` que se rellenan con valores del proveedor. */
const ISSUE_SLOTS = ['category', 'type', 'code', 'fieldPath'] as const;

/**
 * Doce datos con la forma REAL de lo que circula por un sobre de Sabre. Ninguno es prosa: los
 * doce son cortos y sin espacios, que es exactamente por lo que la forma sola no los veía.
 */
const TRAVEL_DATA: ReadonlyArray<readonly [string, string]> = [
  ['pasaporte', 'AB1234567'],
  ['localizador (PNR)', 'XKCD12'],
  ['billete', '0012345678901'],
  ['nombre GDS', 'SMITH/JOHNMR'],
  ['teléfono', '573001234567'],
  ['EPR', '500001'],
  ['PCC', 'ZZ1A'],
  ['clientId de Sabre', 'V1:500001:ZZ1A:AA'],
  ['PAN', '4111111111111111'],
  ['secret de Sabre', 'VmpFOjUwMDAwMTpaWjFBOkFBOlBhNTV3MHJkIQ'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJlcHIiOiI1MDAwMDEifQ.c2ln'],
  ['fecha de nacimiento', '1989-04-17'],
];

/**
 * COPIA LITERAL de la puerta que había antes de esta ronda, y sólo para eso: demostrar que los
 * doce testigos la pasaban. No es la regla de producción y no puede usarse como tal — está aquí
 * porque una matriz de fugas cuyos testigos ya fallaran por otro motivo no mediría nada.
 */
const GATE_BEFORE_ROUND_11 = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

const MATRIX = TRAVEL_DATA.flatMap(([label, value]) =>
  ISSUE_SLOTS.map((slot) => [`${slot} ← ${label}`, slot, value] as const),
);

describe('la matriz 4 × 12 — ningún dato de viaje se publica literal', () => {
  it('suelo: los doce testigos pasaban la puerta anterior (si no, la matriz no mide nada)', () => {
    const escaped = TRAVEL_DATA.filter(([, value]) => !GATE_BEFORE_ROUND_11.test(value));
    expect(escaped, 'testigo que ya fallaba antes: no prueba la regresión').toEqual([]);
    expect(MATRIX).toHaveLength(48);
  });

  it.each(MATRIX)('%s: no llega ni al issue ni al LoggerPort', async (name, slot, value) => {
    const observed = await post({ errors: [{ severity: 'Error', [slot]: value }] });

    // Primero lo que no puede cambiar: redactar no puede convertir un fallo en un éxito.
    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(observed.issues.length, `${name}: se perdió el issue entero`).toBeGreaterThan(0);

    expect(JSON.stringify(observed.issues), `${name}: publicado en el issue`).not.toContain(value);
    expect(observed.logDump, `${name}: llegó al LoggerPort`).not.toContain(value);
  });

  it.each(MATRIX)('%s: tampoco por el portador `messages[]`', async (name, slot, value) => {
    const observed = await post({ messages: [{ severity: 'Error', [slot]: value }] });

    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(JSON.stringify(observed.issues), `${name}: publicado en el issue`).not.toContain(value);
    expect(observed.logDump, `${name}: llegó al LoggerPort`).not.toContain(value);
  });

  it.each(TRAVEL_DATA)('%s: tampoco como escalar suelto de `errors[]`', async (name, value) => {
    // El tercer camino de publicación, `scalarIssue`. Tenía su propia copia de la condición.
    const observed = await post({ errors: [value] });

    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(JSON.stringify(observed.issues), `${name}: publicado en el issue`).not.toContain(value);
    expect(observed.logDump, `${name}: llegó al LoggerPort`).not.toContain(value);
  });

  /**
   * La MISMA matriz con el dato ETIQUETADO, que es como un agregador hace eco de verdad: no manda
   * el número pelado, manda `ref.<número>`. Y es lo que mide los dos techos de la regla, porque el
   * dato pelado ya lo tumba «al menos un segmento tiene que ser palabra» — con el testigo pelado a
   * secas, subir el techo numérico de 4 a 20 deja la suite en verde. Medido.
   */
  it.each(MATRIX)('%s: tampoco etiquetado (`ref.<dato>`)', async (name, slot, value) => {
    const observed = await post({ errors: [{ severity: 'Error', [slot]: `ref.${value}` }] });

    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(JSON.stringify(observed.issues), `${name}: publicado en el issue`).not.toContain(value);
    expect(observed.logDump, `${name}: llegó al LoggerPort`).not.toContain(value);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) El precio: el vocabulario del expediente sigue saliendo entero
 * ────────────────────────────────────────────────────────────────────────────
 *
 * El corpus se LEE del expediente en tiempo de test, no se copia aquí: copiarlo dejaría dos
 * originales divergiendo, que es contra lo que existe `spec-manifest.test.ts` (RNF-15). Y se lee
 * de las tres fuentes que de verdad publican vocabulario de error:
 *
 *   - las listas oficiales `*-error-list*.txt` / `*-warning-list*.txt` de Booking Management,
 *   - la tabla del gateway (`ERR.2SG.*`) y los códigos de hoteles (`ERR.0161`, `WARN.0788`),
 *   - los `example:` de `category` / `type` / `code` / `errorCode` / `fieldPath` de los 21 `.yml`.
 */

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

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Un valor de las listas oficiales: una línea que es sólo un identificador. */
const HELP_LIST_VALUE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SEVERITY_PREFIXED_CODE = /\b(?:ERR|WARN|FAULT|FATAL)\.[A-Za-z0-9._]{3,}/g;

/**
 * El dialecto de hoteles publica el código en una columna `Code` de cuatro dígitos y lo prefija
 * con la severidad al emitirlo. Lo dice el propio expediente en la cabecera de la tabla:
 * «Message codes may be either returned as Errors (ERR) or Warnings (WARN)»
 * (`help/get-hotel-avail-v4/v4-errors.txt:3`), y el ejemplo REST de ese mismo fichero manda
 * `"code": "WARN.0788"`. Por eso las dos formas entran al corpus: es la única fuente de segmentos
 * NUMÉRICOS de vocabulario y por tanto lo único que fija el techo de
 * `SABRE_ISSUE_NUMERIC_SEGMENT`.
 */
const HOTEL_NUMERIC_CODE = /^[0-9]{3,6}$/;
const YAML_EXAMPLE = /^\s+example:\s*'([^']+)'\s*$/;

/**
 * Un `example:` sólo cuenta como vocabulario de issue si el propio `.yml` dice que el campo es de
 * un error. El discriminante lo escribe Sabre, no nosotros: los bloques de `Error` / `Warning`
 * rematan cada campo con `description: The category of the error.` y sus variantes.
 *
 * Sin este filtro el barrido se lleva los `example:` de CUALQUIER campo llamado `type` o `code` de
 * los 21 contratos —`'346G'` es un RFISC de BFM v5, `'ABC1'` una base tarifaria, `'0A'` un código
 * de banco— y el corpus deja de medir lo que dice medir: esos valores no son vocabulario de error
 * y no tienen por qué publicarse en una casilla de issue.
 */
const ISSUE_FIELD_DESCRIPTION = /^\s+description:\s*.*\b(?:error|warning)s?\b/i;
const ISSUE_FIELD_NAME = /^\s+(?:category|type|fieldPath):\s*$/;

function loadContractVocabulary(): readonly string[] {
  const vocabulary = new Set<string>();

  for (const file of walkFiles(join(SPEC_DIR, 'help'))) {
    if (!file.endsWith('.txt')) continue;
    const text = readFileSync(file, 'utf8');
    if (/error-list|warning-list/.test(file)) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (HELP_LIST_VALUE.test(trimmed)) vocabulary.add(trimmed);
      }
    }
    if (/errors/.test(file)) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!HOTEL_NUMERIC_CODE.test(trimmed)) continue;
        vocabulary.add(`ERR.${trimmed}`);
        vocabulary.add(`WARN.${trimmed}`);
      }
    }
    for (const match of text.matchAll(SEVERITY_PREFIXED_CODE)) vocabulary.add(match[0]);
  }

  for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith('.yml'))) {
    const lines = readFileSync(join(SPEC_DIR, file), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      for (const match of line.matchAll(SEVERITY_PREFIXED_CODE)) vocabulary.add(match[0]);
      if (!ISSUE_FIELD_NAME.test(line)) continue;
      // El `example:` y la `description:` cuelgan del campo: se mira sólo el bloque inmediato.
      let example: string | undefined;
      let declaredOfError = false;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        const candidate = YAML_EXAMPLE.exec(lines[j] ?? '');
        if (candidate?.[1] !== undefined) example = candidate[1].trim();
        if (ISSUE_FIELD_DESCRIPTION.test(lines[j] ?? '')) declaredOfError = true;
      }
      if (declaredOfError && example !== undefined) vocabulary.add(example);
    }
  }

  // La prosa (los `example:` de `description`, que este barrido no distingue del todo) se queda
  // fuera: aquí sólo se mide el falso positivo sobre VOCABULARIO, y una frase no lo es.
  return [...vocabulary].filter((value) => !/\s/.test(value)).sort();
}

const CONTRACT_VOCABULARY = loadContractVocabulary();

describe('el precio — el vocabulario del expediente sigue llegando entero al log', () => {
  it('el corpus no se puede vaciar en silencio', () => {
    // Sin suelo, un cambio que rompa la extracción deja este bloque verde con cero valores y la
    // medición de falsos positivos se convierte en decorado.
    expect(CONTRACT_VOCABULARY.length).toBeGreaterThanOrEqual(600);
    for (const witness of [
      'ERR.2SG.SEC.NOT_AUTHORIZED',
      'ERR.0161',
      'WARN.0788',
      'APPLICATION_ERROR',
      'REQUIRED_FIELD_MISSING',
      'passenger.givenName',
      'someObject.someFieldName',
      'ContextChangeLLSRQ',
    ]) {
      expect(CONTRACT_VOCABULARY, `el corpus perdió «${witness}»`).toContain(witness);
    }
  });

  it.each(['category', 'type', 'code'] as const)(
    'en `%s`: CERO valores del expediente se redactan',
    async (slot) => {
      const observed = await post({
        errors: CONTRACT_VOCABULARY.map((value) => ({ severity: 'Error', [slot]: value })),
      });

      expect(observed.rejected).toBe(true);
      const published = new Set(
        observed.issues.map((issue) => issue[slot]).filter((v): v is string => v !== undefined),
      );
      const lost = CONTRACT_VOCABULARY.filter((value) => !published.has(value));
      expect(lost, `${slot}: el log se queda ciego para estos valores`).toEqual([]);
    },
  );

  /**
   * Los tres techos de `isContractWordShaped` se justifican en `errors.ts` con números medidos
   * («el único segmento mixto del expediente es `2SG`», «el ancho numérico máximo es 4»). Esto los
   * vuelve a medir aquí, para que la justificación no pueda quedarse rancia: un `.yml` nuevo que
   * traiga un segmento mixto de cuatro o un código de cinco dígitos pone ESTE test en rojo, que es
   * el momento exacto en que hay que decidir a mano si se sube el techo o se redacta ese valor.
   */
  it('los techos de la regla siguen siendo los que el expediente mide', () => {
    const segments = CONTRACT_VOCABULARY.flatMap((value) =>
      value.split(/[._\-[\]]+/).filter((s) => s.length > 0),
    );
    const mixed = [...new Set(segments.filter((s) => /[0-9]/.test(s) && /[A-Za-z]/.test(s)))];
    const numericWidths = segments.filter((s) => /^[0-9]+$/.test(s)).map((s) => s.length);
    const numericPerValue = CONTRACT_VOCABULARY.map(
      (value) => value.split(/[._\-[\]]+/).filter((s) => /^[0-9]+$/.test(s) && s.length > 0).length,
    );

    expect(mixed.sort(), 'apareció un segmento mixto nuevo en el expediente').toEqual(['2SG']);
    expect(Math.max(...numericWidths), 'el ancho numérico del expediente creció').toBe(4);
    expect(Math.max(...numericPerValue), 'un valor del expediente ganó segmentos numéricos').toBe(
      1,
    );
    expect(Math.max(...segments.map((s) => s.length))).toBeLessThanOrEqual(32);
  });

  it('el tope de segmentos numéricos no se come una ruta doblemente indexada', async () => {
    // El techo de dos sale de aquí y sólo de aquí: es la única forma legítima que pasa de un
    // segmento numérico. Bajarlo a uno cuesta este diagnóstico; subirlo publica `ref.1989-04-17`.
    const path = 'travelers[0].identityDocuments[0].documentNumber';
    const observed = await post({ errors: [{ severity: 'Error', fieldPath: path }] });

    expect(observed.issues[0]?.fieldPath).toBe(path);
  });

  it('en `fieldPath`: las rutas indexadas del contrato siguen enteras', async () => {
    // `fieldPath` es el «DÓNDE» del diagnóstico y los contratos lo publican indexado. La ruta no
    // es contenido del pasajero: dice `passport`, el número vive en `fieldValue`, que no entra.
    const paths = [
      'passenger.givenName',
      'priceDefinition.currencyCode',
      'travelers[0].passport',
      'fare.programs[0].values',
      'FlightReshopRequest.source',
      'someObject.someFieldName',
    ];
    const observed = await post({
      errors: paths.map((fieldPath) => ({ severity: 'Error', fieldPath })),
    });

    const published = new Set(observed.issues.map((issue) => issue.fieldPath));
    expect(paths.filter((p) => !published.has(p))).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) Las dos capas, medidas POR SEPARADO
 * ────────────────────────────────────────────────────────────────────────────
 *
 * La puerta son tres condiciones en serie y se solapan mucho. Un solo testigo que las dos últimas
 * tapan a la vez no distingue cuál corre: quitar una deja el test verde. Cada capa necesita un
 * testigo que SÓLO ella ve.
 */

describe('cada capa de la puerta tiene su propio testigo', () => {
  it('estructura: un identificador opaco cae aunque `redaction.ts` no lo reconozca', async () => {
    // Mutante: quitar `isContractWordShaped` de `isPublishableIssueValue`. `XKCD12` no es una
    // credencial ni un PAN — `redactText` lo devuelve intacto—, así que si esta capa no corre, se
    // publica entero.
    const observed = await post({ errors: [{ severity: 'Error', code: 'XKCD12' }] });

    expect(observed.rejected).toBe(true);
    expect(observed.issues[0]?.code).toBe(SABRE_ISSUE_OPAQUE_VALUE);
  });

  /**
   * Este bloque NO mata ningún mutante hoy y se deja escrito así a propósito.
   *
   * `carriesNoCredentialShape` es, con la tijera estructural en su tamaño actual, un MUTANTE
   * EQUIVALENTE: quitarla entera deja la suite en verde. Está medido con sonda de comportamiento y
   * el porqué está enumerado en su propio comentario en `errors.ts` — cada pasada de `redactText`
   * necesita un carácter (`:`, `"`, `=`, espacio) o un tamaño (segmento mixto de 9+, 13 dígitos
   * seguidos) que la estructura ya prohíbe.
   *
   * Lo que estos casos fijan es la PROPIEDAD, no la capa: un PAN troceado con guiones y un
   * `clientId` no se publican, caiga quien los tape. Si mañana alguien afloja un techo por un falso
   * positivo urgente, estos dos siguen en verde porque la pasada por forma los recoge — y ése es
   * exactamente el día para el que la pasada existe.
   */
  it.each([
    ['PAN troceado con guiones', 'card.4111-1111-1111-1111', '4111-1111-1111-1111'],
    ['clientId de Sabre', 'client.V1:500001:ZZ1A:AA', 'V1:500001:ZZ1A:AA'],
  ])('propiedad (no capa) — %s no se publica', async (name, value, secret) => {
    const observed = await post({ errors: [{ severity: 'Error', fieldPath: value }] });

    expect(observed.rejected, name).toBe(true);
    expect(JSON.stringify(observed.issues), name).not.toContain(secret);
    expect(observed.logDump, name).not.toContain(secret);
  });

  it.each([
    ['últimos cuatro de una tarjeta', '1111'],
    ['dos códigos numéricos pelados', '0161.0788'],
  ])('estructura: %s no es vocabulario — un valor sin palabras es un dato', async (name, value) => {
    // Mutante: quitar `words > 0` de `isContractWordShaped`. Los dos valores tienen segmentos
    // numéricos dentro del ancho (4) y dentro del tope (2), así que sin esa condición se publican.
    // El dialecto de hoteles NUNCA emite el código pelado: manda `WARN.0788`
    // (`help/get-hotel-avail-v4/v4-errors.txt`, ejemplo REST), que sí sale entero — lo fija §2.
    const observed = await post({ errors: [{ severity: 'Error', code: value }] });

    expect(observed.rejected, name).toBe(true);
    expect(observed.issues[0]?.code, name).toBe(SABRE_ISSUE_OPAQUE_VALUE);
  });

  it('forma: la prosa sigue distinguiéndose del identificador opaco', async () => {
    // Los dos sentinels dicen cosas distintas y apuntan a sitios distintos. Mutante: colapsarlos
    // en uno solo, que es perder la única pista que le queda a soporte.
    const prose = await post({
      errors: [{ severity: 'Error', code: 'PNR XKCD12 not found for ticket SMITH/JOHNMR' }],
    });
    const opaque = await post({ errors: [{ severity: 'Error', code: 'AB1234567' }] });

    expect(prose.issues[0]?.code).toBe(SABRE_ISSUE_FREE_TEXT);
    expect(opaque.issues[0]?.code).toBe(SABRE_ISSUE_OPAQUE_VALUE);
  });

  it('la marca de entitlement sobrevive caiga por el filtro que caiga (RNF-13)', async () => {
    // `partialUnauthorized` es lo único que separa «suscripción capada» de «no hay vuelos». Si la
    // marca sólo se conservara en la rama de prosa, un `UNAUTHORIZED` pegado a un PCC la perdería.
    const opaque = await post({ errors: [{ severity: 'Error', category: 'UNAUTHORIZED-ZZ1A' }] });
    const prose = await post({
      errors: [{ severity: 'Error', category: 'RESOURCE_RESTRICTED for PCC ZZ1A' }],
    });

    for (const observed of [opaque, prose]) {
      expect(observed.issues[0]?.category).toBe(SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED);
      expect(JSON.stringify(observed.issues)).not.toContain('ZZ1A');
    }
  });

  it('los sentinels pasan su propia puerta — la redacción es idempotente', async () => {
    // Si un sentinel no pasara la puerta, el segundo paso lo sustituiría por otro y el
    // diagnóstico se volvería una cadena de sustituciones.
    for (const sentinel of [
      SABRE_ISSUE_FREE_TEXT,
      SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED,
      SABRE_ISSUE_OPAQUE_VALUE,
    ]) {
      const observed = await post({ errors: [{ severity: 'Error', code: sentinel }] });
      expect(observed.issues[0]?.code, `«${sentinel}» no sobrevive a su propia puerta`).toBe(
        sentinel,
      );
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) `messageIssue`: los dos `??` que el comentario prometía matar
 * ──────────────────────────────────────────────────────────────────────────── */

describe('ninguna clave de contenido puede alimentar el `code` de un mensaje', () => {
  /**
   * El testigo tiene forma de VOCABULARIO a propósito.
   *
   * Con un testigo opaco (`XKCD12`) el mutante `?? item['value']` sale como
   * `OPAQUE_VALUE_REDACTED` y el test pasa igual: lo tapa la puerta de publicación, no la ausencia
   * del `??`. Ése es exactamente el motivo por el que este mutante sobrevivió cuatro rondas con un
   * comentario que afirmaba en pasado que estaba muerto.
   */
  const VOCABULARY_SHAPED = 'VendorResponseError';

  it.each(['value', 'text', 'description', 'message', 'fieldValue'])(
    '`%s` no se cuela como `code` del issue',
    async (contentKey) => {
      const observed = await post({
        messages: [{ type: 'ERROR', [contentKey]: VOCABULARY_SHAPED }],
      });

      expect(observed.rejected, contentKey).toBe(true);
      expect(observed.issues.length, contentKey).toBeGreaterThan(0);
      for (const issue of observed.issues) {
        expect(issue.code, `«${contentKey}» se publicó como \`code\``).toBeUndefined();
      }
      expect(JSON.stringify(observed.issues), contentKey).not.toContain(VOCABULARY_SHAPED);
      expect(observed.logDump, contentKey).not.toContain(VOCABULARY_SHAPED);
    },
  );

  it('el caso literal del hallazgo: `{type:ERROR, value:XKCD12}` no publica el localizador', async () => {
    const observed = await post({ messages: [{ type: 'ERROR', value: 'XKCD12' }] });

    expect(observed.rejected).toBe(true);
    expect(observed.issues[0]?.code).toBeUndefined();
    expect(JSON.stringify(observed.issues)).not.toContain('XKCD12');
    expect(observed.logDump).not.toContain('XKCD12');
    // Y el diagnóstico no se vacía: la severidad declarada sigue viajando.
    expect(observed.issues[0]?.type).toBe('ERROR');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) `severityTokens`: el troceado, dentro del subárbol que el contrato declara benigno
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `ApplicationResults.Success` APAGA la carga de la prueba en su subárbol. Ahí dentro, lo único
 * que puede volver a encenderla es que el propio item declare una severidad reconocible — y eso
 * depende de que `severityTokens` TROCEE: `VENDOR_ERROR` no está en la tabla, `ERROR` sí.
 *
 * Mutante: `values.filter(...)` sin el `.flatMap(split)`. Con él puesto, el sobre de abajo
 * —`Complete`, dentro de `Success`, en una operación cuyo contrato SÍ declara
 * `ApplicationResults`— se entrega como ÉXITO CONFIRMADO. Es el fail-open que el fichero entero
 * existe para no producir, colado por el único sitio donde la carga de la prueba está apagada.
 */

function applicationResultsSuccess(item: Record<string, unknown>): unknown {
  return {
    ApplicationResults: {
      status: 'Complete',
      Success: [{ SystemSpecificResults: [{ Message: [item] }] }],
    },
  };
}

describe('el troceado de severidad dentro de `ApplicationResults.Success`', () => {
  it.each([
    ['`type` compuesto', { type: 'VENDOR_ERROR' }],
    ['`type` compuesto (segundo dialecto)', { type: 'PROCESSING_FAILURE' }],
    ['`severity` compuesta con espacio', { severity: 'Fatal Error' }],
    ['`severity` compuesta y `type` benigno', { severity: 'Fatal Error', type: 'INFO' }],
  ])('%s se detecta y el sobre NO se entrega como éxito', async (name, item) => {
    const observed = await post(applicationResultsSuccess(item), HOTEL_AVAIL_PATH);

    expect(observed.rejected, `${name}: entregado como éxito confirmado`).toBe(true);
    expect(
      observed.issues.length,
      `${name}: rechazado pero sin issue que lo explique`,
    ).toBeGreaterThan(0);
  });

  it('el contrapeso: un mensaje realmente inocuo en la misma posición SÍ se entrega', async () => {
    // Sin esta mitad, el bloque de arriba pasaría también con un clasificador que rechazara todo
    // lo que hay bajo `Success`, que es la política contraria a la que `benignAllowed` implementa.
    const observed = await post(applicationResultsSuccess({ type: 'INFO' }), HOTEL_AVAIL_PATH);

    expect(
      observed.rejected,
      'un `Message` benigno bajo `Success` no puede tumbar la lectura',
    ).toBe(false);
  });
});
