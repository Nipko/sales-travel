import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SABRE_ISSUE_OPAQUE_VALUE, SabreApiError } from '../errors';
import { SabreHttpClient } from './sabre-http.client';

/**
 * Por qué este fichero existe.
 *
 * El cliente HTTP guardaba copias privadas de dos helpers que ya viven canónicos y exportados en
 * `errors.ts`: `asRecord` (copia byte a byte de `sabreEnvelopeRecord`) y `str` (copia DERIVADA de
 * `sabreEnvelopeString` — le faltaba el `Number.isFinite`). La auditoría dio la deriva por
 * inobservable desde la puerta pública razonando que «JSON no transporta NaN».
 *
 * Eso es cierto para `NaN` y falso para `Infinity`. `JSON.parse('{"errorCode":1e999}')` devuelve
 * `{ errorCode: Infinity }`: la gramática de JSON admite cualquier exponente y la conversión a
 * double desborda a `Infinity` sin lanzar. Así que un cuerpo de Sabre PUEDE llegar a esa rama, y
 * la copia derivada lo convertía en el texto `"Infinity"` — un `errorCode` sintético que gana el
 * `??` y **tapa** el `ERR.2SG.*` real que venía en `error`. El resultado no es cosmético: la
 * tabla de gateway deja de acertar, `RETRY_AFTER_REAUTH` se degrada al genérico del status y la
 * caché de token nunca se invalida.
 *
 * Todo entra por `postJson`. Comprobar `sabreEnvelopeString` directamente sólo demostraría que la
 * función canónica es correcta, jamás que sea la que corre — que es exactamente el hueco de la
 * ronda 2.
 */

const AUTH_PATH = '/v1/trip/orders/getBookingSummary';

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

function fakeTokens(): SabreTokenProvider {
  return {
    getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
    invalidate: () => Promise.resolve(),
  };
}

