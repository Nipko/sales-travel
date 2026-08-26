import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';

/**
 * LA INVARIANTE QUE ORDENA `redaction.ts`, Y QUE HASTA AHORA NADIE FIJABA.
 *
 * La cabecera del módulo afirma, literalmente, que «no hay ningún tamaño de body para el que la
 * protección se apague». Esa frase es la cicatriz del hallazgo ALTO de la ronda 1: la versión
 * anterior apagaba la redacción POR CLAVE por encima de 20.000 caracteres y dejaba sólo las regex
 * de forma — y dos de los tres fixtures oficiales de BFM pesan 24.980 y 29.216 bytes, así que el
 * camino «degradado» era el camino NORMAL de una búsqueda de vuelos.
 *
 * Se arregló, se escribió la cabecera… y no quedó un solo test que lo sujetara. Medido con un
 * mutante: reintroducir
 *
 *     if (body.length > 20_000) return collapse(body.slice(0, maxChars), maxChars);
 *
 * al principio de `safeBodySummary` deja la suite entera en verde. Sería volver a la ronda 1 sin
 * enterarse, y es la regresión más cara posible porque el tamaño que la dispara es el tamaño
 * normal de la respuesta que más se llama.
 *
 * Por eso este fichero barre una rejilla de tamaños que cruza cualquier umbral redondo que a
 * alguien se le ocurra reintroducir (8 KB, 16 KB, 20 KB, 32 KB, 64 KB, 100 KB, 1 MB) y exige el
 * MISMO resultado en todos. Todo por la puerta pública (`SabreHttpClient.postJson`): un test que
 * llamara a `safeBodySummary` probaría la defensa que él eligió, no la que corre en producción.
 */

const PASSWORD = 'Pa55w0rd!';
const PASSPORT = 'AB1234567';
const CLIENT_ID = 'V1:500001:ZZZZ:AA';
/** `deriveSabreSecret({epr:'500001', homePcc:'ZZZZ', password:'Pa55w0rd!', domain:'AA'})`. */
const SECRET = 'VmpFNk5UQXdNREF4T2xwYVdsbzZRVUU9OlVHRTFOWGN3Y21RaA==';
const PAN = '4111111111111111';

const SHOP_PATH = '/v5/offers/shop';

/**
 * Rejilla deliberadamente centrada en 20.000: justo por debajo, justo por encima, y los dos
 * tamaños reales de fixture de BFM que hicieron del camino degradado el camino normal.
 */
const SIZES: readonly number[] = [
  1_000, 8_192, 16_384, 19_999, 20_001, 24_980, 29_216, 32_768, 65_536, 100_000, 1_048_576,
];

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: PASSWORD,
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

/** Ni el mensaje, ni el body guardado, ni el log pueden contener el testigo. */
async function expectSealed(body: string, witnesses: readonly string[]): Promise<SabreApiError> {
  const { error, logDump } = await throughHttpClient(body);
  for (const witness of witnesses) {
    expect(error.message).not.toContain(witness);
    expect(error.body).not.toContain(witness);
    expect(logDump).not.toContain(witness);
  }
  return error;
}

/**
 * Relleno inerte: sólo mayúsculas, así que no dispara ninguna regla por forma (`looksHighEntropy`
 * exige minúscula Y mayúscula Y dígito) y no puede tapar por accidente el fallo que se busca.
 */
function grow(prefix: string, suffix: string, target: number): string {
  const fill = Math.max(target - prefix.length - suffix.length, 0);
  return `${prefix}${'A'.repeat(fill)}${suffix}`;
}

/** El secreto va SIEMPRE en la cabeza: lo que se mide es si se tapa, no si se ve. */
function jsonBody(target: number): string {
  return grow(
    `{"password":"${PASSWORD}","traveler":{"passportNumber":"${PASSPORT}"},"acct":${PAN},"pad":"`,
    '"}',
    target,
  );
}

function formBody(target: number): string {
  return grow(`grant_type=client_credentials&password=${PASSWORD}&pad=`, '', target);
}

