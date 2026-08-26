import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED, redactMeta } from './redaction';

/**
 * El carril POR CLAVE de `redactPath`, y la lista de claves que deciden qué es una ruta.
 *
 * ## El hueco, medido
 *
 * `redactPath` es `redactShapeRails(redactByKeyRails(stripUrlQuery(value)), …)`. La llamada del
 * medio —los tres carriles estructurados `JSON_PAIR`/`FORM_PAIR`/`XML_ELEMENT`— **no tenía una sola
 * observación en la suite**: borrándola de `redactPath`, los 1.298 tests seguían verdes. Lo mismo
 * con la lista `PATH_KEYS` reducida a `['path']`: los seis alias (`url`, `uri`, `href`, `endpoint`,
 * `requestUri`, `requestUrl`) tampoco costaban un test.
 *
 * ## Por qué el test evidente NO sirve, y por eso está escrito el que sí
 *
 * Lo primero que se escribe para probar este carril es una QUERY con clave sensible
 * (`?password=…`). No prueba nada: `stripUrlQuery` corta en el primer `?` o `#` **antes** de que
 * el carril por clave vea el texto, así que ese test pasa igual con la llamada borrada — mutante
 * equivalente. Lo mismo con el fragmento. La sonda que lo demuestra desde dentro del test está en
 * §1b: una query con clave INOCUA desaparece igual que una sensible, y sólo puede hacer eso quien
 * tira la query entera, no quien decide por clave.
 *
 * Lo que sí sobrevive al corte es lo que va **en la ruta misma**, y de las tres formas la única que
 * una URL lleva de forma natural es `clave=valor`: el parámetro de matriz de RFC 3986 §3.3, que es
 * cómo un contenedor Java —la casa de Sabre— cuelga estado del path (`;jsessionid=…`) y cómo un
 * llamador pega un `;targetPcc=` a una ruta nuestra sin pasar por la query. Ése es el portador de
 * §1a.
 *
 * ## Qué se rompe si el carril se cae
 *
 * Nada de lo que va en un parámetro de matriz tiene forma reconocible: un ATK de Sabre es
 * `T1RLAQL…` sin puntos ni prefijo, y un PCC son cuatro caracteres. Sin el carril por clave sale
 * literal a `error.path`, a `error.message` y al `path` de `sabre.http.ok` — el mismo camino por el
 * que la copia de `errors.ts` publicaba secretos enteros (ver `redaction.single-path-rule.test.ts`).
 *
 * Todo por la puerta pública: `SabreHttpClient.postJson` para la ruta de la petición, y
 * `redactMeta` —exportado en `index.ts`— para los alias, que ninguna clase de este paquete emite
 * todavía (§3 explica por qué el door es ése y no otro).
 */

const SHOP_PATH = '/v5/offers/shop';

/** Ruta real del contrato que cumple las tres condiciones de `LONG_BASE64_RUN`. Ver §2. */
const BASE64_LOOKALIKE_ROUTE = '/v1/trip/orders/getBookingSummary';

/** Un ATK de Sabre: opaco, sin puntos, sin prefijo. Ninguna pasada por FORMA lo reconoce. */
const ATK = 'T1RLAQLbaseSecretoDeOficina';
/** Un PCC ajeno al de la config, para que el testigo no pueda salir de otro sitio del log. */
const OTHER_PCC = 'K7QX';

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
    Promise.resolve(new Response('{"status":"NotProcessed"}', { status: 500 }));
  const { logger, calls } = spyLogger();
  const error = (await clientWith(fetchImpl, logger)
    .postJson(rawPath, {})
    .catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return { error, logDump: JSON.stringify(calls) };
}

