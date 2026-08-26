import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { SabreTokenService, type SabreFetch, type SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_ISSUE_OPAQUE_VALUE, SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { FREE_TEXT, safeBodySummary } from './redaction';

/**
 * La MISMA puerta, las SEIS superficies.
 *
 * ## Qué se midió, y por qué no bastaba lo de la ronda 11
 *
 * La ronda 11 cerró la publicación de datos de viaje en tres superficies del error: `issues`,
 * `toLogMeta()` y lo que llega al `LoggerPort`. El mensaje y el cuerpo no pasaban por esa puerta:
 * pasaban sólo por `safeBodySummary`, que tapa por CLAVE (`FREE_TEXT_KEYS`) y por FORMA
 * (`clientId`, JWT, base64 largo, PAN por Luhn). Ninguna de las dos ve un identificador de viaje:
 * un pasaporte, un localizador, un billete, un teléfono, un EPR o un PCC son cortos, no llevan
 * espacios, no pasan por Luhn y no viven bajo una clave sensible.
 *
 * Medido por `postJson` con `{"errors":[{"severity":"Error","<casilla>":"<testigo>"}]}`, 14 datos
 * reales de viaje × 4 casillas = 56 combinaciones:
 *
 *     antes:   40 de 56 llegaban LITERALES a `error.message` y las mismas 40 a `error.body`
 *     después:  0 de 56, en las seis superficies y por los cuatro portadores
 *
 * Y el mensaje es de donde tira monitorización cuando algo revienta, o sea la superficie que más
 * lejos viaja de las seis.
 *
 * ## La regla de este fichero
 *
 * Todo entra por `SabreHttpClient.postJson` o por `SabreTokenService.getToken`. Un test que llame
 * a la función interna demuestra que la función es correcta, jamás que sea la que corre.
 *
 * Y cada bloque nombra el mutante que mata:
 *
 *   §1 quitar `sabreSafeIssueSlots` del constructor, o quitar `SABRE_ISSUE_SLOT_KEYS` una casilla,
 *      o leer las claves con caja exacta en vez de con `normalizeEnvelopeToken`.
 *   §2 quitar `sabreSafeJoinedValue` del `code`.
 *   §3 el PRECIO. No mata mutantes de seguridad: mata el mutante de pasar el cuerpo ENTERO por la
 *      puerta, que deja el error indiagnosticable. Se pone rojo si alguien lo intenta.
 *   §4 ninguno. Fija un límite CONOCIDO y abierto para que se vea.
 *   §5 clasificar sobre el texto ya redactado en vez de sobre el crudo.
 */

const SHOP_PATH = '/v5/offers/shop';

const CREDENTIALS = { epr: '500001', homePcc: 'U9PK', password: 'Pa55w0rd!' } as const;

function config(): SabreConfig {
  return { host: SABRE_HOSTS.cert.rest, ...CREDENTIALS, conversationIdPrefix: 'sales-travel' };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

/**
 * Las SEIS superficies por las que un `SabreApiError` saca datos del proveedor del proceso.
 *
 * Las tres primeras las cerró la ronda 11 y siguen aquí a propósito: una matriz que sólo mirase
 * las nuevas no vería una regresión en las viejas, y son la misma puerta.
 */
interface Surfaces {
  readonly message: string;
  readonly body: string;
  readonly code: string;
  readonly issues: string;
  readonly logMeta: string;
  readonly logDump: string;
}

interface Observed {
  readonly rejected: boolean;
  readonly surfaces: Surfaces;
}

async function post(payload: unknown, status = 200, path = SHOP_PATH): Promise<Observed> {
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
    Promise.resolve(
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
    );
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
  const error = outcome instanceof SabreApiError ? outcome : null;
  return {
    rejected: error !== null,
    surfaces: {
      message: error?.message ?? '',
      body: error?.body ?? '',
      code: error?.code ?? '',
      issues: JSON.stringify(error?.issues ?? []),
      logMeta: JSON.stringify(error?.toLogMeta() ?? {}),
      logDump: JSON.stringify(calls),
    },
  };
}

/**
 * Los nombres de las superficies se enumeran a mano y no con `Object.keys`: así, añadir un campo
 * a `Surfaces` sin añadirlo aquí es un error de tipos y no una superficie que deja de mirarse en
 * silencio.
 */
const SURFACE_NAMES: readonly (keyof Surfaces)[] = [
  'message',
  'body',
  'code',
  'issues',
  'logMeta',
  'logDump',
];

function surfacesCarrying(surfaces: Surfaces, witness: string): string[] {
  return SURFACE_NAMES.filter((name) => surfaces[name].includes(witness));
}

/* ────────────────────────────────────────────────────────────────────────────
 * (1) La matriz 4 × 14 sobre las seis superficies
 * ──────────────────────────────────────────────────────────────────────────── */

/** Las casillas de vocabulario que el proveedor rellena en un item de problema. */
const ISSUE_SLOTS = ['category', 'type', 'code', 'fieldPath'] as const;

/**
 * Catorce datos con la forma REAL de lo que circula por un sobre de Sabre. Los doce primeros son
 * los de `errors.issue-vocabulary.test.ts` —para que las dos matrices midan lo mismo y no puedan
 * derivar—; los dos últimos se añaden en esta ronda porque son los que rompieron el primer
 * intento de arreglo: un email y un número de viajero frecuente.
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
  ['email del pasajero', 'juan.perez@agencia.com.co'],
  ['viajero frecuente', 'LA1234567'],
];

const MATRIX = TRAVEL_DATA.flatMap(([label, value]) =>
  ISSUE_SLOTS.map((slot) => [`${slot} ← ${label}`, slot, value] as const),
);

/**
 * La misma casilla escrita como Sabre la escribe en sus otros dialectos. `envelopeIssueField`
 * resuelve las cuatro a la misma casilla, así que la puerta del mensaje tiene que resolverlas
 * igual — y `field_path` es la que mide el eje de la puntuación, el único que un `toUpperCase`
 * no cubre.
 */
const SLOT_DIALECT: Readonly<Record<(typeof ISSUE_SLOTS)[number], string>> = {
  category: 'Category',
  type: 'TYPE',
  code: 'Code',
  fieldPath: 'field_path',
};

/**
 * El SUELO de la matriz, y sin él no mediría nada: los catorce testigos tienen que llegar enteros
 * al `message` y al `body` cuando viajan bajo una clave que NO es casilla de vocabulario.
 *
 * Es lo que demuestra que las seis superficies de abajo salen limpias por la puerta nueva y no
 * porque `redaction.ts` ya tapara el testigo por su cuenta. Con este suelo, un testigo que
 * `redactText` reconociera por forma se cae del bloque en vez de dar un verde vacío.
 */
const SHAPE_REDACTED = new Set([
  'V1:500001:ZZ1A:AA',
  '4111111111111111',
  'VmpFOjUwMDAwMTpaWjFBOkFBOlBhNTV3MHJkIQ',
  'eyJhbGciOiJIUzI1NiJ9.eyJlcHIiOiI1MDAwMDEifQ.c2ln',
]);

describe('la matriz 4 × 14 — ningún dato de viaje sale por ninguna de las seis superficies', () => {
  it('suelo: los testigos que no tienen forma reconocible SÍ salían, y por eso miden', async () => {
    // Bajo `fieldName` —que no es casilla de vocabulario— el testigo llega entero. Si esto se
    // pusiera verde para todos, la matriz estaría midiendo la redacción por forma y no la puerta.
    const escaped: string[] = [];
    for (const [, value] of TRAVEL_DATA) {
      if (SHAPE_REDACTED.has(value)) continue;
      const observed = await post({ errors: [{ severity: 'Error', fieldName: value }] });
      if (!observed.surfaces.body.includes(value)) escaped.push(value);
    }

    expect(escaped, 'testigo que ya se tapaba por otra vía: no prueba nada').toEqual([]);
    expect(MATRIX).toHaveLength(56);
  });

  it.each(MATRIX)('%s: `errors[]` de record — cero de seis superficies', async (name, slot, v) => {
    const observed = await post({ errors: [{ severity: 'Error', [slot]: v }] });

    // Primero lo que no puede cambiar: tapar no puede convertir un fallo en un éxito.
    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(surfacesCarrying(observed.surfaces, v), name).toEqual([]);
  });

  it.each(MATRIX)('%s: portador `messages[]`', async (name, slot, v) => {
    const observed = await post({ messages: [{ severity: 'Error', [slot]: v }] });

    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(surfacesCarrying(observed.surfaces, v), name).toEqual([]);
  });

  it.each(MATRIX)(
    '%s: con la clave en OTRO dialecto, como Sabre mezcla de verdad',
    async (name, slot, v) => {
      // La puerta lee las claves con `normalizeEnvelopeToken` —sin caja y sin puntuación—, igual
      // que el recorrido del sobre. Y tiene que ser ése y no otro, porque Sabre mezcla las dos
      // convenciones dentro del mismo cuerpo: contenedores en PascalCase y hojas en camelCase, más
      // el dialecto con guiones bajos de OAuth2 (`error_description`, `expires_in`).
      //
      // MUTANTE QUE MATA: leer la clave con `key.toUpperCase()` en vez de con
      // `normalizeEnvelopeToken`. El eje de la CAJA sobrevive —`CODE` es `CODE` de las dos
      // maneras—, así que lo que lo mata es el eje de la PUNTUACIÓN: con `toUpperCase`,
      // `field_path` sale `FIELD_PATH`, se queda fuera del set y el testigo vuelve al `body` y al
      // `message` mientras el issue —que sí lo resuelve— lo publica tapado. O sea justo la
      // asimetría fail-open que la ronda 10 encontró un nivel más abajo, aquí otra vez.
      const dialect = SLOT_DIALECT[slot];
      const observed = await post({ Errors: [{ Severity: 'Error', [dialect]: v }] });

      expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
      expect(surfacesCarrying(observed.surfaces, v), `${name} (clave «${dialect}»)`).toEqual([]);
    },
  );

  it.each(TRAVEL_DATA)(
    '%s: un valor LARGO no se salta la puerta por ser largo',
    async (name, value) => {
      // Hallazgo de esta misma ronda, encontrado escribiendo el tope de crecimiento del `code`.
      //
      // El emparejado de pares tenía el valor acotado a 256 caracteres «por si acaso». El efecto
      // era el contrario del que se buscaba: un valor más largo que el tope NO casa el par, la
      // puerta no lo ve y sale entero por el `body` y por el `message`. Un tope que hace que lo
      // grande se salte el filtro es fail-open, y lo grande es exactamente lo que manda quien
      // quiere colar algo.
      //
      // El testigo va DELANTE y el relleno detrás, y no al revés: `safeBodySummary` corta el
      // resumen a 300 caracteres, así que un testigo al final lo tapaba el truncado y el bloque
      // daba verde por el motivo equivocado. Con el testigo delante, lo único que decide es si el
      // par entró por la puerta. El relleno sólo tiene que empujar el valor por encima del tope.
      const padded = `${value} ${'relleno.diagnostico '.repeat(20)}`;
      const observed = await post({ errors: [{ severity: 'Error', category: padded }] });

      expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
      expect(surfacesCarrying(observed.surfaces, value), name).toEqual([]);
    },
  );

  it.each(MATRIX)('%s: capa de TRANSPORTE (`errorCode` de un 403)', async (name, slot, v) => {
    // El otro dialecto de error, `{status, type, errorCode, timeStamp, message}`. Aquí el dato
    // pasa además por `error.code`, que es la casilla que el mensaje lleva en el prefijo.
    const observed = await post(
      { status: 'NotProcessed', errorCode: v, [slot]: v },
      403,
      '/v1/trip/orders/getBookingSummary',
    );

    expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
    expect(surfacesCarrying(observed.surfaces, v), name).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) El `code` concatenado: se trocea, y por una razón que está en el contrato
 * ──────────────────────────────────────────────────────────────────────────── */

describe('el `code` es el único campo que se juzga token a token', () => {
  it('el eco de OAuth2 conserva el literal que clasifica y suelta la credencial', async () => {
    // `invalid_client:{clientId}:{secret}` — Sabre pega el eco de nuestra request al literal de la
    // tabla (docs/sabre/01 §5.3). Juzgado ENTERO no pasa la forma y saldría como una sola marca; y
    // con él se iría `invalid_client`, que es lo que le explica a soporte por qué el veredicto fue
    // `AUTH_POOL` —saturación temporal, se reintenta— y no una credencial revocada.
    //
    // El orden es lo que lo hace funcionar y conviene dejarlo dicho: `redactText` corre PRIMERO y
    // sustituye el `clientId` y el `secret` por sus marcas, con lo que la concatenación queda rota
    // en tres; el troceo juzga entonces `invalid_client` por su cuenta y lo publica.
    const echoed = `invalid_client:V1:${CREDENTIALS.epr}:${CREDENTIALS.homePcc}:AA:VmpFOjUwMDAwMTpVOVBLOkFBOlBhNTV3MHJkIQ`;
    const observed = await post({ error: echoed }, 401, '/v2/auth/token');

    expect(observed.surfaces.code).toContain('invalid_client');
    expect(surfacesCarrying(observed.surfaces, CREDENTIALS.password)).toEqual([]);
    expect(surfacesCarrying(observed.surfaces, `V1:${CREDENTIALS.epr}`)).toEqual([]);
  });

  it('una concatenación que la forma NO rompe se juzga entera, y eso es el lado seguro', async () => {
    // El contrapunto honesto del test de arriba: el troceo no es una licencia para publicar trozos
    // de cualquier cosa. Si `redactText` no reconoce la credencial, el `:` no es separador de
    // vocabulario —`SMITH/JOHNMR` y `V1:…` son la razón de que no lo sea— y el token entero cae.
    // Se pierde `invalid_client` en ese caso; se prefiere perderlo a publicar lo que va pegado.
    const observed = await post({ error: 'invalid_client:AB1234567' }, 401, '/v2/auth/token');

    expect(observed.surfaces.code).toBe(SABRE_ISSUE_OPAQUE_VALUE);
    expect(surfacesCarrying(observed.surfaces, 'AB1234567')).toEqual([]);
  });

  it('el filtro CRECE, y el tope está puesto: un `code` hostil no infla el mensaje sin freno', async () => {
    // La sustitución cambia cuatro caracteres por veintiuno, así que sin tope un `code` hostil de
    // tokens cortos multiplica el mensaje por cinco. Esto fija que el tope existe y que corta.
    const hostile = Array.from({ length: 400 }, () => 'ZZ1A').join(' ');
    const observed = await post({ errorCode: hostile }, 500);

    expect(observed.surfaces.code.length).toBeLessThanOrEqual(513);
    expect(observed.surfaces.code).toContain(SABRE_ISSUE_OPAQUE_VALUE);
    expect(surfacesCarrying(observed.surfaces, 'ZZ1A')).toEqual([]);
  });

  it('y el tope no toca ningún `code` real: el vocabulario más largo pasa entero', async () => {
    // El contrapeso del tope. El valor más largo del expediente mide 69 caracteres; 512 deja
    // margen de sobra y este test lo fija para que bajarlo no pueda pasar desapercibido.
    const longest = 'UNABLE_TO_MODIFY_BOOKING_SPECIAL_SERVICE_TRAVELER_ASSOCIATION_INVALID';
    const observed = await post({ errorCode: longest }, 500);

    expect(observed.surfaces.code).toBe(longest);
  });

  it('MUTANTE: sin el troceo, el `errorCode` opaco vuelve al prefijo del mensaje', async () => {
    // Quitar `sabreSafeJoinedValue` del `code` deja este testigo entero en `message`, `code`,
    // `toLogMeta()` y el `LoggerPort` a la vez — cuatro de las seis superficies.
    const observed = await post({ errorCode: 'XKCD12' }, 500);

    expect(observed.surfaces.code).toBe(SABRE_ISSUE_OPAQUE_VALUE);
    expect(surfacesCarrying(observed.surfaces, 'XKCD12')).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) EL PRECIO — lo que tiene que seguir saliendo entero
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Este bloque es la mitad cara del trato y existe para que no se pueda «endurecer» más sin verlo.
 *
 * El primer intento de arreglo pasó el cuerpo ENTERO por la puerta de vocabulario, token a token.
 * Cerraba la matriz igual de bien y dejaba **37 tests en rojo repartidos por 8 ficheros** de este
 * paquete, la mayoría de FALSO POSITIVO: los importes, los `404`, `reason: ABC1`, los números de
 * referencia con guiones, los códigos numéricos de hoteles y hasta nuestro propio literal
 * «respuesta 2xx no parseable como JSON», al que la regla le come el `2xx`. Un error
 * indiagnosticable es un fallo operativo aunque no sea de seguridad, así que la puerta se acotó a
 * las CASILLAS DE VOCABULARIO, que es donde la puerta del issue ya la aplica.
 *
 * El mutante está medido con la suite entera, no razonado: `safeBody = sabreSafeJoinedValue(
 * safeBodySummary(body))` en vez de `safeBodySummary(sabreSafeIssueSlots(body))`.
 */

describe('el precio — el vocabulario del contrato sigue saliendo entero en el mensaje', () => {
  it.each([
    ['ERR.2SG.SEC.INVALID_CREDENTIALS', 'code'],
    ['ERR.2SG.GATEWAY.REQUEST_THROTTLED', 'code'],
    ['ERR.0161', 'code'],
    ['APPLICATION_ERROR', 'category'],
    ['CANCELLATION_ERROR/WARNING', 'category'],
    ['UNABLE_TO_MODIFY_BOOKING_SPECIAL_SERVICE_TRAVELER_ASSOCIATION_INVALID', 'type'],
    ['travelers[0].passport', 'fieldPath'],
    ['passenger.givenName', 'fieldPath'],
  ] as const)('`%s` en `%s` llega entero al message y al body', async (value, slot) => {
    const observed = await post({ errors: [{ severity: 'Error', [slot]: value }] });

    expect(observed.surfaces.message, 'el error se quedó sin diagnóstico').toContain(value);
    expect(observed.surfaces.body).toContain(value);
    expect(observed.surfaces.issues).toContain(value);
  });

  it('un cuerpo de vocabulario sale del filtro BYTE A BYTE igual que entró', async () => {
    // La medida dura del falso positivo: sobre un sobre entero de vocabulario, la puerta no toca
    // ni un carácter. Si algún día toca alguno, este test dice exactamente cuál.
    const body = JSON.stringify({
      errors: [
        {
          severity: 'Error',
          category: 'APPLICATION_ERROR',
          type: 'REQUIRED_FIELD_MISSING',
          code: 'ERR.2SG.CLIENT.INVALID_REQUEST',
          fieldPath: 'someObject.someFieldName',
        },
      ],
    });
    const observed = await post(JSON.parse(body));

    expect(observed.surfaces.body).toBe(safeBodySummary(body));
  });

  it('lo que NO es casilla de vocabulario no lo toca la puerta', async () => {
    // El otro lado del acotado: `error.body` es el eco diagnóstico del cuerpo y conserva todo lo
    // que las rejillas de `redaction.ts` no tapan. Ésa es una política medida de este paquete, no
    // un descuido, y esta ronda no la cambia.
    const observed = await post({
      errors: [{ severity: 'Error', code: 'ERR.0161', fieldName: 'itemId', reason: 'ABC1' }],
      totalFare: 1234.56,
    });

    expect(observed.surfaces.body).toContain('itemId');
    expect(observed.surfaces.body).toContain('ABC1');
    expect(observed.surfaces.body).toContain('1234.56');
    expect(observed.surfaces.body).not.toContain(FREE_TEXT);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) EL LÍMITE CONOCIDO — el dialecto XML no pasa por esta puerta
 * ──────────────────────────────────────────────────────────────────────────── */

describe('límite aceptado y fijado: la puerta reconoce el dialecto JSON', () => {
  it('una casilla echada en XML/SOAP sigue saliendo entera en el `body`', async () => {
    // Se escribe como TEST y no como comentario porque un límite que sólo vive en prosa se olvida.
    //
    // La puerta empareja `"clave": "valor"` de JSON, que es el dialecto de los 21 contratos REST y
    // el de todo lo que llega hoy. `<code>AB1234567</code>` no pasa por ella. NO se cierra en
    // `errors.ts` a propósito: los tres dialectos viven en las rejillas de `redaction.ts`, y una
    // cuarta copia del emparejamiento clave-valor aquí es exactamente cómo empiezan a divergir dos
    // reglas en este paquete — que es lo que ya costó un incidente en la ronda 2.
    //
    // SI ESTE TEST SE PONE ROJO: alguien cerró el hueco. Bien; entonces hay que comprobar dónde lo
    // cerró y que no sea en una segunda copia de la regla.
    const observed = await post('<Errors><code>AB1234567</code></Errors>', 500);

    expect(observed.surfaces.body).toContain('AB1234567');
    // Lo que sí está cerrado en las dos vías: el issue nunca lo publica, porque el recorrido del
    // sobre no lee XML y no fabrica casillas con él.
    expect(observed.surfaces.issues).not.toContain('AB1234567');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) INVARIANTE LOAD-BEARING: se clasifica sobre el texto CRUDO
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `errors.ts` lo dice en el constructor de `SabreApiError` y `token.service.ts` lo repite en su
 * carril 401: «la tabla 2SG compara literales y sobre texto redactado no acertaría». Hasta esta
 * ronda ninguna de las dos afirmaciones tenía test: el mutante que clasifica sobre el texto ya
 * redactado dejaba las 1.298 pruebas del paquete en VERDE.
 *
 * Lo que hay debajo no es cosmético. `error_description` es clave de TEXTO LIBRE, así que la
 * redacción la sustituye entera; y es justo donde vive «Wrong clientID or clientSecret», el único
 * literal que distingue una credencial confirmadamente MALA de una saturación temporal del TAM
 * Pool. Clasificando sobre lo redactado, el veredicto cae al `invalid_client` genérico:
 *
 *     crudo     → CREDENTIALS_INVALID, disableAccount, NO_RETRY   (se marca la cuenta BYOC)
 *     redactado → AUTH_POOL,           sin marca,      RETRY      (se reintenta tres veces)
 *
 * O sea: la agencia con el password mal puesto no se entera nunca, y cada búsqueda le cuesta tres
 * llamadas contra Sabre.
 */

async function failAuth(body: Record<string, unknown>): Promise<SabreApiError> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 401 }));
  const service = new SabreTokenService(config(), {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
  });
  const error = (await service.getToken().catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return error;
}

describe('se clasifica con lo CRUDO y se publica sólo lo redactado', () => {
  const WRONG_CREDENTIALS = {
    error: 'invalid_client',
    error_description: 'Wrong clientID or clientSecret',
  };

  it('suelo: el literal que decide NO sobrevive a la redacción (si sobreviviera, no hay mutante)', () => {
    // Sin este suelo el bloque sería vacuo: si el texto redactado siguiera conteniendo «Wrong
    // clientID», clasificar antes o después daría lo mismo y el test no mediría el orden.
    const summary = safeBodySummary(JSON.stringify(WRONG_CREDENTIALS));

    expect(summary).not.toContain('Wrong clientID');
    expect(summary).toContain(FREE_TEXT);
  });

  it('la cuenta BYOC se marca como credenciales inválidas, no como saturación del pool', async () => {
    // MUTANTE QUE MATA: clasificar sobre el texto redactado en el carril 401 del token service
    // (o en el constructor de `SabreApiError`, que documenta la misma regla). El veredicto cae a
    // `AUTH_POOL` sin `disableAccount` y este test se pone rojo.
    const error = await failAuth(WRONG_CREDENTIALS);

    expect(error.failure.kind).toBe('CREDENTIALS_INVALID');
    expect(error.failure.disableAccount, 'nadie marca la cuenta de esa agencia').toBe(true);
    expect(error.failure.retry).toBe('NO_RETRY');
  });

  it('CONTRA-MUTANTE: sin el literal, el mismo `invalid_client` NO marca la cuenta', async () => {
    // El testigo del bloque. Sin él, `CREDENTIALS_INVALID` podría venir del código y no del texto,
    // y entonces el test de arriba no mediría sobre qué se clasifica.
    const error = await failAuth({ error: 'invalid_client' });

    expect(error.failure.kind).toBe('AUTH_POOL');
    expect(error.failure.disableAccount).toBe(false);
  });

  it('y aun así el texto que clasificó NO se publica por ninguna superficie', async () => {
    // Las dos mitades del trato en el mismo error: se decide con lo crudo, se publica lo redactado.
    const error = await failAuth(WRONG_CREDENTIALS);

    expect(error.message).not.toContain('Wrong clientID');
    expect(error.body).not.toContain('Wrong clientID');
    expect(JSON.stringify(error.toLogMeta())).not.toContain('Wrong clientID');
  });
});