function xmlBody(target: number): string {
  return grow(
    `<soap:Envelope><UsernameToken><Password>${PASSWORD}</Password></UsernameToken><Pad>`,
    '</Pad></soap:Envelope>',
    target,
  );
}

/**
 * El carril por FORMA: un secret y un clientId desnudos, sin clave que los delate.
 *
 * Van como ELEMENTO PELADO de un array, que es la posición sin clave por definición. Antes iban
 * bajo `error_description`, y esa clave dejó de servir para aislar este carril cuando entró el de
 * TEXTO LIBRE: `error_description` es prosa del proveedor y ahora se sustituye entera, así que el
 * testigo desaparecía sin que la regla por forma llegara a correr y el test medía otra cosa. Un
 * elemento de array no tiene clave que pueda taparlo por otra vía, así que aquí sólo puede salvar
 * la forma. `errors[]` con escalares es además una forma real de Sabre.
 */
function shapeBody(target: number): string {
  return grow(
    `{"errors":["Wrong clientID or clientSecret: ${CLIENT_ID} / ${SECRET}"],"pad":"`,
    '"}',
    target,
  );
}

describe('M-R20 — la protección no se apaga a NINGÚN tamaño de body', () => {
  it.each(SIZES)('JSON de %i bytes: la redacción por CLAVE sigue viva', async (size) => {
    const body = jsonBody(size);
    expect(body.length).toBeGreaterThanOrEqual(Math.min(size, 1_000));
    const error = await expectSealed(body, [PASSWORD, PASSPORT, PAN]);
    // Se tapó, no se cayó del truncado: el testigo desapareció porque hubo redacción.
    expect(error.body).toContain(REDACTED);
  });

  it.each(SIZES)('form-urlencoded de %i bytes: el carril suelto sigue vivo', async (size) => {
    const error = await expectSealed(formBody(size), [PASSWORD]);
    expect(error.body).toContain(REDACTED);
  });

  it.each(SIZES)('XML de %i bytes: el carril SOAP sigue vivo', async (size) => {
    const error = await expectSealed(xmlBody(size), [PASSWORD]);
    expect(error.body).toContain(REDACTED);
  });

  it.each(SIZES)('JSON de %i bytes: la redacción por FORMA sigue viva', async (size) => {
    const error = await expectSealed(shapeBody(size), [SECRET, CLIENT_ID]);
    expect(error.body).toContain(REDACTED);
  });
});

/**
 * El cierre por arriba del test anterior: no basta con que el testigo desaparezca a cada tamaño,
 * porque un umbral podría tapar el secreto por otra vía y aun así cambiar de camino. Aquí se exige
 * que el resumen sea **byte a byte el mismo** para bodies que sólo se diferencian en la cola
 * inerte. Si alguien mete un `if (body.length > N)` que cambie ALGO —el rail, el truncado, el
 * formato—, esta comparación se rompe aunque el secreto siguiera tapado.
 *
 * Es además la formulación exacta de la frase de la cabecera: «lo único que depende del tamaño es
 * cuánto se ve, nunca cuánto se tapa» — y aquí ni siquiera cambia cuánto se ve, porque la cola es
 * relleno.
 */
describe('M-R20 — el resumen no depende del tamaño de la entrada', () => {
  it('el mismo prefijo produce el mismo resumen a 8 KB y a 1 MB', async () => {
    const summaries: string[] = [];
    for (const size of SIZES.filter((value) => value >= 8_192)) {
      const { error } = await throughHttpClient(jsonBody(size));
      summaries.push(error.body);
    }
    for (const summary of summaries) expect(summary).toBe(summaries[0]);
  });

  it('lo mismo por el carril suelto, que es el que atendía al camino degradado', async () => {
    const summaries: string[] = [];
    for (const size of SIZES.filter((value) => value >= 8_192)) {
      const { error } = await throughHttpClient(formBody(size));
      summaries.push(error.body);
    }
    for (const summary of summaries) expect(summary).toBe(summaries[0]);
  });
});
