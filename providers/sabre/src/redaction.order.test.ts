import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';

/**
 * Los ÓRDENES load-bearing de `redaction.ts`, cada uno con el mutante que mata.
 *
 * Nace de un hallazgo de la tercera auditoría: el comentario de la rama `expectKey` declara que
 * «se decide sobre la clave CRUDA y se emite la clave REDACTADA», y ningún test lo fijaba. El
 * auditor invirtió el orden —`redactNext = isSensitiveKey(clampAndRedact(value, maxChars))`— y las
 * 395 pruebas siguieron verdes mientras el VALOR de una clave sensible salía en claro. Verde no
 * significa protegido: si un comentario dice que algo importa, aquí hay un test que lo demuestra.
 *
 * Todo entra POR LA PUERTA PÚBLICA (`SabreHttpClient.postJson`). Ninguna prueba llama a
 * `redactJsonStream`, `clampAndRedact` ni `redactProseCredentials`: probaríamos la defensa que
 * elegimos nosotros, no la que corre en producción.
 */

/**
 * La sonda que separa los dos órdenes. Es sensible POR NOMBRE (contiene `token`) y a la vez cae
 * entera en `LONG_BASE64_RUN` —32 caracteres del alfabeto base64 con mayúscula, minúscula y
 * dígito—, así que al redactarla se convierte en `«REDACTADO»`, que ya no es sensible para nadie.
 *
 * Esa asimetría es justo lo que distingue «decidir sobre la clave cruda» de «decidir sobre la
 * clave redactada», y no hay ninguna otra clave del repo que la tenga: `password` y `clientId`
 * sobreviven intactas a `redactText` y por eso no matan al mutante.
 */
const VOLATILE_KEY = 'accessTokenAbc123Def456Ghi789Jkl';

/** Valor sin forma verificable: si sale, salió porque nadie miró la clave. */
const KEYED_SECRET = 'Pa55w0rd!';

const PAN = '4111111111111111';

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
  level: string;
  message: string;
  meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, calls };
}

async function throughHttpClient(
  body: string,
  status = 500,
  path = SHOP_PATH,
): Promise<{ error: SabreApiError; calls: LogCall[]; logDump: string }> {
  const fetchImpl: SabreFetch = () => Promise.resolve(new Response(body, { status }));
  const { logger, calls } = spyLogger();
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });

  const error = (await http.postJson(path, {}).catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return { error, calls, logDump: JSON.stringify(calls) };
}

/**
 * La ruta CRUDA tal y como la publica `redaction.ts`, sin que la copia de `errors.ts` la pise.
 *
 * Hace falta un 200: en los logs de error el literal de objeto pone el `path` crudo y luego lo
 * SOBRESCRIBE con `...error.toLogMeta()`, que ya trae la ruta pasada por la copia de `errors.ts`.
 * Comparar ahí las dos reglas es comparar una regla consigo misma —comprobado: el mutante que deja
 * de tirar el fragmento pasaba entero por ese camino—. `sabre.http.ok` es el único log donde la
 * ruta llega cruda a `redactMeta`, así que es el único sitio donde se puede observar esta regla.
 */
async function pathLoggedOnSuccess(rawPath: string): Promise<string> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ groupedItineraryResponse: { version: '5' } }), { status: 200 }),
    );
  const { logger, calls } = spyLogger();
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });

  await http.postJson(rawPath, {});
  const ok = calls.find((call) => call.message === 'sabre.http.ok');
  expect(ok, 'sin sabre.http.ok no hay ruta cruda que observar').toBeDefined();
  const logged = ok?.meta?.['path'];
  expect(typeof logged, 'sabre.http.ok dejó de publicar `path`').toBe('string');
  return logged as string;
}

/** Ni el mensaje, ni el body guardado, ni el log pueden contener el testigo. */
async function expectSealed(body: string, witness: string): Promise<SabreApiError> {
  const { error, logDump } = await throughHttpClient(body);
  expect(error.message).not.toContain(witness);
  expect(error.body).not.toContain(witness);
  expect(logDump).not.toContain(witness);
  return error;
}

