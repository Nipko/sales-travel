import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';

/**
 * Regresión de las dos coberturas que el escáner JSON incremental perdió respecto del carril
 * textual al que sustituyó (re-auditoría, hallazgos (a) y (b) del informe de redacción):
 *
 * (a) las CLAVES se emitían con `JSON.stringify(value)` sin pasar por `redactText`, así que un
 *     `clientId` o un `secret` EN POSICIÓN DE CLAVE salía en claro. El carril textual sí los
 *     tapaba: `{"V1:EPR1:ABC1:AA":1}` daba `{"«REDACTADO»":1}` y el escáner devolvía el original.
 * (b) los literales NUMÉRICOS se emitían tal cual, así que un PAN serializado como número JSON
 *     —`{"acct":4111111111111111}`— sobrevivía entero.
 *
 * Todo se ejercita POR LA PUERTA PÚBLICA del paquete (`SabreHttpClient.postJson`), nunca llamando
 * a `redactJsonStream` ni a `safeBodySummary`: la lección de esta ronda es que un test que invoca
 * la función interna prueba la defensa que él eligió, no la que corre en producción.
 */

const CLIENT_ID = 'V1:500001:ZZZZ:AA';
/** `deriveSabreSecret({epr:'500001', homePcc:'ZZZZ', password:'Pa55w0rd!', domain:'AA'})`. */
const SECRET = 'VmpFNk5UQXdNREF4T2xwYVdsbzZRVUU9OlVHRTFOWGN3Y21RaA==';
const PAN = '4111111111111111';
const PASSPORT = 'AB1234567';

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

/** Lo único que sale del paquete hacia fuera: la excepción y lo que vio el transporte de logs. */
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
async function expectSealed(body: string, witness: string): Promise<SabreApiError> {
  const { error, logDump } = await throughHttpClient(body);
  expect(error.message).not.toContain(witness);
  expect(error.body).not.toContain(witness);
  expect(logDump).not.toContain(witness);
  return error;
}

describe('regresión (a) — el secreto EN POSICIÓN DE CLAVE', () => {
  it('un clientId usado como clave de objeto no sale en claro', async () => {
    const error = await expectSealed(`{"${CLIENT_ID}":1,"status":"ERROR"}`, CLIENT_ID);
    // Se tapó, no se cayó del truncado.
    expect(error.body).toContain(REDACTED);
  });

  it('un secret usado como clave de objeto no sale en claro', async () => {
    const error = await expectSealed(`{"${SECRET}":"x","status":"ERROR"}`, SECRET);
    expect(error.body).toContain(REDACTED);
  });

  it('el clientId como clave anidada dentro de un mapa de ofertas tampoco sale', async () => {
    await expectSealed(`{"accounts":{"${CLIENT_ID}":{"quota":3}}}`, CLIENT_ID);
  });

  it('un secret como clave dentro de un array de objetos tampoco sale', async () => {
    await expectSealed(`{"batch":[{"${SECRET}":true}]}`, SECRET);
  });

  it('redactar la clave emitida no rompe la decisión sobre su valor', async () => {
    // `clientId` no cambia al pasar por `redactText`, así que el nombre del campo sigue en el
    // resumen y el diagnóstico se mantiene legible; lo que desaparece es el valor.
    const { error } = await throughHttpClient(`{"clientId":"${CLIENT_ID}","status":"ERROR"}`);
    expect(error.body).not.toContain(CLIENT_ID);
    expect(error.body).toContain('clientId');
    expect(error.body).toContain(REDACTED);
  });

  it('las claves inocuas siguen apareciendo literales: el resumen sirve para diagnosticar', async () => {
    const { error } = await throughHttpClient(
      '{"status":"NotProcessed","carrierCode":"AV","originLocation":"BOG"}',
    );
    expect(error.body).toContain('carrierCode');
    expect(error.body).toContain('originLocation');
    expect(error.body).toContain('AV');
  });
});

describe('regresión (b) — el PAN serializado como literal NUMÉRICO', () => {
  it('un PAN como número JSON bajo una clave inocua no sobrevive', async () => {
    const error = await expectSealed(`{"acct":${PAN},"status":"ERROR"}`, PAN);
    expect(error.body).toContain(REDACTED);
  });

  it('un PAN como elemento pelado de un array de números tampoco sobrevive', async () => {
    await expectSealed(`{"accts":[${PAN},4012888888881881]}`, PAN);
  });

  it('un PAN numérico anidado en un array de objetos tampoco sobrevive', async () => {
    await expectSealed(`{"payments":[{"instrument":${PAN}}]}`, PAN);
  });

  it('los números inocuos siguen enteros: Luhn es lo que separa un PAN de un importe', async () => {
    const { error } = await throughHttpClient(
      '{"totalFare":1234.56,"durationMinutes":320,"flightNumber":8231,"seats":9}',
    );
    for (const literal of ['1234.56', '320', '8231', '9']) {
      expect(error.body).toContain(literal);
    }
    expect(error.body).not.toContain(REDACTED);
  });
});

