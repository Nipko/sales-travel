import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError, SabreConfigError, type SabreIssue } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * SELLO INDEPENDIENTE DE LA RONDA 12.
 *
 * Este fichero NO reutiliza ni un testigo, ni un corpus, ni un helper de los ficheros que fijan
 * la defensa. Su única razón de ser es que una matriz escrita por quien escribió la puerta mide,
 * por construcción, lo que la puerta ya sabe tapar. Aquí los testigos, los portadores y el corpus
 * de falsos positivos se derivan de fuera del paquete —de la forma real de un dato de viaje y de
 * los 21 `.yml` oficiales— para que la medición pueda no coincidir.
 *
 * Todo entra por `SabreHttpClient.postJson`. Ninguna función interna se llama a mano: un test
 * sobre la función interna demuestra que la función es correcta, jamás que sea la que corre.
 */

const SHOP_PATH = '/v5/offers/shop';
const REMOVE_PATH = '/v1/ancillaries/remove';

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

/** Las seis superficies por las que un fallo saca datos del proveedor fuera del proceso. */
interface Surfaces {
  readonly message: string;
  readonly body: string;
  readonly code: string;
  readonly issues: string;
  readonly logMeta: string;
  readonly logDump: string;
}

const SURFACE_NAMES: readonly (keyof Surfaces)[] = [
  'message',
  'body',
  'code',
  'issues',
  'logMeta',
  'logDump',
];

interface Observed {
  readonly rejected: boolean;
  readonly surfaces: Surfaces;
  readonly issues: readonly SabreIssue[];
  readonly partialUnauthorized: readonly SabreIssue[];
  readonly logEvents: readonly string[];
}

const EMPTY_SURFACES: Surfaces = {
  message: '',
  body: '',
  code: '',
  issues: '',
  logMeta: '',
  logDump: '',
};

async function post(payload: unknown, status = 200, path = SHOP_PATH): Promise<Observed> {
  const calls: { message: string; meta?: Record<string, unknown> }[] = [];
  const record =
    () =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ message, ...(meta === undefined ? {} : { meta }) });
    };
  const logger: LoggerPort = {
    debug: record(),
    info: record(),
    warn: record(),
    error: record(),
    child: () => logger,
  };
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
    );
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
  const logDump = JSON.stringify(calls);
  const logEvents = calls.map((call) => call.message);

  if (outcome instanceof SabreApiError) {
    return {
      rejected: true,
      surfaces: {
        message: outcome.message,
        body: outcome.body,
        code: outcome.code ?? '',
        issues: JSON.stringify(outcome.issues),
        logMeta: JSON.stringify(outcome.toLogMeta()),
        logDump,
      },
      issues: outcome.issues,
      partialUnauthorized: [],
      logEvents,
    };
  }
  if (outcome instanceof Error) throw outcome;

  const ok = outcome as {
    warnings: readonly SabreIssue[];
    partialUnauthorized: readonly SabreIssue[];
  };
  return {
    rejected: false,
    surfaces: { ...EMPTY_SURFACES, issues: JSON.stringify(ok.warnings), logDump },
    issues: ok.warnings,
    partialUnauthorized: ok.partialUnauthorized,
    logEvents,
  };
}

function surfacesCarrying(surfaces: Surfaces, witness: string): string[] {
  return SURFACE_NAMES.filter((name) => surfaces[name].includes(witness));
}

/* ────────────────────────────────────────────────────────────────────────────
 * (1) LA MATRIZ — 14 testigos × 4 casillas × 6 superficies
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Los catorce testigos se eligen por la FORMA de un dato de viaje real, no por lo que la puerta
 * sepa tapar: documento, localizador, billete, nombre GDS, contacto, identificadores de oficina
 * y de red, identificadores fiscales de los tres mercados y un PAN válido por Luhn. Cada uno
 * lleva anotado de dónde sale su forma.
 */