/** La misma ruta por el camino del ÉXITO, donde sólo la mira `redactMeta`. */
async function pathLoggedOnSuccess(rawPath: string): Promise<string> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ groupedItineraryResponse: { version: '5' } }), { status: 200 }),
    );
  const { logger, calls } = spyLogger();
  await clientWith(fetchImpl, logger).postJson(rawPath, {});
  const ok = calls.find((call) => call.message === 'sabre.http.ok');
  const logged = ok?.meta?.['path'];
  expect(typeof logged, 'sabre.http.ok dejó de publicar `path`').toBe('string');
  return logged as string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * §1a — el portador REAL: el parámetro de matriz
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§1a — una clave sensible en un parámetro de matriz no llega a ningún sitio', () => {
  it.each([
    ['access_token, como lo cuelga un contenedor Java', 'access_token', ATK],
    ['sessionToken, la variante camelCase', 'sessionToken', ATK],
    ['targetPcc: identidad BYOC, cuatro caracteres sin forma', 'targetPcc', OTHER_PCC],
  ])('%s', async (_name, key, witness) => {
    const raw = `/v1/session;${key}=${witness}/status`;
    const { error, logDump } = await throughError(raw);

    // Las tres salidas del error y el log: es por donde sale una ruta.
    expect(error.path, 'el carril por clave de `redactPath` dejó de correr').not.toContain(witness);
    expect(error.message).not.toContain(witness);
    expect(logDump).not.toContain(witness);
    // Y por el camino del ÉXITO, que es el que más se recorre.
    expect(await pathLoggedOnSuccess(raw)).not.toContain(witness);

    // Se tapa el VALOR y queda la traza: la ruta y el nombre del parámetro siguen ahí.
    expect(error.path).toContain(`/v1/session;${key}=`);
    expect(error.path).toContain(REDACTED);
  });

  /**
   * El precio que hoy se paga, escrito para que se vea: el alfabeto de `FORM_PAIR` incluye `/`, así
   * que la marca se come el resto de la ruta (`/status`). Es fail-closed —de más, no de menos— y
   * NO se fija aquí a propósito: si alguien estrecha `FORM_PAIR` para que pare en la barra, el
   * secreto sigue tapado y el `/status` vuelve, que es mejor. Lo que sí se fija es que la parte de
   * la ruta ANTERIOR al parámetro sobreviva, porque sin ella no queda diagnóstico ninguno.
   */
  it('la ruta anterior al parámetro sobrevive: sin ella no hay traza que leer', async () => {
    const { error } = await throughError(`${BASE64_LOOKALIKE_ROUTE};targetPcc=${OTHER_PCC}`);
    expect(error.path).toContain(BASE64_LOOKALIKE_ROUTE);
    expect(error.path).not.toContain(OTHER_PCC);
  });

  /**
   * CONTROL, y es el que descarta que esto lo esté haciendo otra pasada: mismo portador, misma
   * forma, clave INOCUA. Tiene que salir literal. Si se cayera, el positivo de arriba no probaría
   * el carril por clave —probaría algo que borra parámetros de matriz en bloque, que además estaría
   * tirando diagnóstico.
   */
  it('CONTROL: un parámetro de matriz con clave inocua sale entero', async () => {
    const raw = '/v1/session;flightNumber=AV0123/status';
    const { error } = await throughError(raw);
    expect(error.path).toBe(raw);
    expect(await pathLoggedOnSuccess(raw)).toBe(raw);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * §1b — la sonda que descarta el test equivalente
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§1b — la query NO es el portador de este carril, y se demuestra', () => {
  it('una query con clave INOCUA desaparece igual que una sensible', async () => {
    // Quien borra las dos por igual es `stripUrlQuery`, que tira la query entera sin mirar la
    // clave. O sea: un test de «?password=… se tapa» pasa con el carril por clave borrado, porque
    // el carril por clave nunca llega a ver ese texto. Por eso el portador de §1a va en la RUTA.
    const inocua = await throughError(`${SHOP_PATH}?lang=es`);
    const sensible = await throughError(`${SHOP_PATH}?password=Pa55w0rd!`);
    expect(inocua.error.path).toBe(`${SHOP_PATH}?${REDACTED}`);
    expect(sensible.error.path).toBe(`${SHOP_PATH}?${REDACTED}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * §2 — la propiedad por la que `redactPath` no puede ser `redactText`
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§2 — los carriles por clave no se comen una ruta normal', () => {
  /**
   * `redactPath` existe separada porque una ruta NO puede pasar por `redactText` entero:
   * `LONG_BASE64_RUN` es la única pasada cuyo alfabeto incluye `/`, y una ruta real de Sabre cumple
   * sus tres condiciones. Aquí se mira el otro lado de esa misma decisión —que lo que sí corre
   * sobre la ruta, los tres carriles por clave, no le haga nada—; el lado de la pasada por forma lo
   * observa `redaction.single-path-rule.test.ts` (capa 3b) desde el camino del error.
   */
  it.each([BASE64_LOOKALIKE_ROUTE, '/v1/trip/orders/fulfillFlightTickets'])(
    'la ruta %s sale idéntica por el camino del éxito',
    async (route) => {
      // La premisa, para que el test no pase por accidente: `redactText` la borraría entera.
      expect(route.replace(/^\//, '')).toMatch(/^[A-Za-z0-9+/]{32,}$/);
      expect(route).toMatch(/[a-z]/);
      expect(route).toMatch(/[A-Z]/);
      expect(route).toMatch(/\d/);

      expect(
        await pathLoggedOnSuccess(route),
        'la ruta desapareció del log: una operación con dinero quedaría sin traza',
      ).toBe(route);
    },
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * §3 — los seis alias de PATH_KEYS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Por qué el door aquí es `redactMeta` y no `postJson`: dentro de este paquete la única clave de
 * ruta que se emite es `path`, así que los otros seis alias son inalcanzables por el cliente HTTP y
 * un test por `postJson` no podría distinguirlos. Existen para el CONSUMIDOR —`apps/api` loguea
 * `url`/`endpoint`— y `redactMeta` es justo lo que ese consumidor importa (`index.ts` lo exporta).
 * Probarlos por su puerta real es la única forma de que la lista deje de ser decorado.
 */
const PATH_ALIASES = ['path', 'url', 'uri', 'href', 'endpoint', 'requestUri', 'requestUrl'];

describe('§3 — la clave decide si un valor es una ruta, y la lista tiene seis alias', () => {
  it.each(PATH_ALIASES)('bajo `%s` la query se tira y el secreto de la ruta se tapa', (key) => {
    const meta = redactMeta({ [key]: `/v1/session;access_token=${ATK}/status?pnr=XKCD12` });
    const value = String(meta[key]);
    expect(value).not.toContain(ATK);
    expect(value).not.toContain('XKCD12');
    expect(value).toContain('/v1/session;access_token=');
  });

  it.each(PATH_ALIASES)('bajo `%s` una ruta normal sobrevive entera', (key) => {
    expect(redactMeta({ [key]: BASE64_LOOKALIKE_ROUTE })[key]).toBe(BASE64_LOOKALIKE_ROUTE);
  });

  /**
   * CONTROL, y es lo que hace que la lista sea load-bearing: una clave que NO está en `PATH_KEYS`
   * no recibe la política de rutas, recibe `redactText`, y `redactText` se come la ruta entera por
   * `LONG_BASE64_RUN`. Eso no es una fuga, es CEGUERA —el log deja de decir qué operación falló—, y
   * es exactamente lo que se midió antes de que existiera `redactPath`.
   *
   * O sea: cada alias que falte en la lista cuesta una traza. Y el secreto sigue tapado por el otro
   * lado, que es la mitad que se comprueba en la segunda aserción.
   */
  it('CONTROL: bajo una clave que no es de ruta, la ruta se pierde', () => {
    expect(redactMeta({ location: BASE64_LOOKALIKE_ROUTE })['location']).toBe(REDACTED);
    expect(String(redactMeta({ location: `/v1/x;access_token=${ATK}` })['location'])).not.toContain(
      ATK,
    );
  });
});