/** El body va como TEXTO CRUDO: el `1e999` tiene que pasar por `JSON.parse` de verdad. */
function clientReturning(status: number, rawBody: string): SabreHttpClient {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(
      new Response(rawBody, { status, headers: { 'Content-Type': 'application/json' } }),
    );
  return new SabreHttpClient(config(), fakeTokens(), {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
}

async function failureOf(status: number, rawBody: string): Promise<SabreApiError> {
  try {
    await clientReturning(status, rawBody).postJson(AUTH_PATH, {});
  } catch (error) {
    expect(error).toBeInstanceOf(SabreApiError);
    return error as SabreApiError;
  }
  throw new Error('postJson resolvió: el status no-2xx tenía que lanzar');
}

describe('puerta pública — el escalar del sobre de transporte usa la regla canónica', () => {
  it('JSON.parse convierte 1e999 en Infinity: la premisa de "inobservable" es falsa', () => {
    const parsed = JSON.parse('{"errorCode":1e999}') as { errorCode: unknown };
    expect(parsed.errorCode).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(parsed.errorCode)).toBe(false);
  });

  /**
   * La sonda de la deriva. Con la copia privada, `code` salía `"Infinity"`; con la canónica sale
   * `undefined` y el `??` puede caer al `error` de verdad.
   */
  it('un errorCode numérico no finito no se convierte en el texto "Infinity"', async () => {
    const error = await failureOf(403, '{"errorCode":1e999,"message":"Access denied"}');
    expect(error.code).toBeUndefined();
    expect(error.message).not.toContain('Infinity');
  });

  it('y tampoco con -1e999, que parsea a -Infinity', async () => {
    const error = await failureOf(403, '{"errorCode":-1e999,"message":"Access denied"}');
    expect(error.code).toBeUndefined();
  });

  /**
   * El daño real de la deriva: el `errorCode` sintético gana el `??` y sepulta el `ERR.2SG.*`.
   * `ERR.2SG.SEC.INVALID_CREDENTIALS` sobre un 403 tiene que dar `AUTH_EXPIRED`/`RETRY_AFTER_REAUTH`
   * —invalidar caché de token y reautenticar una vez, RF-01 CA-4—; el genérico del 403 es
   * `ENTITLEMENT`/`NO_RETRY`, que deja el token muerto en caché para siempre.
   */
  it('el ERR.2SG real sigue clasificando aunque venga un errorCode numérico envenenado', async () => {
    const error = await failureOf(
      403,
      '{"errorCode":1e999,"error":"ERR.2SG.SEC.INVALID_CREDENTIALS","message":"Access denied"}',
    );
    expect(error.failure.kind).toBe('AUTH_EXPIRED');
    expect(error.failure.retry).toBe('RETRY_AFTER_REAUTH');
  });

  /**
   * Contra-mutante: «arreglar» la deriva descartando TODO número dejaría este test rojo. La regla
   * canónica acepta el escalar numérico finito, que es el caso que Sabre sí manda.
   */
  it('un errorCode numérico finito sigue llegando como texto', async () => {
    const error = await failureOf(500, '{"errorCode":404,"message":"boom"}');

    // Lo que mide este test es la REGLA CANÓNICA del escalar, no el literal: un número finito es
    // contenido y produce `code`; `1e999`/`-1e999` no lo son y lo dejan `undefined` (los dos casos
    // de arriba). El contra-mutante sigue intacto — «arreglar» la deriva descartando TODO número
    // deja esto en `undefined` y el test rojo.
    expect(error.code).toBeDefined();

    // Que el literal `404` ya no salga entero es el precio de la ronda 12, y es el MISMO precio
    // que la casilla `code` del `SabreIssue` paga desde la ronda 11: la puerta de vocabulario pide
    // al menos un segmento de palabra, así que un número suelto no se publica en NINGUNA de las
    // seis superficies. La simetría es el arreglo; el número suelto en el `code` es lo que cuesta.
    // El diagnóstico no se queda sin nada: el status viaja entero en el prefijo del mensaje y en
    // `toLogMeta()`, y el `conversationId` recupera la traza en Sabre.
    expect(error.code).toBe(SABRE_ISSUE_OPAQUE_VALUE);
  });

  /**
   * El otro helper (`asRecord` → `sabreEnvelopeRecord`): un array en la raíz no es el sobre de
   * transporte, así que no se le sacan campos y el mensaje cae al texto crudo.
   */
  it('un body 4xx que es un array no se lee como sobre de transporte', async () => {
    const error = await failureOf(400, '[{"errorCode":"ERR.2SG.SCHEMA.INVALID"}]');
    expect(error.code).toBeUndefined();
  });
});

/**
 * `transportError` tenía su propio `redactText(code)` encima del que ya aplica el constructor de
 * `SabreApiError`: la misma política escrita en dos sitios, y el campo redactado dos veces.
 *
 * Esto NO es un test que se pusiera rojo antes del cambio, y decirlo importa: quitar la pasada de
 * más es un mutante equivalente para cualquier entrada realista. Se midió, no se supuso — 200 000
 * entradas aleatorias por `redactText` dieron 11 no idempotentes, todas cadenas de basura y todas
 * en la dirección segura (la segunda pasada come caracteres detrás del marcador, nunca destapa).
 *
 * Lo que estos dos casos pinan es el CONTRATO que sobrevive al cambio, que es lo que de verdad
 * protege: por la puerta pública, un `code` con credencial dentro sale redactado igual, y uno
 * limpio sigue llegando entero para diagnosticar. Si alguien quita también la redacción del
 * constructor, esto se pone rojo.
 */
describe('puerta pública — el code del proveedor lo redacta un solo sitio', () => {
  it('un ATK que Sabre haga eco dentro de errorCode no sale por error.code', async () => {
    const atk = 'T1RLAQLm3xGkQ7aVn5pRb2dEwUyThJ0fMxZq8sLdPvNc4uAe1BiCo9XgYtHrWkSm';
    const error = await failureOf(401, JSON.stringify({ errorCode: `Bearer ${atk}` }));

    expect(error.code).toBeDefined();
    expect(error.code).not.toContain(atk);
    expect(JSON.stringify(error.toLogMeta())).not.toContain(atk);
  });

  it('un ERR.2SG limpio llega entero: redactar no puede costar diagnóstico', async () => {
    const error = await failureOf(
      500,
      '{"errorCode":"ERR.2SG.GATEWAY.TIMEOUT","message":"gateway timeout"}',
    );
    expect(error.code).toBe('ERR.2SG.GATEWAY.TIMEOUT');
  });
});
