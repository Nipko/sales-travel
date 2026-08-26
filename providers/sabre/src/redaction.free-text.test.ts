import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { FREE_TEXT, REDACTED, isFreeTextKey, isSensitiveKey } from './redaction';

/**
 * El TEXTO LIBRE del proveedor no viaja al mensaje ni al body — y el precio se mide.
 *
 * ## El hueco
 *
 * Los diez carriles de `redaction.ts` buscan una CLAVE sensible o una FORMA verificable. La prosa
 * del proveedor no tiene ninguna de las dos: `description`, `message`, `text` o `fieldValue` son
 * claves inocuas cuyo valor es una frase, y una frase no tiene forma. Todo lo que Sabre metiera ahí
 * llegaba VERBATIM a `SabreApiError.body` y a `SabreApiError.message`.
 *
 * Y Sabre es agregador: hace eco de lo que le devuelve el sistema de detrás. No es hipótesis, está
 * publicado. Las listas oficiales de errores de Booking Management son plantillas con `%s`:
 *
 *   - `PNR %s not found for specified ticket`
 *     (`help/booking-management-api-v1/help-documentation-check-flight-tickets-error-list.txt:155`)
 *   - `%s booking has already been canceled by the airline`
 *     (`…/help-documentation-cancel-booking-error-list.txt:407`)
 *   - `The (service ActionCode) service returned an error: (code: [%s] message: [%s])`
 *     (`…/help-documentation-create-booking-error-list.txt:29`)
 *   - y el propio proveedor rematando: «Variable %s contains information returned dynamically by
 *     the downline service» (`…/help-documentation-cancel-booking-error-list.txt:482`)
 *
 * Más `Error.fieldValue`, que el contrato define como «The field value of the request»
 * (`booking-management-v1.yml:4298`): el eco LITERAL de un valor que mandamos nosotros. Si el error
 * fue en `passportNumber`, el pasaporte está ahí.
 *
 * ## La decisión
 *
 * El texto libre se sustituye por {@link FREE_TEXT} y el diagnóstico se apoya en los campos
 * ESTRUCTURADOS —`category`, `type`, `errorCode`, `fieldPath`, `severity`, `status`—, que es la
 * misma decisión que ya se tomó para `SabreIssue` en la ronda 5. La clasificación NO cambia: se
 * decide sobre el cuerpo CRUDO en el constructor de `SabreApiError`, antes de resumir.
 *
 * ## El precio, y por qué se mide aquí
 *
 * Un clasificador —o un redactor— demasiado estricto deja al vendedor sin nada delante de un
 * cliente, y eso también es un fallo de producción. Así que este endurecimiento paga su prueba de
 * FALSO POSITIVO contra los cuerpos oficiales de `docs/sabre/evidence/specs/help/`: se exige que lo
 * único enmascarado sea exactamente lo que la política dice enmascarar, y que el conjunto de claves
 * afectadas en todo el corpus sea el que está fijado abajo. Ampliar la lista de texto libre mueve
 * ese conjunto y obliga a mirar el coste antes de dar el cambio por bueno.
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

/** Puerta pública: el cuerpo entra por `postJson` y sale por el error y por el log. */
async function throughHttpClient(
  body: string,
  status = 500,
): Promise<{ error: SabreApiError; logDump: string }> {
  const fetchImpl: SabreFetch = () => Promise.resolve(new Response(body, { status }));
  const { logger, calls } = spyLogger();
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const error = (await http.postJson(SHOP_PATH, {}).catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return { error, logDump: JSON.stringify(calls) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. El hueco, con las plantillas oficiales rellenas
 * ──────────────────────────────────────────────────────────────────────────── */

/** Testigos: lo que las plantillas `%s` interpolan de verdad. */
const PNR = 'XKCD12';
const PASSENGER = 'SMITH/JOHNMR';
const PASSPORT_ECHO = 'AB1234567';

describe('el texto libre del proveedor no llega al error ni al log', () => {
  it.each([
    [
      'description con un PNR (plantilla oficial de checkFlightTickets)',
      JSON.stringify({
        errors: [
          {
            category: 'BUSINESS_ERROR',
            type: 'TICKET_NOT_FOUND',
            description: `PNR ${PNR} not found for specified ticket`,
          },
        ],
      }),
      PNR,
    ],
    [
      'description con el nombre del pasajero',
      JSON.stringify({
        errors: [
          {
            category: 'APPLICATION_ERROR',
            type: 'DOWNLINE_SERVICE_ERROR',
            description: `The AirTicketRQ service returned an error: (code: [7] message: [NAME ${PASSENGER} NOT ON FILE])`,
          },
        ],
      }),
      PASSENGER,
    ],
    [
      'fieldValue: el eco literal del valor que mandamos',
      JSON.stringify({
        errors: [
          {
            category: 'BAD_REQUEST',
            type: 'INVALID_FORMAT',
            fieldPath: 'createBookingRequest.travelers[0]',
            fieldName: 'passportNumber',
            fieldValue: PASSPORT_ECHO,
          },
        ],
      }),
      PASSPORT_ECHO,
    ],
    [
      'message de la capa de transporte',
      JSON.stringify({
        status: 'NotProcessed',
        type: 'Validation',
        errorCode: 'ERR.2SG.CLIENT.INVALID_REQUEST',
        message: `Booking ${PNR} for ${PASSENGER} could not be processed`,
      }),
      PNR,
    ],
    [
      'error_description de OAuth2, donde Sabre hace eco de la request entera',
      JSON.stringify({
        error: 'invalid_client',
        error_description: `Wrong clientID or clientSecret for ${PASSENGER}`,
      }),
      PASSENGER,
    ],
    [
      'MessageType.text de BFM («Free text dependent on the issuing party»)',
      JSON.stringify({ messages: [{ code: 'RULEID', severity: 'Info', text: `PNR ${PNR}` }] }),
      PNR,
    ],
    [
      'remarks del PNR, escritas por un agente humano',
      JSON.stringify({ errors: [{ category: 'X', type: 'Y' }], remarks: `CTC ${PASSENGER}` }),
      PASSENGER,
    ],
  ])('%s', async (_name, body, witness) => {
    const { error, logDump } = await throughHttpClient(body);
    expect(error.body, 'el texto libre llegó al body del error').not.toContain(witness);
    expect(error.message, 'el texto libre llegó al mensaje del error').not.toContain(witness);
    expect(logDump, 'el texto libre llegó al log').not.toContain(witness);
    expect(error.body).toContain(FREE_TEXT);
  });

  it('la marca de texto libre es DISTINTA de la de secreto: dicen cosas distintas', () => {
    // Quien lee el log tiene que poder separar «aquí había un secreto» de «aquí había prosa del
    // proveedor y no se transporta». Colapsarlas en una sola marca pierde esa información.
    expect(FREE_TEXT).not.toBe(REDACTED);
  });

  it('un secreto bajo una clave de texto libre se tapa como SECRETO, no como prosa', async () => {
    // La precedencia vive en un solo sitio (`maskForKey`). Si alguien la invierte, un campo que es
    // secreto por nombre —`passwordMessage`— saldría marcado como prosa y el log mentiría sobre
    // qué se ocultó.
    const { error } = await throughHttpClient(
      JSON.stringify({ passwordMessage: 'Pa55w0rd! rechazado' }),
    );
    expect(error.body).toContain(REDACTED);
    expect(error.body).not.toContain('Pa55w0rd!');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. El diagnóstico sobrevive: es la mitad que hace aceptable la decisión
 * ──────────────────────────────────────────────────────────────────────────── */

describe('los campos ESTRUCTURADOS siguen enteros: el error sigue siendo diagnosticable', () => {
  /**
   * Cuerpo de error OFICIAL, copiado verbatim de
   * `help/booking-management-api-v1/help-documentation-cancel-booking-examples.txt:987-1000`.
   * Lleva las cuatro cosas a la vez: prosa (`description`), eco de la request (`fieldValue`) y los
   * dos campos estructurados que tienen que sobrevivir (`category`/`type`, `fieldPath`/`fieldName`).
   */
  const OFICIAL = JSON.stringify({
    errors: [
      {
        category: 'CANCELLATION_ERROR',
        type: 'UNABLE_TO_VOID_TICKET',
        description:
          'The ticket does not match the segments selected for cancellation. Review flights selection or void using /v1/trip/orders/cancelFlightTicket.',
        fieldPath: 'cancelBookingRequest.flights',
        fieldName: 'itemId',
        fieldValue: '[1251237703376, 6071237703375]',
      },
    ],
  });

  it.each([
    ['category', 'CANCELLATION_ERROR'],
    ['type', 'UNABLE_TO_VOID_TICKET'],
    ['fieldPath', 'cancelBookingRequest.flights'],
    ['fieldName', 'itemId'],
  ])('%s sobrevive en el resumen del error', async (_name, value) => {
    const { error } = await throughHttpClient(OFICIAL);
    expect(error.body, 'se está tapando de más: el error deja de ser diagnosticable').toContain(
      value,
    );
  });

  it('el eco de la request NO sobrevive, aunque su vecino estructural sí', async () => {
    const { error } = await throughHttpClient(OFICIAL);
    expect(error.body).not.toContain('1251237703376');
    // `fieldName` dice EN QUÉ campo falló, que es el dato de diagnóstico; `fieldValue` dice CON QUÉ
    // valor, que es el dato del pasajero. Se conserva el primero y se tira el segundo.
    expect(error.body).toContain('itemId');
  });

  it('la CLASIFICACIÓN no cambia: se decide sobre el cuerpo crudo, antes de resumir', async () => {
    // El carril que de verdad importa: si el texto libre se redactara ANTES de clasificar, la tabla
    // 2SG dejaría de casar sus literales y una credencial confirmadamente mala se degradaría a
    // fallo genérico. `error.body` sale enmascarado y `failure` sale igual que siempre.
    const body = JSON.stringify({
      error: 'invalid_client',
      error_description: 'Wrong clientID or clientSecret',
    });
    const { error } = await throughHttpClient(body, 401);
    expect(error.body).toContain(FREE_TEXT);
    expect(error.failure.disableAccount).toBe(true);
    expect(error.failure.kind).toBe('CREDENTIALS_INVALID');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Falso positivo: la lista es EXACTA, nunca por fragmento
 * ──────────────────────────────────────────────────────────────────────────── */

describe('FALSO POSITIVO — lo que NO es texto libre sigue saliendo entero', () => {
  /**
   * Claves vecinas que un `includes()` se llevaría por delante, y claves que el contrato documenta
   * como CÓDIGO y no como prosa: `reason` («Reason information», ejemplo `ABC1`,
   * `bargain-finder-max-v5.yml:8483`) y `content` («Identifies the context of the identifying code,
   * such as DUNS, IATA», `bargain-finder-max-v3.yml:4084`). Y `details`, que es un array
   * estructurado. Ninguna se tapa, y por eso la comparación es exacta y no por fragmento.
   */
  it.each([
    ['messageId', 'MSG-77'],
    ['descriptionCode', 'DSC-77'],
    ['textFormat', 'PlainText'],
    ['noteType', 'GENERAL'],
    ['reason', 'ABC1'],
    ['content', 'IATA'],
    ['severity', 'Info'],
    ['errorCode', 'ERR.2SG.CLIENT.INVALID_REQUEST'],
    ['confirmationId', 'GLEBNY'],
  ])('la clave %s conserva su valor', async (key, value) => {
    const { error } = await throughHttpClient(JSON.stringify({ [key]: value }));
    expect(error.body, `la clave ${key} se tapó y no es texto libre`).toContain(value);
    expect(error.body).not.toContain(FREE_TEXT);
  });

  it('`details`, que es un array estructurado, no se colapsa', async () => {
    // El sujeto de este test es `redaction.ts`: `details` NO está en `FREE_TEXT_KEYS`, así que el
    // array no se sustituye por una marca de texto libre y sus dos entradas siguen ahí como
    // estructura. Eso es lo que se mide, y sigue igual.
    const { error } = await throughHttpClient(
      JSON.stringify({ details: [{ code: 'MISSING_SEGMENT' }, { code: 'ERR.0161' }] }),
    );

    expect(error.body).not.toContain(FREE_TEXT);
    expect(error.body).toContain('MISSING_SEGMENT');
    expect(error.body).toContain('ERR.0161');
  });

  /**
   * El testigo original era `[{code:'BAG1'},{code:'BAG2'}]` y desde la ronda 12 no sale entero.
   * NO es que `details` se haya empezado a colapsar —el test de arriba lo fija—: es que `code` es
   * una casilla de VOCABULARIO y su valor pasa por la misma puerta que lo publica en el
   * `SabreIssue`. `BAG1` es un segmento mixto de cuatro caracteres y el techo de acrónimo es tres,
   * el que separa `2SG` de `ZZ1A` (el PCC de la oficina).
   *
   * O sea: el precio ya se pagaba desde la ronda 11 en `issues`, en `toLogMeta()` y en el
   * `LoggerPort`, y lo que la ronda 12 hizo fue que el `body` dejara de contradecirlos. Se deja
   * fijado para que la asimetría no pueda volver por descuido: si `BAG1` reaparece en el `body`,
   * es que el `body` volvió a ser la puerta floja.
   */
  it('un valor que la puerta del issue no publica tampoco vuelve por el `body`', async () => {
    const { error } = await throughHttpClient(
      JSON.stringify({ details: [{ code: 'BAG1' }, { code: 'BAG2' }] }),
    );

    expect(error.body).not.toContain('BAG1');
    expect(error.body).not.toContain('BAG2');
    expect(error.body, 'el array se colapsó: eso sí sería un falso positivo').toContain('details');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Falso positivo medido contra los cuerpos OFICIALES
 * ──────────────────────────────────────────────────────────────────────────── */

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('no se encontró la raíz del monorepo (pnpm-workspace.yaml)');
    dir = parent;
  }
}

const HELP_DIR = join(findRepoRoot(), 'docs', 'sabre', 'evidence', 'specs', 'help');

function helpFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return helpFiles(full);
    return entry.name.endsWith('.txt') ? [full] : [];
  });
}

/**
 * Un cuerpo del corpus lleva un PORTADOR DE ERROR si alguna de sus CLAVES contiene `error` o
 * `warning`. Es un criterio de una línea y a propósito: se publica junto al censo para dejar dicho
 * que este corpus mezcla éxitos y errores, no para clasificarlos. La heurística fina —la que mira
 * si el portador tiene contenido— vive en el corpus del CLASIFICADOR
 * (`errors.operation-context.test.ts`) y es justo la diferencia de criterio que hace que los dos
 * corpus den números distintos sobre la misma documentación.
 */
const ERROR_CARRIER_KEY = /"[^"]*(?:error|warning)[^"]*"\s*:/i;

/** Censo del extractor. Se publica ENTERO junto al número; ver {@link CORPUS_CRITERION}. */
interface CorpusCensus {
  readonly ficherosTxt: number;
  readonly ficherosQueAportanCuerpo: number;
  readonly lineasQueAbrenBloque: number;
  readonly descartadosPorNoParsear: number;
  readonly cuerposContados: number;
  readonly textosDistintos: number;
  readonly cuerposConPortadorDeError: number;
}

/**
 * **El criterio, escrito al lado del número.**
 *
 * Hasta la ronda 11 este corpus se publicaba como «N cuerpos oficiales» y lo único que lo sujetaba
 * era un suelo (`length >= 150`). Un suelo no es una medición: dos personas con dos extractores
 * distintos sacan dos números y los dos pasan. Y pasó — dos sellos de rondas distintas publicaron
 * dos cifras («1.576 ejemplos oficiales de éxito», «222») y ninguna de las dos se reproduce hoy
 * con ninguno de los dos extractores que el paquete tiene escritos. Una cifra con la que se decide
 * si el redactor está estrangulando el diagnóstico no puede depender de quién la contó.
 *
 * Desde esta ronda el criterio es DATO —{@link officialBodies} lo implementa y el censo se fija
 * entero abajo—, y son estas cinco reglas:
 *
 *  1. **Qué se lee.** `docs/sabre/evidence/specs/help/`, recursivo, y SÓLO los ficheros `.txt`.
 *     Los 13 `.json` y los `.html_*` del mismo directorio quedan fuera. Medido: incluir los `.json`
 *     no aporta ni un cuerpo más bajo la regla 2 —sus bloques no abren a columna 0— pero sí mueve
 *     `ficherosTxt` de 81 a 94, y con él el censo publicado. Se deja dicho cuál de las dos cosas
 *     cambia, que es justo lo que no estaba escrito. (El corpus del CLASIFICADOR sí los lee y
 *     además abre bloque con cualquier indentación; de ahí que su número sea otro.)
 *  2. **Qué abre un cuerpo.** Una línea que sea exactamente `{`, a columna 0. Es como el devhub
 *     pega sus ejemplos. Un objeto ANIDADO no abre cuerpo: se cuentan respuestas, no nodos — que
 *     es la diferencia entre 199 y las 7.124 llaves de apertura que hay en esos ficheros.
 *  3. **Qué lo cierra.** La primera `}` a columna 0 por debajo.
 *  4. **Qué cuenta.** Sólo si `JSON.parse` acepta el bloque; lo que no parsea se descarta y se
 *     cuenta como descartado. No se deduplica: el mismo cuerpo repetido en dos ficheros son dos
 *     observaciones, porque lo que se mide es cuántas veces la política se equivoca, no cuántos
 *     cuerpos distintos existen. El censo publica también los textos distintos para que la
 *     diferencia esté a la vista.
 *  5. **Qué NO se filtra.** Ni éxito ni error: entran los dos. El falso positivo del redactor se
 *     mide sobre todo lo que el proveedor publica.
 */
const CORPUS_CRITERION =
  'help/**/*.txt · bloque = línea `{` a columna 0 … primera `}` a columna 0 · cuenta si JSON.parse lo acepta · sin deduplicar · éxitos y errores';

/**
 * Cuerpos JSON oficiales embebidos en la documentación del devhub, extraídos por las cinco reglas
 * de {@link CORPUS_CRITERION}. Devuelve también el censo, porque publicar el número sin el criterio
 * es exactamente lo que dejó dos cifras contradictorias en dos sellos.
 */
function officialBodies(): {
  bodies: ReadonlyArray<{ file: string; json: string }>;
  census: CorpusCensus;
} {
  const out: { file: string; json: string }[] = [];
  const files = helpFiles(HELP_DIR);
  const contributing = new Set<string>();
  let opened = 0;
  let unparsed = 0;

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== '{') continue;
      opened++;
      const close = lines.indexOf('}', i + 1);
      if (close < 0) break;
      const json = lines.slice(i, close + 1).join('\n');
      try {
        JSON.parse(json);
        out.push({ file, json });
        contributing.add(file);
        i = close;
      } catch {
        // No era un cuerpo completo: se ignora y se sigue buscando desde la línea siguiente.
        unparsed++;
      }
    }
  }

  return {
    bodies: out,
    census: {
      ficherosTxt: files.length,
      ficherosQueAportanCuerpo: contributing.size,
      lineasQueAbrenBloque: opened,
      descartadosPorNoParsear: unparsed,
      cuerposContados: out.length,
      textosDistintos: new Set(out.map((body) => body.json)).size,
      cuerposConPortadorDeError: out.filter((body) => ERROR_CARRIER_KEY.test(body.json)).length,
    },
  };
}

/** `"clave":"«MARCA»"` tal y como sale del resumen. Es lo único que se puede observar de fuera. */
const MASKED_PAIR = new RegExp(`"([^"]{1,64})":"(${FREE_TEXT}|${REDACTED})"`, 'g');

describe('FALSO POSITIVO — medido sobre los cuerpos oficiales del devhub', () => {
  const { bodies: BODIES, census: CENSUS } = officialBodies();

  it('el corpus publica su censo: el mismo criterio da el mismo número a cualquiera', () => {
    // Sustituye al suelo `>= 150` que había aquí. El suelo impedía que el corpus se vaciara en
    // silencio y nada más: no fijaba el número, así que la cifra que se publicaba fuera dependía de
    // quién la contaba. Esto la fija, y la fija con su criterio delante ({@link CORPUS_CRITERION}).
    //
    // Si esto se pone rojo NO se toca el número a mano: o cambió `docs/sabre/evidence/specs/help/`
    // —y entonces hay que re-publicar la cifra donde se haya citado— o cambió el extractor, y
    // entonces hay dos criterios otra vez y hay que elegir uno.
    expect(CORPUS_CRITERION.length, 'el criterio no puede quedarse vacío').toBeGreaterThan(0);
    expect(CENSUS, `el censo del corpus cambió (criterio: ${CORPUS_CRITERION})`).toEqual({
      ficherosTxt: 81,
      ficherosQueAportanCuerpo: 25,
      lineasQueAbrenBloque: 205,
      descartadosPorNoParsear: 6,
      cuerposContados: 199,
      textosDistintos: 184,
      cuerposConPortadorDeError: 17,
    });
    expect(BODIES.length).toBe(CENSUS.cuerposContados);
  });

  /**
   * La marca de texto libre sólo puede venir del carril por clave: ninguna pasada por FORMA la
   * emite. Por eso ésta es la medición limpia del falso positivo de ESTE endurecimiento — no se
   * confunde con lo que ya tapaban los otros diez carriles.
   */
  it('toda marca de TEXTO LIBRE cae sobre una clave que la política clasifica como tal', async () => {
    const wrong: string[] = [];
    for (const { file, json } of BODIES) {
      const { error } = await throughHttpClient(json);
      for (const match of error.body.matchAll(MASKED_PAIR)) {
        const key = match[1] ?? '';
        if (match[2] === FREE_TEXT && !isFreeTextKey(key)) wrong.push(`${key} en ${file}`);
      }
    }
    expect(wrong, 'se tapó como prosa una clave que no es prosa').toEqual([]);
  });

  it('las claves de TEXTO LIBRE que aparecen en TODO el corpus son las fijadas', async () => {
    const masked = new Set<string>();
    for (const { json } of BODIES) {
      const { error } = await throughHttpClient(json);
      for (const match of error.body.matchAll(MASKED_PAIR)) {
        if (match[2] === FREE_TEXT) masked.add(match[1] ?? '');
      }
    }
    // El precio del carril sobre contenido oficial, en claves y no en prosa. Un endurecimiento que
    // empiece a tapar campos nuevos de los contratos mueve esta lista y obliga a justificar el coste
    // antes de darlo por bueno. Bajarla también es señal: significa que se dejó de tapar algo.
    expect([...masked].sort()).toEqual(['description', 'message', 'text']);
  });

  /**
   * El otro lado, y no es de este carril: qué tapan por SECRETO los diez carriles anteriores sobre
   * los mismos cuerpos oficiales. Se fija aquí porque es la foto de la que hay que partir para
   * discutir cualquier falso positivo futuro, y porque tiene un caso que conviene tener por escrito:
   *
   * `number` NO está en ninguna lista de claves. Lo tapa la regla de PAN, y no por la clave sino por
   * el VALOR: un número de billete es de 13 dígitos y algunos —`0017544536141` en los ejemplos
   * oficiales— pasan Luhn por coincidencia (el dígito de control de un billete es módulo 7, no
   * Luhn), así que caen del lado del PAN. Es un falso positivo REAL y medido, y se acepta
   * fail-closed: `number` es también la clave canónica del PAN dentro de un objeto de tarjeta
   * (`{"paymentCard":{"number":…}}`), y ahí un falso negativo es un PAN en un log. Se paga el
   * billete tapado en ~1 de cada 10 y queda el `confirmationId` para diagnosticar.
   */
  it('las claves tapadas por SECRETO en el corpus oficial son las fijadas', async () => {
    const masked = new Set<string>();
    for (const { json } of BODIES) {
      const { error } = await throughHttpClient(json);
      for (const match of error.body.matchAll(MASKED_PAIR)) {
        if (match[2] === REDACTED) masked.add(match[1] ?? '');
      }
    }
    const byKey = [...masked].filter((key) => isSensitiveKey(key)).sort();
    const byShape = [...masked].filter((key) => !isSensitiveKey(key)).sort();

    expect(byKey).toEqual([
      'PseudoCityCode',
      'access_token',
      'address',
      'birthDate',
      'cardNumber',
      'documentNumber',
      'givenName',
      'pseudoCityCode',
      'surname',
      'targetPcc',
      'ticketingPcc',
      'token_type',
      'userHomePcc',
      'userWorkPcc',
    ]);
    // Lo tapado por FORMA y no por clave. Si aparece una segunda entrada, hay un falso positivo
    // nuevo de las pasadas por forma sobre datos oficiales y hay que mirarlo.
    expect(byShape).toEqual(['number']);
  });

  it('un cuerpo oficial SIN claves de texto libre sale sin una sola marca', async () => {
    const clean = BODIES.filter(
      ({ json }) =>
        !/"(description|message|text|freeText|fieldValue|remarks?|comments?|notes?)"/.test(json),
    );
    expect(
      clean.length,
      'no quedan cuerpos limpios con los que medir el otro lado',
    ).toBeGreaterThan(50);

    const dirty: string[] = [];
    for (const { file, json } of clean.slice(0, 60)) {
      const { error } = await throughHttpClient(json);
      if (error.body.includes(FREE_TEXT)) dirty.push(file);
    }
    expect(dirty, 'apareció una marca de texto libre donde no hay texto libre').toEqual([]);
  });
});
