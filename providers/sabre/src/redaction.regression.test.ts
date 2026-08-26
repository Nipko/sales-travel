import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED, redactMeta, redactText, safeBodySummary } from './redaction';

/**
 * Regresión del hallazgo 2 y del hallazgo 3 de la auditoría adversarial.
 *
 * Hallazgo 3: `safeBodySummary` apagaba la redacción por clave por encima de 20.000 caracteres.
 * Dos de los tres fixtures oficiales de BFM pesan 24.980 y 29.216 bytes, así que el camino
 * "degradado" era el camino normal de una búsqueda: `passportNumber`, `cardNumber` y el `secret`
 * sobrevivían intactos hasta el mensaje de la excepción.
 *
 * Hallazgo 2: un `secret` DESNUDO —sin el prefijo `Basic` y sin clave que lo acompañe— dentro de
 * un `error_description` de Sabre no lo veía nadie. Es base64 reversible: quien lea ese log tiene
 * el password de la oficina.
 *
 * Los tres testigos que se persiguen en todo el archivo son los del informe.
 */
const PASSPORT = 'AB1234567';
const PAN = '4111111111111111';
const CLIENT_ID = 'V1:500001:ZZZZ:AA';
/** `deriveSabreSecret({epr:'500001', homePcc:'ZZZZ', password:'Pa55w0rd!', domain:'AA'})`. */
const SECRET = 'VmpFNk5UQXdNREF4T2xwYVdsbzZRVUU9OlVHRTFOWGN3Y21RaA==';

const WITNESSES: readonly string[] = [PASSPORT, PAN, CLIENT_ID, SECRET];

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

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

/**
 * Camino real del cliente HTTP: el proveedor responde con `body` y `status`, y se devuelve lo
 * único que sale de aquí hacia fuera — la excepción y lo que vio el transporte de logs.
 */
async function throughHttpClient(
  body: string,
  status: number,
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
  expect(calls.length).toBeGreaterThan(0);
  return { error, logDump: JSON.stringify(calls) };
}

/** Se inyecta como PRIMERA clave: dentro de la ventana visible del resumen, donde más duele. */
function withProbe(fixture: unknown): string {
  return JSON.stringify(
    {
      auditProbe: {
        passportNumber: PASSPORT,
        cardNumber: PAN,
        // Desnudo a propósito: ni clave delatora, ni prefijo `Basic`, ni `secret=`.
        echoedRequest: `clientId ${CLIENT_ID} / ${SECRET}`,
      },
      ...(fixture as Record<string, unknown>),
    },
    null,
    2,
  );
}

const FIXTURES: ReadonlyArray<readonly [string, unknown]> = [
  ['v5-roundtrip-adult-200', adultFixture],
  ['v5-roundtrip-child-baggage-200', childFixture],
  ['v5-roundtrip-family-200', familyFixture],
];

describe('hallazgo 3 — los fixtures oficiales de BFM por el camino real del cliente HTTP', () => {
  it.each(FIXTURES)(
    '%s: ni el log ni el mensaje de la excepción dejan pasar pasaporte, tarjeta ni secret',
    async (_name, fixture) => {
      const body = withProbe(fixture);
      const { error, logDump } = await throughHttpClient(body, 500);

      for (const witness of WITNESSES) {
        expect(error.message).not.toContain(witness);
        expect(error.body).not.toContain(witness);
        expect(logDump).not.toContain(witness);
      }
      // Y se tapó, no se cayó del truncado: la marca está donde estaban los testigos.
      expect(error.message).toContain(REDACTED);
      // El resumen sigue sirviendo para diagnosticar.
      expect(error.message).toContain('Sabre 500 on /v5/offers/shop');
      expect(logDump).toContain('conv-fijo');
    },
  );

  it('los dos fixtures grandes cruzan de verdad el antiguo umbral de 20.000 caracteres', () => {
    const sizes = FIXTURES.map(([, fixture]) => withProbe(fixture).length);
    expect(sizes.filter((size) => size > 20_000)).toHaveLength(2);
  });
});

/**
 * Mismo contenido sensible, cuatro tamaños que rodean el antiguo umbral. Si alguna de las cuatro
 * filas se comporta distinto de las otras, la protección volvió a depender del tamaño.
 */