describe('orden 1 — decidir sobre la clave CRUDA, emitir la clave REDACTADA', () => {
  it('la sonda cumple la premisa: sensible en crudo, inocua después de redactarse', async () => {
    // Sin esto el resto del bloque no probaría nada: si la clave sobreviviera a `redactText`, los
    // dos órdenes darían el mismo resultado y el mutante sería equivalente, no un agujero.
    const { error } = await throughHttpClient(`{"${VOLATILE_KEY}":"algo","status":"ERROR"}`);
    // (a) la clave EMITIDA se redacta: no queda rastro del nombre en el resumen…
    expect(error.body).not.toContain(VOLATILE_KEY);
    expect(error.body).toContain(REDACTED);
    // (b) …y su forma redactada ya no delata nada, que es por lo que decidir sobre ella falla.
    expect(REDACTED).not.toContain('token');
  });

  it('MATA AL MUTANTE: el valor de una clave sensible-por-nombre no sale en claro', async () => {
    // `redactNext = isSensitiveKey(clampAndRedact(value, maxChars))` deja pasar `Pa55w0rd!` aquí.
    const error = await expectSealed(
      `{"${VOLATILE_KEY}":"${KEYED_SECRET}","status":"ERROR"}`,
      KEYED_SECRET,
    );
    expect(error.body).toContain(REDACTED);
  });

  it('MATA AL MUTANTE también con valor-objeto: la rama de estructura usa el mismo flag', async () => {
    await expectSealed(
      `{"${VOLATILE_KEY}":{"inner":"${KEYED_SECRET}"},"status":"ERROR"}`,
      KEYED_SECRET,
    );
  });

  it('MATA AL MUTANTE también con valor literal: idem en la rama de números', async () => {
    // Un número corto a propósito: 10 dígitos no llegan al mínimo de `PAN_CANDIDATE`, así que la
    // detección por forma NO lo cubre y lo único que lo tapa es la decisión sobre la clave cruda.
    // Con el PAN de 16 dígitos este test pasaría también con el mutante puesto, por Luhn.
    await expectSealed(`{"${VOLATILE_KEY}":1234567890,"status":"ERROR"}`, '1234567890');
  });

  it('y el PAN bajo esa misma clave queda tapado por las dos vías', async () => {
    await expectSealed(`{"${VOLATILE_KEY}":${PAN},"status":"ERROR"}`, PAN);
  });

  it('anidada dentro de un array de objetos, el valor tampoco sale', async () => {
    await expectSealed(`{"sessions":[{"${VOLATILE_KEY}":"${KEYED_SECRET}"}]}`, KEYED_SECRET);
  });
});

describe('orden 2 — en redactText, primero POR CLAVE y después POR FORMA', () => {
  it('MATA AL MUTANTE: la pasada por forma reescribe la clave y con ella la decisión', async () => {
    // Mismo par, por el carril de texto suelto (`<html>` fuerza el fallback): si `LONG_BASE64_RUN`
    // corriera antes que `JSON_PAIR`, la clave sería ya `«REDACTADO»`, `JSON_PAIR` no casaría con
    // ella —`«` no está en su clase de caracteres— y el valor saldría entero.
    const body = `<html><pre>{"${VOLATILE_KEY}":"${KEYED_SECRET}"}</pre></html>`;
    const error = await expectSealed(body, KEYED_SECRET);
    expect(error.body).not.toContain(VOLATILE_KEY);
    expect(error.body).toContain(REDACTED);
  });

  it('el carril XML tiene el mismo orden y el mismo agujero si se invierte', async () => {
    const body = `<Envelope><${VOLATILE_KEY}>${KEYED_SECRET}</${VOLATILE_KEY}></Envelope>`;
    await expectSealed(body, KEYED_SECRET);
  });
});