/**
 * Lo que la re-auditoría confirmó que YA se tapa bien. Está aquí para que el arreglo de (a) y (b)
 * no lo tumbe de rebote: son los ocho carriles que sostienen la invariante del módulo.
 */
describe('coberturas que no se pueden perder al arreglar (a) y (b)', () => {
  it('PII por clave con mayúsculas raras', async () => {
    await expectSealed(`{"PaSsPoRtNuMbEr":"${PASSPORT}","status":"ERROR"}`, PASSPORT);
  });

  it('PII por clave con separadores', async () => {
    await expectSealed(`{"passport-number":"${PASSPORT}","status":"ERROR"}`, PASSPORT);
  });

  it('PII dentro de un array de objetos', async () => {
    await expectSealed(`{"travelers":[{"passportNumber":"${PASSPORT}"}]}`, PASSPORT);
  });

  it('PII a profundidad 12', async () => {
    let node = `{"passportNumber":"${PASSPORT}"}`;
    for (let level = 0; level < 12; level++) node = `{"n${level}":${node}}`;
    await expectSealed(node, PASSPORT);
  });

  it('form-urlencoded por el carril suelto', async () => {
    await expectSealed('grant_type=client_credentials&password=Pa55w0rd!', 'Pa55w0rd!');
  });

  it('XML SOAP por el carril suelto', async () => {
    await expectSealed(
      '<soap:Envelope><UsernameToken><Password>Pa55w0rd!</Password></UsernameToken></soap:Envelope>',
      'Pa55w0rd!',
    );
  });

  it('JSON cortado a medias', async () => {
    await expectSealed(
      `{"traveler":{"passportNumber":"${PASSPORT}"},"offers":[{"id":"OF1"`,
      PASSPORT,
    );
  });

  /**
   * FUGA MEDIDA (ronda 12) — el corte que cae DENTRO del valor, no después.
   *
   * El test de aquí arriba se llama «JSON cortado a medias» y no cubría este caso: su corte llega
   * cuando el par sensible ya está CERRADO (`"passportNumber":"AB1234567"`), así que el carril
   * textual del fallback lo tapa igual con `JSON_PAIR` y todo salía verde. La forma que importa es
   * la otra —el cuerpo se corta con la comilla de cierre todavía por llegar— y ahí, medido por la
   * puerta pública antes de esta ronda:
   *
   *     postJson ← `{"password":"Pa55w0rd!`
   *     → error.body    = {"password":"Pa55w0rd!
   *     → error.message = Sabre 500 on /v5/offers/shop [UPSTREAM]: {"password":"Pa55w0rd!
   *
   * En claro. El escáner abortaba (`endOfJsonString` no encuentra cierre → `return null`) y caía al
   * carril textual, que NO puede ver un par sin cerrar: `JSON_PAIR` exige la comilla final y
   * `XML_ELEMENT` la etiqueta de cierre. O sea que el fallback de seguridad no tapaba nada
   * justamente en el único caso en el que se usaba.
   *
   * Y el cuerpo cortado no es de laboratorio: es lo que deja una conexión que se cae o un
   * balanceador que devuelve 502 con cuerpo parcial, que es cuando más se mira el log.
   *
   * Cada testigo lleva su CONTROL debajo: el mismo corte bajo una clave inocua tiene que salir
   * literal. Sin él, esto pasaría también con un escáner que tapara el cuerpo entero al primer
   * corte, que es tirar el diagnóstico.
   */
  describe('el corte que cae DENTRO del valor de una clave sensible', () => {
    it.each([
      ['una credencial', '{"password":"Pa55w0rd!', 'Pa55w0rd!'],
      ['un pasaporte tras un par completo', `{"a":1,"passportNumber":"${PASSPORT}`, PASSPORT],
      ['un token de acceso', '{"access_token":"T1RLAQL0000secretoDeOficina', 'T1RLAQL0000secreto'],
      ['PII de contacto', '{"givenName":"Ana Maria', 'Ana Maria'],
      [
        'el objeto entero bajo clave sensible',
        '{"credentials":{"password":"Pa55w0rd!',
        'Pa55w0rd!',
      ],
      [
        'una clave sensible anidada bajo una inocua',
        `{"traveler":{"passportNumber":"${PASSPORT}`,
        PASSPORT,
      ],
    ])('%s no sobrevive al corte', async (_name, body, witness) => {
      const error = await expectSealed(body, witness);
      expect(error.body, 'el corte dejó el resumen sin ninguna marca').toContain(REDACTED);
    });

    it('CONTROL: el mismo corte bajo una clave inocua sale literal', async () => {
      const { error } = await throughHttpClient('{"a":1,"itemId":"BAG1');
      expect(error.body).toContain('BAG1');
      expect(error.body).not.toContain(REDACTED);
    });

    it('CONTROL: lo que había ANTES del corte sigue siendo legible', async () => {
      const { error } = await throughHttpClient(
        '{"errorCode":"ERR.2SG.CLIENT.INVALID_REQUEST","password":"Pa55w0rd!',
      );
      expect(error.body).toContain('ERR.2SG.CLIENT.INVALID_REQUEST');
      expect(error.body).not.toContain('Pa55w0rd!');
    });
  });

  it('el secret DESNUDO por forma, sin clave y sin prefijo Basic', async () => {
    const body = JSON.stringify({
      error: 'invalid_client',
      error_description: `Wrong clientID or clientSecret: ${CLIENT_ID} / ${SECRET}`,
    });
    const { error } = await throughHttpClient(body, 401);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(CLIENT_ID);
    // La política se decide con el texto CRUDO: redactar no puede ablandar la clasificación.
    expect(error.failure.kind).toBe('CREDENTIALS_INVALID');
    expect(error.failure.disableAccount).toBe(true);
  });
});

