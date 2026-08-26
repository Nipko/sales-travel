import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED, redactMeta } from './redaction';

/**
 * El carril `XML_ELEMENT` y el PREFIJO DE NAMESPACE.
 *
 * `redactByKeyRails` decide la marca de un elemento XML sobre `tag.split(':').pop()`, o sea sobre
 * el tramo LOCAL del nombre cualificado. Ese `.split(':').pop()` no tenía un solo test, y el
 * mutante que usa el tag entero sobrevivía a la suite completa.
 *
 * No es hipotético: el carril SOAP de Sabre manda `UsernameToken` con prefijos (`wsse:`,
 * `soap:`), y los sobres de terceros de los que Sabre hace eco vienen cualificados igual.
 *
 * ## Por qué unos testigos matan al mutante y otros no — dicho entero
 *
 * `isSecretKey` decide por CUATRO vías sobre la clave normalizada (minúsculas, sin separadores):
 * el Set exacto, los marcadores por FRAGMENTO, la forma de la clave entera, y las abreviaturas por
 * PALABRA. Aplastar `ns:epr` da `nsepr`, y las cuatro fallan — el Set compara exacto y `epr` no es
 * marcador—: **ese** testigo sale EN CLARO con el mutante. Pero aplastar `a:pcc` da `apcc`, que
 * CONTIENE el marcador `pcc`, así que ése lo tapa el mutante igual.
 *
 * Los dos grupos están en la tabla de abajo, etiquetados. Meter los seis y decir «todos fijan el
 * `.split(':')`» sería exactamente el comentario que promete lo que el código no da, que es contra
 * lo que se escribió media auditoría de este paquete. Lo que fija el `.split(':')` son las cuatro
 * filas marcadas `mata-mutante`; las otras dos están como suelo, porque son las que un lector
 * espera ver y su ausencia se leería como hueco.
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

/**
 * Puerta pública: el sobre XML entra como cuerpo de un `500` por `postJson` y sale por el mensaje
 * del error, por `error.body` y por la meta del log. Es el camino real de un fallo del carril SOAP.
 */
async function xmlThroughHttpClient(body: string): Promise<string> {
  const calls: unknown[] = [];
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
  const fetchImpl: SabreFetch = () => Promise.resolve(new Response(body, { status: 500 }));
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const error = (await http.postJson(SHOP_PATH, {}).catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return `${error.message}|${error.body}|${JSON.stringify(calls)}`;
}

/**
 * `[etiqueta, tag cualificado, valor testigo]`.
 *
 * - `mata-mutante` — el tramo local sólo casa por el Set EXACTO (`epr`, `agencyiata`,
 *   `iatanumber`, `sabregroup`, y `givenname` en el lado PII). Aplastado con el prefijo deja de
 *   casar por ninguna de las cuatro vías, así que sin el `.split(':')` el valor sale en claro.
 * - `suelo` — el tramo local casa además por FRAGMENTO (`pcc`), así que el mutante también los
 *   tapa. No prueban el `.split(':')`; prueban que el carril sigue vivo.
 */
const NAMESPACED_TAGS: ReadonlyArray<readonly [string, string, string]> = [
  ['mata-mutante', 'ns:epr', '500001'],
  ['mata-mutante', 'q:agencyIata', '99887766'],
  ['mata-mutante', 'p:iataNumber', '12345675'],
  ['mata-mutante', 's:sabreGroup', 'GRUPO-DE-LA-OFICINA'],
  ['mata-mutante', 'ns:givenName', 'JUANA-DE-PRUEBA'],
  ['suelo', 'a:pcc', 'ZZ1A'],
  ['suelo', 'x:homePcc', 'ZZ1B'],
];

describe('carril XML: el prefijo de namespace no salva al valor', () => {
  it.each(NAMESPACED_TAGS)('[%s] <%s> por redactMeta', (_grupo, tag, witness) => {
    const out = JSON.stringify(redactMeta({ detalle: `<${tag}>${witness}</${tag}>` }));

    expect(out, `el prefijo de <${tag}> dejó pasar el valor`).not.toContain(witness);
    expect(out).toContain(REDACTED);
  });

  it.each(NAMESPACED_TAGS)('[%s] <%s> por la puerta pública', async (_grupo, tag, witness) => {
    const dump = await xmlThroughHttpClient(
      `<soap:Envelope><soap:Body><${tag}>${witness}</${tag}></soap:Body></soap:Envelope>`,
    );

    expect(dump, `el prefijo de <${tag}> dejó pasar el valor`).not.toContain(witness);
  });

  it('el tramo local también manda con atributos y con prefijos anidados', async () => {
    // `XML_ELEMENT` captura los atributos aparte y los conserva; lo que se tapa es el CONTENIDO.
    const dump = await xmlThroughHttpClient(
      '<wsse:Security><wsse:UsernameToken Id="uuid-1">' +
        '<ns2:epr>500001</ns2:epr></wsse:UsernameToken></wsse:Security>',
    );

    expect(dump).not.toContain('500001');
    expect(dump).toContain(REDACTED);
  });
});

/**
 * El precio, medido en la otra dirección. Recortar por `:` no puede convertir vocabulario legítimo
 * del contrato en `«REDACTADO»`: un elemento cualificado cuyo tramo local es inocuo sigue saliendo
 * entero, y esos son los que llevan el diagnóstico de una búsqueda.
 */
const INNOCENT_TAGS: ReadonlyArray<readonly [string, string]> = [
  ['ns:carrierCode', 'AV'],
  ['soap:faultcode', 'soap:Server'],
  ['a:passengerType', 'ADT'],
  ['x:fieldPath', 'itineraryGroups[0]'],
  ['q:statusCode', 'ERR.0161'],
];

describe('el precio: un tramo local inocuo sigue saliendo entero', () => {
  it.each(INNOCENT_TAGS)('<%s> conserva su valor', (tag, value) => {
    const out = JSON.stringify(redactMeta({ detalle: `<${tag}>${value}</${tag}>` }));

    expect(out, `<${tag}> perdió su valor y con él el diagnóstico`).toContain(value);
  });
});