describe('orden 3 — el literal redactado se emite ENTRECOMILLADO', () => {
  it('el resumen sigue siendo JSON parseable después de tapar un PAN numérico', async () => {
    const { error } = await throughHttpClient(`{"acct":${PAN},"status":"ERROR"}`);
    expect(error.body).not.toContain(PAN);
    // Emitir `«REDACTADO»` sin comillas deja `{"acct":«REDACTADO»,…}`, que ya no es JSON: el
    // resumen deja de ser legible por herramientas justo en el error que más se investiga.
    const parse = (): Record<string, unknown> => JSON.parse(error.body) as Record<string, unknown>;
    expect(parse).not.toThrow();
    expect(parse()['acct']).toBe(REDACTED);
    expect(parse()['status']).toBe('ERROR');
  });
});

/**
 * `clampAndRedact` redacta ANTES de cortar y otra vez DESPUÉS. Cortar sólo puede APAGAR nueve de
 * las diez pasadas —todas piden longitud mínima o un carácter de cierre—; la décima, Luhn, es la
 * excepción: acortar una tirada de dígitos puede volverla verificable.
 */
describe('orden 4 — redactar DESPUÉS del corte, no sólo antes', () => {
  /** El corte de `redactLooseText` cae en el carácter 300 del texto ya colapsado. */
  const CUT = 300;

  function bodyWithPanEndingAtCut(): string {
    const filler = 'reserva no procesada aviso '.repeat(20);
    // El PAN arranca en 284 y ocupa 284..299: el corte cae exactamente tras su dígito 16.
    const head = `${filler.slice(0, CUT - PAN.length - 1)} `;
    expect(head).toHaveLength(CUT - PAN.length);
    // Un dígito de secuencia pegado detrás: en el cuerpo entero son 17 dígitos y Luhn no confirma
    // 17, así que la PRIMERA pasada lo deja literal. Sólo el corte lo deja en el PAN exacto.
    return `${head}${PAN}9 fin del aviso de la reserva`;
  }

  it('MATA AL MUTANTE: sin la segunda pasada, el corte deja el PAN a la vista', async () => {
    const body = bodyWithPanEndingAtCut();
    const error = await expectSealed(body, PAN);
    expect(error.body).toContain(REDACTED);
  });

  it('MATA AL MUTANTE en el carril JSON: sin ella sale un PREFIJO del PAN', async () => {
    // El mismo corte, pero dentro de un valor de cadena JSON, donde quien recorta es
    // `clampAndRedact`. Aquí `collapse` se come después la cola del resumen, así que lo que se
    // escapa no es el PAN entero sino sus primeros dígitos —el BIN— en vez de la marca de
    // redacción. Medido: sin la segunda pasada, la cola es `4111111`; con ella, `«REDACT`.
    const filler = 'reserva no procesada aviso '.repeat(20);
    const value = `${filler.slice(0, CUT - PAN.length - 1)} ${PAN}9 fin`;
    const { error } = await throughHttpClient(`{"note":"${value}"}`);

    expect(error.body).not.toContain(PAN);
    // Ninguna tirada de 7 dígitos: el filler es sólo palabras, así que la única fuente posible
    // sería el PAN a medio tapar.
    expect(error.body).not.toMatch(/\d{7}/);
  });

  it('la premisa se sostiene: 17 dígitos sin cortar SIGUEN saliendo literales', async () => {
    // Si esto se rompiera, el test de arriba pasaría por la primera pasada y no probaría el corte.
    const { error } = await throughHttpClient(`{"ref":"${PAN}9","status":"ERROR"}`);
    expect(error.body).toContain(`${PAN}9`);
  });
});

/**
 * Cuarto carril por clave: la credencial EN PROSA, sin comillas, sin `=` y sin etiqueta XML.
 * Medido antes de esta ronda: las tres formas salían intactas.
 */