/**
 * El presupuesto es de SALIDA, no de entrada: es la propiedad que mató al camino degradado de los
 * 20.000 caracteres y la que no se puede perder al meter `redactText` en dos ramas más del
 * escáner.
 *
 * Este bloque medía `msPerOp` con `process.hrtime` y exigía `< 10 ms`. Era un GENERADOR DE FALSOS
 * ROJOS: vitest corre los ficheros en paralelo, así que bastaba con que otro fichero cargara la
 * CPU —o que la máquina de CI compartiera núcleo— para ponerlo en rojo sin que hubiera cambiado
 * una línea. Un test que falla por el vecino enseña al equipo a ignorar los rojos, y un rojo
 * ignorado en ESTE paquete es una reserva fantasma que nadie mira.
 *
 * Se sustituye por dos afirmaciones deterministas, que son la mitad observable de la invariante:
 *
 *  1. el resumen está acotado por `DEFAULT_BODY_SUMMARY_CHARS`, no por el tamaño de la entrada;
 *  2. el resumen de un body de 100 KB y el de uno de 1 MB con el MISMO prefijo son idénticos byte
 *     a byte — o sea, la salida no depende de cuánta entrada haya detrás.
 *
 * La otra mitad —el COSTE en tiempo— no se puede afirmar sin reloj, así que se ha ido a
 * `redaction.budget.bench.ts`, que corre con `vitest bench` y NO forma parte de esta suite. Ahí el
 * número no rompe nada; aquí no puede volver.
 */
describe('el presupuesto sigue atado al tamaño del resumen, no al del body', () => {
  /** Ítems de oferta realistas: cada uno trae PII y un PAN, para que la redacción sí trabaje. */
  function offersBody(minBytes: number): string {
    const item = (index: number): string =>
      `{"id":"OFFER-${index}","totalPrice":1234567.89,"acct":${PAN},"traveler":{"givenName":"Ana","passportNumber":"${PASSPORT}"}}`;
    const chunks: string[] = [];
    let size = 0;
    for (let index = 0; size < minBytes; index++) {
      const next = item(index);
      chunks.push(next);
      size += next.length + 1;
    }
    return `{"items":[${chunks.join(',')}]}`;
  }

  it('un body de 1 MB produce un resumen acotado, y el mismo que uno de 100 KB', async () => {
    const small = offersBody(100_000);
    const big = offersBody(1_000_000);
    expect(big.length).toBeGreaterThan(1_000_000);
    // Mismo generador ⇒ mismo prefijo: lo único que cambia entre los dos es la cola.
    expect(big.startsWith(small.slice(0, 10_000))).toBe(true);

    const { error: smallError } = await throughHttpClient(small);
    const { error: bigError } = await throughHttpClient(big);

    expect(bigError.body.length).toBeLessThanOrEqual(301);
    expect(bigError.body).toBe(smallError.body);
    // Y sigue siendo un resumen útil y redactado, no un truncado mudo.
    expect(bigError.body).toContain('OFFER-0');
    expect(bigError.body).toContain(REDACTED);
    expect(bigError.body).not.toContain(PASSPORT);
    expect(bigError.body).not.toContain(PAN);
  });

  it('una CLAVE gigante tampoco hace crecer el resumen', async () => {
    // Redactar la clave emitida abrió esta puerta: sin acotar, un proveedor hostil que mande una
    // clave de 1 MB haría correr las nueve pasadas de `redactText` sobre el megabyte entero. Lo
    // que se puede afirmar sin reloj es que la clave EMITIDA está clampada.
    const summaries: string[] = [];
    for (const size of [100_000, 1_000_000]) {
      const { error } = await throughHttpClient(`{"${'K'.repeat(size)}":1,"status":"ERROR"}`);
      expect(error.body.length).toBeLessThanOrEqual(301);
      summaries.push(error.body);
    }
    expect(summaries[1]).toBe(summaries[0]);
  });
});