const WITNESSES: ReadonlyArray<readonly [label: string, value: string]> = [
  ['pasaporte', 'AB1234567'],
  ['localizador PNR', 'XKCD12'],
  ['billete e-ticket 13 digitos', '0012345678901'],
  ['nombre en formato GDS', 'SMITH/JOHNMR'],
  ['telefono E.164 CO', '+573001234567'],
  ['EPR de la oficina', '5000012'],
  ['PCC / pseudo-city', 'U9PK'],
  ['fecha de nacimiento', '1989-03-14'],
  ['email del viajero', 'juan.perez@agencia.com.co'],
  ['viajero frecuente', 'AV123456789'],
  ['cedula colombiana', '1020304050'],
  ['CPF brasileno', '123.456.789-09'],
  ['numero IATA de agencia', '76512345'],
  ['PAN valido por Luhn', '4111111111111111'],
];

/** Las cuatro casillas de vocabulario que el proveedor rellena en un item de problema. */
const ISSUE_SLOTS = ['category', 'type', 'code', 'fieldPath'] as const;

/**
 * Las dos casillas de las que el carril de TRANSPORTE (`!res.ok`) saca `SabreApiError.code`.
 * Van aparte porque el portador es otro: el `code` sale del payload CRUDO antes del constructor.
 */
const TRANSPORT_SLOTS = ['errorCode', 'error'] as const;