describe('carril de prosa — clave y valor separados por espacio o por dos puntos', () => {
  it.each([
    ['dos puntos con clave delante', `error: password: ${KEYED_SECRET}`],
    ['sólo espacio', `invalid credentials for password ${KEYED_SECRET}`],
    ['clave camelCase y valor delante del resto', `clientSecret ${KEYED_SECRET} is wrong`],
    ['dos puntos sin espacio', `password:${KEYED_SECRET}`],
  ])('%s', async (_name, body) => {
    await expectSealed(body, KEYED_SECRET);
  });

  it('deja intacto lo que hace falta para diagnosticar', async () => {
    const { error } = await throughHttpClient('clientSecret Pa55w0rd! is wrong for pcc');
    expect(error.body).toContain('clientSecret');
    expect(error.body).toContain('is wrong for pcc');
  });

  it('también dentro de un valor de cadena JSON, que es como Sabre hace eco', async () => {
    await expectSealed(
      `{"error":"invalid_client","error_description":"password ${KEYED_SECRET} rechazado"}`,
      KEYED_SECRET,
    );
  });

  /**
   * El gate de dígito-o-símbolo, no la longitud mínima. En las cinco frases la palabra que sigue a
   * la clave sensible tiene 6 caracteres o más, así que entra de lleno en `PROSE_PAIR` y lo único
   * que la salva es `looksLikeProseCredential`. Se afirma la frase ENTERA: comprobar sólo que
   * queda "alguna" palabra dejaba pasar un gate abierto de par en par.
   */
  describe('sin falsos positivos: una frase de ayuda no pierde media línea', () => {
    it.each([
      'password rotation is required every 90 days',
      'the password appears to be rejected by policy',
      'accessToken expired, request another',
      'apiKey header missing from the request',
      'password re-entry required after timeout',
    ])('%s', async (phrase) => {
      const wordAfterKey = /(?:password|accessToken|apiKey) ([^\s,]+)/.exec(phrase)?.[1] ?? '';
      expect(wordAfterKey.length).toBeGreaterThanOrEqual(6);

      const { error } = await throughHttpClient(phrase);
      expect(error.body).toContain(phrase);
    });

    it('un código de error de Sabre suelto no se toca: sin clave delante no hay par', async () => {
      const { error } = await throughHttpClient('ERR.2SG.SEC.NOT_AUTHORIZED');
      expect(error.body).toContain('ERR.2SG.SEC.NOT_AUTHORIZED');
    });

    it('ni detrás de una clave inocua', async () => {
      const { error } = await throughHttpClient('status ERR.2SG.SEC.NOT_AUTHORIZED');
      expect(error.body).toContain('ERR.2SG.SEC.NOT_AUTHORIZED');
    });

    it('detrás de una clave SENSIBLE sí se tapa, y es la decisión fail-closed', async () => {
      // Coste aceptado y fijado aquí para que nadie lo lea como accidente: el código lleva dígitos,
      // así que pasa el gate y desaparece. Se pierde una pista del resumen, nunca la clasificación
      // —`errors.ts` decide sobre el cuerpo CRUDO— y a cambio no hay que adivinar si lo que sigue a
      // `token` es un código o la credencial.
      const { error } = await throughHttpClient('token ERR.2SG.SEC.NOT_AUTHORIZED');
      expect(error.body).toContain('token');
      expect(error.body).toContain(REDACTED);
    });
  });
});

/**
 * El PAN pegado a letras. `\b` exigía que el vecino no fuese alfanumérico, así que un PAN dentro de
 * una tirada con letras no casaba en ninguna posición y salía entero. Medido con la versión
 * anterior del regex: los tres cuerpos de aquí dejaban el número a la vista.
 */
describe('el PAN no se salva por estar pegado a texto', () => {
  it.each([
    ['letra detrás', `pago con ${PAN}x rechazado`],
    ['letra delante', `pago con x${PAN} rechazado`],
    ['dentro de una referencia', `{"ref":"PAY${PAN}Z","status":"ERROR"}`],
  ])('%s', async (_name, body) => {
    await expectSealed(body, PAN);
  });

  it('y un número largo que Luhn no confirma sigue visible: no hay falso positivo nuevo', async () => {
    const { error } = await throughHttpClient('{"ref":"PAY1234567890123Z","status":"ERROR"}');
    expect(error.body).toContain('1234567890123');
    expect(error.body).not.toContain(REDACTED);
  });
});

