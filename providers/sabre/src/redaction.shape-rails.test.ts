import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';

/**
 * M-R09 y M-R24 — las dos reglas por FORMA que no tenían red propia.
 *
 * `SABRE_SECRET_SHAPE` (`VmpF…`/`VjE6…`) y `JWT_SHAPE` (`eyJ….…`) estaban probadas sólo con
 * secretos y JWT REALES, que son largos: por encima de 32 caracteres del alfabeto base64 los tapa
 * `LONG_BASE64_RUN` por su cuenta. Medido con dos mutantes: borrar la pasada de
 * `SABRE_SECRET_SHAPE` y borrar la de `JWT_SHAPE` deja la suite entera en verde, porque ningún
 * test usaba un valor CORTO.
 *
 * Y el caso corto es real, no de laboratorio: Sabre hace eco de la request truncada en los
 * `error_description` de `/v2/auth/token` (docs/sabre/01 §5.3), y un JWT de header+payload mínimos
 * cabe de sobra por debajo del umbral de 32.
 *
 * ## Cómo se demuestra que sólo estas dos reglas pueden pasar el test
 *
 * Cada caso positivo va acompañado de un CONTROL: la misma cadena, misma longitud y misma mezcla
 * de mayúscula/minúscula/dígito, con el marcador cambiado (`VmpF`→`WmpF`, `eyJ`→`axJ`). El control
 * tiene que salir LITERAL. Si `LONG_BASE64_RUN` —o cualquier otra pasada— fuera quien tapa el
 * positivo, taparía también el control y el test se caería solo. Esa pareja es la sonda de
 * comportamiento que descarta el mutante equivalente.
 *
 * Todo por la puerta pública (`SabreHttpClient.postJson`).
 */

/** 16 caracteres: `VmpF` + 12. Pasa el `{8,}` de la regla y NO llega a los 32 de la tirada base64. */
const SHORT_SECRET = 'VmpFNk5UQXdNREF4';
/** El otro marcador: `base64("V1:…")` empieza por `VjE6`. */
const SHORT_CLIENT_B64 = 'VjE6NTAwMDAxOlpa';
/** Mismo tamaño y misma entropía, marcador equivocado: NADIE debe taparlo. */
const SHORT_NOT_SECRET = 'WmpFNk5UQXdNREF4';

/** JWT compacto: los tres segmentos miden 20/15/12, todos por debajo de los 32. */
const SHORT_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP';
/** JWT sin firma (`alg: none`), dos segmentos. */
const UNSIGNED_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0';
/** Mismo tamaño y misma forma, sin el `eyJ` que delata un header JSON en base64url. */
const SHORT_NOT_JWT = 'axJhbGciOiJIUzI1NiJ9.axJzdWIiOiIxIn0.dBjftJeZ4CVP';

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
  status = 401,
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

/**
 * El valor va DESNUDO: como ELEMENTO PELADO de un array —la única posición que no tiene clave— y
 * precedido de palabras que tampoco son clave sensible, para que no lo tape el carril por clave ni
 * el de prosa. Lo único que puede taparlo es la regla por forma que se está probando.
 *
 * Aquí iba `error_description`, descrita como «clave inocua». Dejó de serlo: es el campo donde
 * Sabre hace eco del `clientId` y del `secret` (docs/sabre/01 §5.3) y desde esta ronda lo tapa el
 * carril de TEXTO LIBRE. Con esa clave el testigo desaparecía por el carril equivocado y los
 * CONTROL de abajo —que exigen que una cadena inocua SOBREVIVA— se ponían rojos con razón: el
 * cuerpo entero se estaba colapsando. El elemento de array no deja esa ambigüedad, y `errors[]`
 * con escalares es además una forma real del proveedor.
 */
function bareValueBody(value: string): string {
  return JSON.stringify({
    error: 'invalid_client',
    errors: [`rechazado ${value} en la peticion`],
  });
}

describe('M-R09 — SABRE_SECRET_SHAPE tapa el secret CORTO, que la tirada base64 no ve', () => {
  it('un secret truncado con prefijo VmpF se tapa aunque mida 16 caracteres', async () => {
    const { error, logDump } = await throughHttpClient(bareValueBody(SHORT_SECRET));
    expect(error.message).not.toContain(SHORT_SECRET);
    expect(error.body).not.toContain(SHORT_SECRET);
    expect(logDump).not.toContain(SHORT_SECRET);
    expect(error.body).toContain(REDACTED);
  });

  it('el otro marcador, VjE6 (base64 del clientId), también', async () => {
    const { error, logDump } = await throughHttpClient(bareValueBody(SHORT_CLIENT_B64));
    expect(error.message).not.toContain(SHORT_CLIENT_B64);
    expect(error.body).not.toContain(SHORT_CLIENT_B64);
    expect(logDump).not.toContain(SHORT_CLIENT_B64);
  });

  it('CONTROL: la misma cadena sin el marcador sale literal — no la tapa LONG_BASE64_RUN', async () => {
    const { error } = await throughHttpClient(bareValueBody(SHORT_NOT_SECRET));
    // Si esto se cayera, el positivo de arriba no probaría `SABRE_SECRET_SHAPE`: probaría otra
    // regla que además estaría borrando texto de diagnóstico inocuo.
    expect(error.body).toContain(SHORT_NOT_SECRET);
  });
});

describe('M-R24 — JWT_SHAPE tapa el JWT COMPACTO, que la tirada base64 no ve', () => {
  it('un JWT de tres segmentos cortos se tapa entero', async () => {
    const { error, logDump } = await throughHttpClient(bareValueBody(SHORT_JWT));
    expect(error.message).not.toContain(SHORT_JWT);
    expect(error.body).not.toContain(SHORT_JWT);
    expect(logDump).not.toContain(SHORT_JWT);
    // Ni siquiera el payload suelto: el `sub` de un token es identidad de la cuenta.
    expect(error.body).not.toContain('eyJzdWIiOiIxIn0');
    expect(error.body).toContain(REDACTED);
  });

  it('un JWT sin firma (alg:none), de dos segmentos, también', async () => {
    const { error, logDump } = await throughHttpClient(bareValueBody(UNSIGNED_JWT));
    expect(error.message).not.toContain(UNSIGNED_JWT);
    expect(error.body).not.toContain(UNSIGNED_JWT);
    expect(logDump).not.toContain(UNSIGNED_JWT);
  });

  it('CONTROL: la misma forma sin el prefijo eyJ sale literal', async () => {
    const { error } = await throughHttpClient(bareValueBody(SHORT_NOT_JWT));
    expect(error.body).toContain(SHORT_NOT_JWT);
  });
});