describe('(1) sello — la matriz de PII en las seis superficies', () => {
  it('4 casillas × 14 testigos: 0 de 56 llegan literales a ninguna de las seis superficies', async () => {
    const leaks: string[] = [];
    let cells = 0;

    for (const slot of ISSUE_SLOTS) {
      for (const [label, witness] of WITNESSES) {
        cells += 1;
        const observed = await post({
          errors: [{ severity: 'Error', [slot]: witness }],
        });
        expect(observed.rejected, `${slot}=${label} tenia que rechazarse`).toBe(true);
        const carrying = surfacesCarrying(observed.surfaces, witness);
        if (carrying.length > 0) leaks.push(`${slot}/${label} → ${carrying.join(', ')}`);
      }
    }

    expect(cells).toBe(56);
    expect(leaks, `fugas medidas por postJson:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('el carril de transporte (errorCode / error) tampoco publica ninguno de los 14', async () => {
    const leaks: string[] = [];
    let cells = 0;

    for (const slot of TRANSPORT_SLOTS) {
      for (const [label, witness] of WITNESSES) {
        cells += 1;
        const observed = await post({ status: 'Failed', [slot]: witness }, 400);
        expect(observed.rejected).toBe(true);
        const carrying = surfacesCarrying(observed.surfaces, witness);
        if (carrying.length > 0) leaks.push(`${slot}/${label} → ${carrying.join(', ')}`);
      }
    }

    expect(cells).toBe(28);
    expect(leaks, `fugas del carril de transporte:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('el testigo tampoco sale cuando el proveedor lo CONCATENA con vocabulario legitimo', async () => {
    // El caso real de `/v2/auth/token`: `invalid_client:V1:{EPR}:{PCC}:{Domain}:{secret}`.
    const leaks: string[] = [];
    for (const [label, witness] of WITNESSES) {
      const observed = await post(
        { status: 'Failed', errorCode: `invalid_client:${witness}` },
        401,
      );
      const carrying = surfacesCarrying(observed.surfaces, witness);
      if (carrying.length > 0) leaks.push(`${label} → ${carrying.join(', ')}`);
    }
    expect(leaks, `fugas por concatenacion:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('EL PRECIO: el vocabulario de contrato sobrevive intacto por las seis superficies', async () => {
    // Si la puerta se pagase con el diagnostico, esto se pondria rojo y habria que revisarla.
    // Cada valor va por la casilla que el contrato le da: las rutas indexadas son `fieldPath`,
    // que es la unica de las cuatro cuya forma admite corchetes.
    const vocabulary: ReadonlyArray<readonly [slot: string, value: string]> = [
      ['code', 'ERR.2SG.SEC.NOT_AUTHORIZED'],
      ['code', 'ERR.2SG.CLIENT.VALIDATION_FAILED'],
      ['code', 'ERR.2SG.GATEWAY.TIMEOUT'],
      ['code', 'ERR.2SG.SEC.INVALID_CREDENTIALS'],
      ['category', 'APPLICATION_ERROR'],
      ['category', 'BusinessLogic'],
      ['code', 'ERR.0161'],
      ['code', 'WARN.0788'],
      ['type', 'PARTIAL_FULFILLMENT'],
      ['fieldPath', 'travelers[0].passport'],
      ['fieldPath', 'passenger.givenName'],
      ['fieldPath', 'fare.programs[0].values'],
      ['fieldPath', 'travelers[0].identityDocuments[0].documentNumber'],
    ];
    const lost: string[] = [];
    for (const [slot, value] of vocabulary) {
      const observed = await post({ errors: [{ severity: 'Error', [slot]: value }] });
      for (const surface of ['issues', 'message', 'logMeta', 'logDump'] as const) {
        if (!observed.surfaces[surface].includes(value)) lost.push(`${value} (${surface})`);
      }
    }
    expect(lost, `vocabulario de contrato perdido:\n${lost.join('\n')}`).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) LA ALERTA DE ENTITLEMENT
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(2) sello — la senal comercial de entitlement', () => {
  it('una categoria COMPUESTA sigue disparando la senal y el vendedor ve la degradacion', async () => {
    const observed = await post({
      warnings: [{ severity: 'Warning', category: 'RESOURCE_RESTRICTED/WARNING' }],
    });

    expect(observed.rejected, 'un warning no puede tumbar la respuesta').toBe(false);
    expect(observed.partialUnauthorized.length).toBeGreaterThan(0);
    expect(observed.logEvents).toContain('sabre.http.entitlement_parcial');
  });

  it('la senal sobrevive aunque la categoria compuesta traiga PII en la cabeza', async () => {
    // Cae por el filtro de vocabulario, pero el sentinel de entitlement es lo unico que separa
    // «datos capados por suscripcion» de «no hay vuelos» en la pantalla del vendedor.
    const observed = await post({
      warnings: [{ severity: 'Warning', category: 'UNAUTHORIZED_AB1234567/WARNING' }],
    });

    expect(observed.rejected).toBe(false);
    expect(observed.partialUnauthorized.length).toBeGreaterThan(0);
    expect(observed.logEvents).toContain('sabre.http.entitlement_parcial');
    expect(surfacesCarrying(observed.surfaces, 'AB1234567')).toEqual([]);
  });

  it('la senal tambien llega cuando la categoria compuesta es prosa entera', async () => {
    const observed = await post({
      warnings: [
        { severity: 'Warning', type: 'Subscription RESOURCE_RESTRICTED for PCC U9PK/WARNING' },
      ],
    });

    expect(observed.partialUnauthorized.length).toBeGreaterThan(0);
    expect(observed.logEvents).toContain('sabre.http.entitlement_parcial');
    expect(surfacesCarrying(observed.surfaces, 'U9PK')).toEqual([]);
  });

  it('sin marca de entitlement NO se inventa la senal', async () => {
    // El mutante que mata: devolver siempre `partialUnauthorized` no vacio.
    const observed = await post({ warnings: [{ severity: 'Warning', category: 'PRICING' }] });
    expect(observed.partialUnauthorized).toEqual([]);
    expect(observed.logEvents).not.toContain('sabre.http.entitlement_parcial');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) LA CLASIFICACION MIRA EL TEXTO CRUDO
 * ──────────────────────────────────────────────────────────────────────────── */

describe('(3) sello — la clasificacion se hace sobre texto CRUDO, no sobre el redactado', () => {
  it('«Wrong clientID» marca la cuenta BYOC aunque el sobre lleve un secret al lado', async () => {
    // El eco de `/v2/auth/token` lleva el secret base64 REVERSIBLE del password de la oficina.
    // Si la clasificacion mirase el texto ya redactado, la frase que desambigua desapareceria
    // y una credencial confirmadamente mala se degradaria a `AUTH_POOL` (reintentable, sin
    // marcar la cuenta): la agencia se queda sin vender y nadie sabe por que.
    const observed = await post(
      {
        status: 'Failed',
        error_description: 'Wrong clientID VmpFNTAwMDAxWlpBQVBhc3N3b3JkMTIz please check',
      },
      401,
    );
    expect(observed.rejected).toBe(true);
    expect(observed.surfaces.logMeta).toContain('"kind":"CREDENTIALS_INVALID"');
    expect(observed.surfaces.logMeta).toContain('"retry":"NO_RETRY"');
    // Y el secret NO viaja por ninguna superficie.
    expect(surfacesCarrying(observed.surfaces, 'VmpFNTAwMDAxWlpBQVBhc3N3b3JkMTIz')).toEqual([]);
  });

  it('el `invalid_client` ambiguo NO se degrada ni se endurece', async () => {
    const observed = await post({ status: 'Failed', error: 'invalid_client' }, 401);
    expect(observed.surfaces.logMeta).toContain('"kind":"AUTH_POOL"');
  });

  it('un ERR.2SG.* enterrado en el mensaje se clasifica por el texto crudo', async () => {
    const observed = await post(
      { status: 'Failed', message: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED at edge' },
      429,
    );
    expect(observed.surfaces.logMeta).toContain('"kind":"THROTTLED"');
  });

  it('la clasificacion del carril 200 no depende de lo que la puerta de vocabulario tape', async () => {
    // La categoria cae por el filtro (lleva PII), pero el veredicto comercial se mantiene.
    const observed = await post({
      errors: [{ severity: 'Error', category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
    });
    expect(observed.surfaces.logMeta).toContain('"kind":"ENTITLEMENT"');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) FALSOS POSITIVOS — corpus propio, criterio declarado
 * ────────────────────────────────────────────────────────────────────────────
 *
 * CRITERIO DE SELECCION, entero y sin excepciones a mano. Todo valor escalar distinto que los
 * 21 `.yml` oficiales de `docs/sabre/evidence/specs/` publiquen por alguna de estas tres vias:
 *
 *   (a) todo literal `ERR.*` / `WARN.*` en cualquier punto del fichero — el vocabulario del
 *       catalogo oficial de errores, que es lo que de verdad viaja en una casilla de problema;
 *   (b) todo valor de un `enum:` declarado para una propiedad llamada `category`, `type`,
 *       `code`, `errorCode`, `error` o `fieldPath` — las seis casillas que este paquete publica;
 *   (c) todo valor de esas seis claves dentro de un subarbol `example`/`examples`, en los dos
 *       dialectos que los ficheros usan (YAML `clave: valor` y JSON `"clave": "valor"`).
 *
 * Se excluyen solo los vacios y los de mas de 300 caracteres. Nada mas: NO se quita ningun valor
 * por «parecer PII». Si el corpus contiene un localizador de un ejemplo oficial, cuenta y se
 * reporta como coste.
 *
 * El resultado se parte en dos porque el coste NO es el mismo en los dos lados:
 *
 *   - (a) es vocabulario que un item de problema REALMENTE trae. Ahi el criterio es 0 perdidas
 *     y se afirma como tal.
 *   - (b)+(c) barre tambien claves `type` de esquemas que no son de error (codigo de equipo
 *     `738`, tipo de imagen `HD360`, etiqueta de pago `Credit or Debit Card`). Esos valores no
 *     pueden llegar a una casilla de problema, pero se miden igual y el numero se FIJA: si un
 *     dia cambia, la suite se pone roja y alguien decide a mano.
 */

const SPEC_DIR = join(__dirname, '..', '..', '..', 'docs', 'sabre', 'evidence', 'specs');
const CORPUS_SLOTS = new Set(['category', 'type', 'code', 'errorcode', 'error', 'fieldpath']);
/** Se construye en cada uso: un `/g` compartido arrastra `lastIndex` entre ficheros. */
const gatewayLiteral = (): RegExp => /\b(?:ERR|WARN)\.[A-Za-z0-9._]*[A-Za-z0-9]/g;

function unquote(raw: string): string {
  const trimmed = raw
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/,$/, '')
    .trim();
  const match = /^("([^"]*)"|'([^']*)')$/.exec(trimmed);
  return (match?.[2] ?? match?.[3] ?? trimmed).trim();
}

interface OfficialCorpus {
  /** (a) — el vocabulario del catalogo de errores. */
  readonly gateway: readonly string[];
  /** (a)+(b)+(c) — todo lo que las seis claves publican en los contratos. */
  readonly all: readonly string[];
}

function collectOfficialSlotValues(): OfficialCorpus {
  const gateway = new Set<string>();
  const all = new Set<string>();
  const keep = (value: string): void => {
    if (value.length > 0 && value.length <= 300) all.add(value);
  };

  // (a) el catalogo oficial de errores es un .txt del devhub, no un .yml: es donde viven los
  // `ERR.2SG.*`, y dejarlo fuera mediria el precio sin el vocabulario que mas importa.
  for (const file of readdirSync(join(SPEC_DIR, 'help')).filter((name) => name.endsWith('.txt'))) {
    const text = readFileSync(join(SPEC_DIR, 'help', file), 'utf8');
    for (const match of text.matchAll(gatewayLiteral())) {
      gateway.add(match[0]);
      keep(match[0]);
    }
  }

  for (const file of readdirSync(SPEC_DIR).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(join(SPEC_DIR, file), 'utf8');

    // (a)
    for (const match of text.matchAll(gatewayLiteral())) {
      gateway.add(match[0]);
      keep(match[0]);
    }

    // (c) dialecto JSON incrustado.
    for (const match of text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([^"\\\n]*)"/g)) {
      const key = match[1]?.toLowerCase();
      const value = match[2];
      if (key === undefined || value === undefined || !CORPUS_SLOTS.has(key)) continue;
      keep(value);
    }

    const lines = text.split(/\r?\n/);
    const stack: { indent: number; key: string }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const match = /^(\s*)(-\s+)?"?([A-Za-z_][A-Za-z0-9_.-]*)"?\s*:(.*)$/.exec(line);
      if (match === null) continue;
      const indent = (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
      const key = match[3] ?? '';
      const rest = (match[4] ?? '').trim();
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      const isSlot = CORPUS_SLOTS.has(key.toLowerCase());

      if (rest === '' || rest === '|' || rest === '>') {
        stack.push({ indent, key });
        // (b) el `enum:` que cuelga de esta propiedad.
        if (isSlot) {
          for (let j = i + 1; j < lines.length; j += 1) {
            const body = lines[j] ?? '';
            if (body.trim() === '') continue;
            const bodyIndent = /^(\s*)/.exec(body)?.[1]?.length ?? 0;
            if (bodyIndent <= indent) break;
            if (!/^\s*enum:\s*$/.test(body)) continue;
            for (let k = j + 1; k < lines.length; k += 1) {
              const item = /^(\s*)-\s+(.*)$/.exec(lines[k] ?? '');
              if (item === null || (item[1]?.length ?? 0) <= bodyIndent) break;
              keep(unquote(item[2] ?? ''));
            }
          }
        }
        continue;
      }

      const inExample = stack.some(
        (entry) => entry.key.toLowerCase() === 'example' || entry.key.toLowerCase() === 'examples',
      );
      if (inExample && isSlot) keep(unquote(rest));
    }
  }
  return { gateway: [...gateway], all: [...all] };
}

/**
 * Toda causa de NO publicacion que las reglas del paquete declaran. Se enumeran como PREDICADOS y
 * no como una lista de valores a mano: una lista se actualiza sola cuando alguien la pega del
 * mensaje de error, y entonces deja de medir nada. Con predicados, un rechazo que no encaje en
 * ninguna de las tres clases es un falso positivo NUEVO y sin coartada, y la suite se pone roja.
 */
const EXPLAINED_REJECTIONS: ReadonlyArray<readonly [name: string, holds: (v: string) => boolean]> =
  [
    // La forma (`SABRE_SAFE_CODE_SHAPE`) exige un identificador: sin espacios, corto, y empezando
    // por alfanumerico. Es la regla que tapa la prosa del proveedor.
    ['prosa o forma no-identificador', (v) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(v)],
    // La estructura exige al menos un segmento de PALABRA PURA (`^[A-Za-z]{1,32}$`). Un valor
    // hecho solo de numeros o de acronimos mixtos no la tiene y cae. El coste esta documentado en
    // `errors.ts` (`SABRE_ISSUE_NUMERIC_SEGMENT`) y defendido con evidencia: el dialecto de
    // hoteles nunca emite el codigo pelado, manda `WARN.0788`. Lo que la medicion anade —y el
    // comentario del paquete no dice— es que la misma condicion tumba los codigos de equipo
    // (`32B`, `E75`, `C06`) y los de cabina/tarifa (`A1`, `A2`, `K2`) de los contratos.
    [
      'sin ningun segmento de palabra pura',
      (v) => !v.split(/[._\-[\]]+/).some((seg) => /^[A-Za-z]{1,32}$/.test(seg)),
    ],
    // Un segmento MIXTO por encima del techo de acronimo (3). Es la frontera medida entre `2SG`
    // y un PCC `ZZ1A`, y es lo que impide que un localizador salga entero.
    [
      'segmento mixto por encima del techo de acronimo',
      (v) =>
        v
          .split(/[._\-[\]]+/)
          .some((seg) => seg.length > 3 && /[A-Za-z]/.test(seg) && /[0-9]/.test(seg)),
    ],
  ];

describe('(5) sello — falsos positivos contra los contratos oficiales', () => {
  const corpus = collectOfficialSlotValues();

  it('el corpus sale de los .yml oficiales y trae las dos partes', () => {
    expect(corpus.gateway.length).toBeGreaterThanOrEqual(16);
    expect(corpus.all.length).toBeGreaterThanOrEqual(170);
  });

  it('(a) los literales ERR.*/WARN.* del catalogo oficial NO pierden un solo byte', async () => {
    const lost: string[] = [];
    for (const value of corpus.gateway) {
      const observed = await post({ errors: [{ severity: 'Error', code: value }] });
      for (const surface of ['issues', 'message', 'body', 'logMeta', 'logDump'] as const) {
        if (!observed.surfaces[surface].includes(value)) lost.push(`${value} (${surface})`);
      }
    }
    expect(
      lost,
      `vocabulario del catalogo oficial perdido (${corpus.gateway.length} literales):\n` +
        lost.join('\n'),
    ).toEqual([]);
  });

  it('(b)+(c) todo rechazo del corpus completo tiene una coartada declarada', async () => {
    const mangled: string[] = [];
    for (const value of corpus.all) {
      const observed = await post({ errors: [{ severity: 'Error', code: value }] });
      if (!observed.surfaces.issues.includes(JSON.stringify(value).slice(1, -1))) {
        mangled.push(value);
      }
    }
    const unexplained = mangled.filter(
      (value) => !EXPLAINED_REJECTIONS.some(([, holds]) => holds(value)),
    );
    expect(
      unexplained,
      `corpus ${corpus.all.length}, no publicados ${mangled.length}. Rechazos SIN coartada ` +
        `declarada (falsos positivos nuevos): ${JSON.stringify(unexplained)}`,
    ).toEqual([]);

    // Y el precio no puede crecer en silencio: el reparto por clase se fija.
    const byClass = EXPLAINED_REJECTIONS.map(
      ([name, holds]) => `${name}: ${mangled.filter(holds).length}`,
    );
    expect({ corpus: corpus.all.length, mangled: mangled.length, byClass }).toMatchInlineSnapshot(`
      {
        "byClass": [
          "prosa o forma no-identificador: 3",
          "sin ningun segmento de palabra pura: 52",
          "segmento mixto por encima del techo de acronimo: 8",
        ],
        "corpus": 189,
        "mangled": 53,
      }
    `);
  });

  it('ningun ejemplo oficial de EXITO se rechaza por la puerta publica', async () => {
    // El otro lado de la balanza: un falso positivo tambien es un fallo de produccion.
    const successes: unknown[] = [
      {},
      { OTA_AirLowFareSearchRS: { Success: {} } },
      { groupedItineraryResponse: { statistics: { itineraryCount: 3 } } },
      {
        ApplicationResults: {
          status: 'Complete',
          Success: [{ timeStamp: '2026-01-01T00:00:00Z' }],
        },
      },
    ];
    // `{}` solo es exito en la operacion que el contrato declara asi.
    const removed = await post(successes[0], 200, REMOVE_PATH);
    expect(removed.rejected, '/v1/ancillaries/remove declara `{}` como exito').toBe(false);
    for (const payload of successes.slice(1)) {
      const observed = await post(payload);
      expect(observed.rejected, `rechazado: ${JSON.stringify(payload)}`).toBe(false);
    }
    // Y el mismo `{}` en una escritura sigue siendo reserva fantasma.
    const phantom = await post({}, 200, '/v1/trip/orders/createBooking');
    expect(phantom.rejected, '`{}` en createBooking NO puede ser exito').toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (6) LOS LIMITES DE LA PUERTA, MEDIDOS POR DIALECTO
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `errors.ts` deja escrito un limite conocido: «una casilla echada en XML/SOAP NO pasa por aqui
 * y sigue saliendo entera en el `body`», y lo fija `errors.message-body-gate.test.ts` §4.
 *
 * La medicion independiente dice que el limite es MAS ANCHO de lo que ese comentario nombra: el
 * dialecto `application/x-www-form-urlencoded` —el del cuerpo de `/v2/auth/token`, para el que
 * `redaction.ts` mantiene una rejilla propia (`FORM_PAIR`)— esta igual de abierto y NO se nombra
 * en ningun sitio. Este bloque no lo cierra: lo ESCRIBE y lo fija, para que el dia que se cierre
 * la suite se ponga roja aqui.
 *
 * Y fija la otra mitad, la que importa: caiga por donde caiga, el dato NO llega ni a `issues`, ni
 * a `toLogMeta()`, ni al `LoggerPort`. Las tres superficies que van a monitorizacion y a los
 * tickets siguen limpias en los cuatro dialectos.
 */
describe('(6) sello — los limites de la puerta de vocabulario, por dialecto', () => {
  const WITNESS = 'AB1234567';

  const DIALECTS: ReadonlyArray<readonly [name: string, body: string]> = [
    ['json (la casilla que la puerta juzga)', `{"code":"${WITNESS}"}`],
    ['json (una clave neutra: eco diagnostico a proposito)', `{"detail":"${WITNESS}"}`],
    ['xml / soap (limite escrito en errors.ts)', `<Fault><code>${WITNESS}</code></Fault>`],
    ['form-urlencoded (limite NO escrito en ningun sitio)', `code=${WITNESS}&grant_type=x`],
  ];

  it('el reparto por dialecto es exactamente el fijado', async () => {
    const observed: Record<string, string[]> = {};
    for (const [name, body] of DIALECTS) {
      observed[name] = surfacesCarrying((await post(body, 400)).surfaces, WITNESS);
    }
    expect(observed).toEqual({
      'json (la casilla que la puerta juzga)': [],
      'json (una clave neutra: eco diagnostico a proposito)': ['message', 'body'],
      'xml / soap (limite escrito en errors.ts)': ['message', 'body'],
      'form-urlencoded (limite NO escrito en ningun sitio)': ['message', 'body'],
    });
  });

  it('en NINGUN dialecto el dato llega a issues, a toLogMeta ni al LoggerPort', async () => {
    // Es la afirmacion que sostiene «PII cerrada»: el mensaje y el cuerpo son el eco diagnostico
    // y tienen politica propia; las tres superficies que viajan lejos no tienen ninguna fuga.
    const leaks: string[] = [];
    for (const [name, body] of DIALECTS) {
      const carrying = surfacesCarrying((await post(body, 400)).surfaces, WITNESS);
      for (const surface of ['issues', 'logMeta', 'logDump', 'code'] as const) {
        if (carrying.includes(surface)) leaks.push(`${name} → ${surface}`);
      }
    }
    expect(leaks, `fugas por superficie de log:\n${leaks.join('\n')}`).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (7) LOS CUATRO MUTANTES QUE EL SELLO NO MATABA
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Al medir este mismo fichero contra doce mutantes, cuatro sobrevivian: aflojar el techo de
 * acronimo, aflojar el techo numerico, quitar la cola de severidad compuesta y quitar `redactMeta`
 * de `logRedacted`. Los cuatro los mata la suite del paquete, pero un sello que no los mata no es
 * una segunda red: es la misma red mirando de lado. Cada testigo de aqui existe para uno.
 */
describe('(7) sello — los mutantes que el sello no mataba', () => {
  it('el techo de ACRONIMO: una cabeza de palabra no da coartada a un segmento mixto', async () => {
    // Mata «subir el techo de acronimo de 3 a 8»: `U9PK` es un PCC, y con la palabra `pcc` delante
    // la estructura ya tiene su `words > 0`, asi que lo unico que lo tumba es el techo.
    const observed = await post({ errors: [{ severity: 'Error', code: 'pcc.U9PK' }] });
    expect(surfacesCarrying(observed.surfaces, 'U9PK')).toEqual([]);
  });

  it('el techo NUMERICO: una cabeza de palabra no da coartada a una tirada de digitos', async () => {
    // Mata «subir el techo numerico de 4 a 20»: `1020304050` es una cedula colombiana.
    const observed = await post({ errors: [{ severity: 'Error', code: 'doc.1020304050' }] });
    expect(surfacesCarrying(observed.surfaces, '1020304050')).toEqual([]);
  });

  it('la cola de severidad compuesta se conserva para el vocabulario que la trae', async () => {
    // Mata «quitar la cola de severidad compuesta»: los 44 valores compuestos del expediente
    // acaban en `/WARNING` o `/ERROR`, y sin la cola el mas frecuente deja de publicarse.
    for (const value of ['CANCELLATION_ERROR/WARNING', 'CHECK_ERROR/WARNING', 'RS/Warning']) {
      const observed = await post({ errors: [{ severity: 'Error', category: value }] });
      expect(observed.surfaces.issues, `${value} dejo de publicarse`).toContain(value);
    }
  });

  it('el `path` CRUDO del log de entitlement pasa por redactMeta', async () => {
    // Mata «quitar redactMeta de logRedacted». `sabre.http.entitlement_parcial` y `sabre.http.ok`
    // loguean el `path` tal y como llego, sin pasar por `toLogMeta()`; si alguien construye la URL
    // a mano, ahi viaja un parametro de matriz con el token. Es el unico sitio donde `redactMeta`
    // es lo unico que queda en pie.
    const secret = 'ATKSUPERSECRETO1234567890';
    const observed = await post(
      { warnings: [{ severity: 'Warning', category: 'RESOURCE_RESTRICTED' }] },
      200,
      `/v5/offers/shop;access_token=${secret}`,
    );
    expect(observed.logEvents).toContain('sabre.http.entitlement_parcial');
    expect(observed.surfaces.logDump).not.toContain(secret);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (8) LA SEPTIMA SUPERFICIE: `SabreConfigError.message`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * La matriz mide SEIS superficies de `SabreApiError`. `postJson` puede lanzar una clase mas
 * —`SabreConfigError`, la guarda de modo mock— y su mensaje NO pasa por `redactPath`: lleva la
 * ruta tal y como llego. Todos los demas carriles del paquete la redactan (el constructor de
 * `SabreApiError` con `redactPath`, el log con `redactMeta`); este es el unico que no.
 *
 * Importa mas desde esta ronda porque el carril ya no muere en el paquete: `apps/api` declara
 * `@sales-travel/sabre` como dependencia y `humanizeSabreError` interpola `err.message` de un
 * `SabreConfigError` DENTRO de la respuesta HTTP 502 que ve el navegador del vendedor.
 *
 * Hoy no filtra nada: el ACL construye las rutas con sus propias constantes. Se fija el
 * comportamiento REAL para que el dia que se redacte la suite se ponga roja aqui.
 */
describe('(8) sello — la ruta cruda de SabreConfigError', () => {
  it('FRONTERA: la guarda de modo mock publica la ruta SIN redactar', async () => {
    const mockCfg: SabreConfig = { host: SABRE_HOSTS.cert.rest, conversationIdPrefix: 'sello' };
    const http = new SabreHttpClient(mockCfg, tokens, { uuid: () => 'conv-sello' });
    const thrown = await http.postJson('/v5/offers/shop;access_token=ATKSECRETO123456789', {}).then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(SabreConfigError);
    expect((thrown as Error).message).toContain('ATKSECRETO123456789');
  });

  it('en cambio SabreApiError redacta la ruta en las seis superficies', async () => {
    const observed = await post(
      { errors: [{ severity: 'Error', code: 'ERR.0161' }] },
      200,
      '/v5/offers/shop;access_token=ATKSECRETO123456789',
    );
    expect(surfacesCarrying(observed.surfaces, 'ATKSECRETO123456789')).toEqual([]);
  });
});