/**
 * UNA sola implementación de la regla de RUTA.
 *
 * La regla —«conservar la ruta, tirar la query y el fragmento»— vivía DOS veces: en
 * `redaction.ts` y en `errors.ts:safeErrorPath`. El informe de la ronda 5 dio los duplicados por
 * consolidados y para éste no era cierto. Es la forma exacta del incidente de la ronda 2: dos
 * implementaciones de la misma política de seguridad, y una acaba derivando.
 *
 * Y ya había derivado en las dos direcciones:
 *
 * 1. La copia de `redaction.ts` pasaba la ruta por `redactText` entero, y `LONG_BASE64_RUN` incluye
 *    `/` en su alfabeto: `/v1/trip/orders/getBookingSummary` son 33 caracteres del alfabeto base64
 *    con mayúscula, minúscula y dígito, así que salía del log como `«REDACTADO»`. Medido antes de
 *    esta ronda. No es fuga —tapa de más— pero deja ciega la traza de una operación con dinero.
 * 2. La copia de `errors.ts` no aplica NINGUNA pasada por forma, así que un `Bearer`, un JWT o el
 *    `secret` de Sabre metidos en un segmento de ruta llegan enteros a `error.message`.
 *
 * La función canónica {@link redactPath} tapa las dos: aplica las nueve pasadas que no pueden
 * comerse una ruta y apaga sólo la décima. Estos tests fijan las dos mitades y, sobre todo, fijan
 * que las dos implementaciones dan el MISMO resultado — así que si vuelven a divergir, esto es rojo.
 */