function bodyOfSize(bytes: number): string {
  const head = `{"passportNumber":"${PASSPORT}","cardNumber":"${PAN}","echoedRequest":"clientId ${CLIENT_ID} / ${SECRET}","filler":"`;
  const tail = '"}';
  return `${head}${'RELLENO-'.repeat(Math.ceil(Math.max(0, bytes - head.length - tail.length) / 8)).slice(0, Math.max(0, bytes - head.length - tail.length))}${tail}`;
}

describe('hallazgo 3 — la protección no depende del tamaño del body', () => {
  it.each([1_000, 19_000, 21_000, 100_000])('body de %i bytes', async (bytes) => {
    const body = bodyOfSize(bytes);
    expect(body.length).toBe(bytes);

    const { error, logDump } = await throughHttpClient(body, 500);
    for (const witness of WITNESSES) {
      expect(error.message).not.toContain(witness);
      expect(error.body).not.toContain(witness);
      expect(logDump).not.toContain(witness);
    }
    expect(error.message).toContain(REDACTED);
  });

  it('19.999 y 20.001 caracteres se redactan igual: ya no queda ningún umbral', () => {
    const below = safeBodySummary(bodyOfSize(19_999));
    const above = safeBodySummary(bodyOfSize(20_001));
    expect(below).toBe(above);
    for (const witness of WITNESSES) {
      expect(below).not.toContain(witness);
    }
  });
});

describe('hallazgo 2 — el secret desnudo en un error_description de Sabre', () => {
  it('no llega al mensaje del SabreApiError, y la clasificación no se resiente', async () => {
    const body = JSON.stringify({
      error: 'invalid_client',
      error_description: `Wrong clientID or clientSecret: ${CLIENT_ID} / ${SECRET}`,
    });
    const { error, logDump } = await throughHttpClient(body, 401);

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(CLIENT_ID);
    expect(error.body).not.toContain(SECRET);
    expect(logDump).not.toContain(SECRET);
    // La política se decide con el texto crudo, así que sigue marcando la cuenta BYOC.
    expect(error.code).toBe('invalid_client');
    expect(error.failure.kind).toBe('CREDENTIALS_INVALID');
    expect(error.failure.disableAccount).toBe(true);
  });

  it('redactText detecta el secret por FORMA, sin clave y sin prefijo Basic', () => {
    for (const carrier of [
      `el secret es ${SECRET} y punto`,
      `[${SECRET}]`,
      `token=${SECRET}`,
      `Basic ${SECRET}`,
    ]) {
      expect(redactText(carrier)).not.toContain(SECRET);
    }
    expect(redactText(`clientId=${CLIENT_ID}`)).not.toContain(CLIENT_ID);
    expect(redactText(`suelto ${CLIENT_ID} suelto`)).not.toContain(CLIENT_ID);
    // Y no se lleva por delante lo que sí hace falta para diagnosticar.
    expect(redactText('ERR.2SG.SEC.NOT_AUTHORIZED')).toBe('ERR.2SG.SEC.NOT_AUTHORIZED');
    expect(redactText('sales-travel-conv-fijo')).toBe('sales-travel-conv-fijo');
  });
});

describe('hallazgo 2 — epr, homePcc, clientId, pseudoCityCode y lo que deriva de ellos', () => {
  it('ninguno sale por el LoggerPort', () => {
    const meta = redactMeta({
      epr: '500001',
      homePcc: 'ZZZZ',
      clientId: CLIENT_ID,
      pseudoCityCode: 'ZZZZ',
      targetPcc: 'YYYY',
      ticketingPcc: 'XXXX',
      sabreCurrentCity: 'WWWW',
      cacheKey: 'sabre:atk:tenant-1:ZZZZ',
      path: SHOP_PATH,
    });

    for (const key of [
      'epr',
      'homePcc',
      'clientId',
      'pseudoCityCode',
      'targetPcc',
      'ticketingPcc',
      'sabreCurrentCity',
      'cacheKey',
    ]) {
      expect(meta[key]).toBe(REDACTED);
    }
    expect(meta['path']).toBe(SHOP_PATH);
  });

  it('las claves que nadie escribió en la lista también caen, por fragmento', () => {
    const meta = redactMeta({
      targetPccOverride: 'ZZZZ',
      accessTokenExpiresIn: 3_600,
      passportExpiryDate: '2031-01-01',
      carrierName: 'AV',
    });
    expect(meta['targetPccOverride']).toBe(REDACTED);
    expect(meta['accessTokenExpiresIn']).toBe(REDACTED);
    expect(meta['passportExpiryDate']).toBe(REDACTED);
    expect(meta['carrierName']).toBe('AV');
  });
});