describe('la regla de ruta es UNA: ruta dentro, query fuera, formas tapadas', () => {
  /** Rutas reales del contrato. Las dos largas son las que `redactText` borraba entera. */
  const SHORT_ROUTE = '/v5/offers/shop';
  const LONG_ROUTE = '/v1/trip/orders/getBookingSummary';
  const MONEY_ROUTE = '/v1/trip/orders/fulfillFlightTickets';

  it.each([LONG_ROUTE, MONEY_ROUTE])(
    'la ruta %s SOBREVIVE al rail base64 y sigue en el log',
    async (route) => {
      // La premisa, para que el test no pase por accidente: la ruta cumple las tres condiciones de
      // `LONG_BASE64_RUN`, así que `redactText` la borraría entera. Si alguien renombra la ruta y
      // deja de cumplirlas, esta línea avisa en vez de dejar el test vacío.
      expect(route.replace(/^\//, '')).toMatch(/^[A-Za-z0-9+/]{32,}$/);
      expect(route).toMatch(/[a-z]/);
      expect(route).toMatch(/[A-Z]/);
      expect(route).toMatch(/\d/);

      expect(await pathLoggedOnSuccess(route)).toBe(route);
    },
  );

  it.each([
    ['sin query', SHORT_ROUTE],
    ['con query', `${LONG_ROUTE}?pnr=XKCD12&passportNumber=AB1234567`],
    ['con fragmento', `${MONEY_ROUTE}#XKCD12`],
    ['con las dos', `${SHORT_ROUTE}?pnr=XKCD12#tail`],
  ])(
    'DETECTOR DE DERIVA (%s): errors.ts y redaction.ts producen la MISMA ruta',
    async (_name, raw) => {
      // Dos observaciones de la MISMA ruta cruda por dos caminos distintos:
      //   - `error.path` la pasa por la copia de `errors.ts` (`safeErrorPath`);
      //   - el `path` de `sabre.http.ok` la pasa por la regla canónica de `redaction.ts`.
      // Que coincidan es la definición operativa de «una sola regla», y no depende de que
      // `errors.ts` haya colapsado ya su copia: cuando lo haga, esto sigue verde. Si vuelven a
      // divergir —en cualquiera de los dos sentidos— esto es rojo.
      const { error } = await throughHttpClient('{"message":"oops"}', 500, raw);
      expect(await pathLoggedOnSuccess(raw)).toBe(error.path);
    },
  );

  it.each([
    ['query', `${SHORT_ROUTE}?pnr=XKCD12`, 'XKCD12'],
    ['fragmento', `${SHORT_ROUTE}#XKCD12`, 'XKCD12'],
    ['las dos', `${SHORT_ROUTE}?pnr=XKCD12#XKCD12`, 'XKCD12'],
  ])('la %s se va entera y la ruta se queda', async (_name, raw, witness) => {
    const { error, logDump } = await throughHttpClient('{"message":"oops"}', 500, raw);
    expect(logDump).not.toContain(witness);
    expect(error.message).not.toContain(witness);
    expect(logDump).toContain(SHORT_ROUTE);
    expect(await pathLoggedOnSuccess(raw)).toBe(`${SHORT_ROUTE}?${REDACTED}`);
  });

  /**
   * El interruptor `collapseBase64Runs` sólo puede apagar UNA pasada. Si algún día se convierte en
   * un «redacta menos» genérico, estos tres cuerpos lo delatan: son las formas que sí pueden
   * aparecer en un segmento de ruta y que siguen teniendo que desaparecer.
   */
  it.each([
    ['un JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.QWxhZGRpbjpvcGVuc2VzYW1l'],
    ['el secret de Sabre', 'VmpFNkVQUjpQQ0M6QUE6cGFzc3dvcmQxMjM='],
    ['el clientId en claro', 'V1:500001:ZZZZ:AA'],
    ['un PAN', PAN],
  ])('%s dentro de un SEGMENTO de ruta sigue tapado en el log', async (_name, witness) => {
    const raw = `/v1/session/${witness}/status`;

    const logged = await pathLoggedOnSuccess(raw);
    expect(logged).not.toContain(witness);
    expect(logged).toContain(REDACTED);
    // La ruta que envuelve al secreto se conserva: se tapa el segmento, no la traza.
    expect(logged).toContain('/v1/session/');

    // Y tampoco por el camino del error, donde la ruta llega ya pasada por la copia de `errors.ts`.
    const { logDump } = await throughHttpClient('{"message":"oops"}', 500, raw);
    expect(logDump).not.toContain(witness);
  });
});

/**
 * El presupuesto del escáner es de SALIDA, no de entrada.
 *
 * Aquí vivía `expect(msPerOp).toBeLessThan(10)` sobre 10 pasadas de 1 MB de prosa. Era una
 * aserción por RELOJ DE PARED dentro de una suite que vitest corre en paralelo: se puso roja con
 * 10,43 ms/op sin que nadie tocara la redacción, sólo porque otro fichero cargaba la CPU. Un test
 * que se pone rojo por el vecino enseña a ignorar el rojo, que es peor que no tener el test.
 *
 * La intención se conserva con dos aserciones DETERMINISTAS y una medición fuera de la suite:
 *
 * - **La trampa detrás del presupuesto** (abajo) demuestra que el escáner PARA cuando ha llenado
 *   los 300 caracteres de salida, porque nunca llega a ver lo que hay después.
 * - **La invariante de escala** demuestra que la cola de la entrada no puede influir en el
 *   resultado, sea cual sea su tamaño.
 * - El COSTE en tiempo se mide en `bench/redaction.budget.bench.ts`, que no corre en `pnpm test`.
 */
describe('el presupuesto es de SALIDA y no de entrada', () => {
  /** `DEFAULT_BODY_SUMMARY_CHARS`. */
  const BUDGET = 300;
  /**
   * Valor inocuo: ninguna pasada lo toca, así que si aparece es que alguien leyó de más.
   *
   * Va bajo la clave `label` y no bajo `note`, que es donde estaba: `note` entró en la lista de
   * TEXTO LIBRE y su valor se sustituye entero, así que el testigo desaparecía por una razón que
   * no tiene nada que ver con el presupuesto y el test dejaba de medir lo que dice medir.
   */
  const BEHIND_BUDGET = 'TESTIGO-DETRAS-DEL-PRESUPUESTO';

  /**
   * Un cuerpo con una TRAMPA detrás del presupuesto: un literal que no es JSON válido.
   *
   * Si el escáner respeta el presupuesto de salida, para antes de llegar a `@@@` y devuelve el
   * resumen en carril JSON, donde el valor-objeto de la clave sensible `credentials` se sustituye
   * ENTERO. Si alguien quita la condición `len < maxChars`, el escáner sigue, tropieza con `@@@`,
   * devuelve `null`, y `safeBodySummary` cae al carril de texto suelto — que redacta por clave y
   * por forma pero NO colapsa el objeto, así que el testigo de dentro sale en claro.
   *
   * O sea: la misma entrada produce dos resúmenes distinguibles según se respete el presupuesto o
   * no. Eso es lo que convierte la intención de «coste atado a la salida» en algo comprobable sin
   * mirar el reloj.
   */
  function bodyWithTrapBehindBudget(): string {
    const head = `{"credentials":{"user":"ana","label":"${BEHIND_BUDGET}"},"pad":"${'x'.repeat(BUDGET + 100)}"`;
    return `${head},"trap":@@@}`;
  }

  it('MATA AL MUTANTE: el escáner para al llenar la salida y nunca ve la trampa', async () => {
    const body = bodyWithTrapBehindBudget();
    const { error } = await throughHttpClient(body);

    // (a) El testigo está dentro de los primeros 300 caracteres del cuerpo CRUDO, así que el
    //     carril de texto suelto sí lo publicaría: el test no pasa por quedarse corto de ventana.
    expect(body.slice(0, BUDGET)).toContain(BEHIND_BUDGET);
    // (b) …y aun así no aparece, porque el escáner colapsó el objeto de `credentials` y paró antes.
    expect(error.body).not.toContain(BEHIND_BUDGET);
    expect(error.body).toContain(REDACTED);
    expect(error.body.length).toBeLessThanOrEqual(BUDGET + 1);
  });

  it('la premisa se sostiene: la MISMA trampa delante del presupuesto sí cambia el carril', async () => {
    // Sin esto, el test de arriba podría estar pasando porque la trampa no hace nada. Aquí la
    // trampa va ANTES de llenar la salida: el escáner la ve, devuelve `null`, y el resumen sale
    // por el carril de texto suelto — donde el objeto NO se colapsa y el testigo sí aparece.
    const body = `{"credentials":{"user":"ana","label":"${BEHIND_BUDGET}"},"trap":@@@}`;
    const { error } = await throughHttpClient(body);
    expect(error.body).toContain(BEHIND_BUDGET);
  });

  it('invariante de escala: la cola de la entrada no puede cambiar el resumen', async () => {
    const unit = `no se pudo autenticar: password ${KEYED_SECRET} y clientSecret ${KEYED_SECRET}. `;
    const summaries = new Map<number, string>();

    for (const repeats of [128, 1_280, 16_000]) {
      const body = unit.repeat(repeats);
      const { error } = await throughHttpClient(body);
      summaries.set(body.length, error.body);

      expect(error.body.length).toBeLessThanOrEqual(BUDGET + 1);
      expect(error.body).not.toContain(KEYED_SECRET);
    }

    // 8 KB, 80 KB y 1 MB del mismo cuerpo dan el MISMO resumen, byte a byte: lo que hay más allá
    // de la ventana no participa en el resultado. Si alguien devuelve el recorrido al tamaño de la
    // entrada, tiene que justificar por qué el resultado no cambia — y el bench dice el precio.
    const distinct = new Set(summaries.values());
    expect(
      distinct.size,
      `resúmenes distintos por escala: ${[...summaries.keys()].join('/')}`,
    ).toBe(1);
    expect(Math.max(...summaries.keys())).toBeGreaterThan(1_000_000);
  });
});
