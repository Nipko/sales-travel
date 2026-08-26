/**
 * Regresiones de la RE-AUDITORÍA de `providers/sabre`.
 *
 * Las dos que se cierran aquí:
 *
 * - **ALTO 2** — el `secret` se fugaba por el campo `code` del mensaje de excepción. El cliente
 *   HTTP se acordaba de redactarlo en su sitio de llamada; el token service no. Y Sabre hace eco
 *   de la request en los errores de `/v2/auth/token`, así que el `clientId` y el `secret` acababan
 *   en `error.message`. El `secret` es base64 REVERSIBLE: quien lea ese log tiene el password de
 *   la oficina.
 * - **BAJO** — `classifySabreEnvelope` daba `ok: true` a un `200` cuyo cuerpo es un escalar JSON.
 *
 * Estos tests entran por la **puerta pública**: el carril 401 se ejercita con
 * `SabreTokenService.getToken()`, no llamando a funciones internas. Es la lección de esta ronda —
 * la suite anterior estaba verde probando una defensa que ningún camino de producción invocaba.
 */

import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_ISSUE_NOT_VERIFIABLE, SabreApiError, classifySabreEnvelope } from './errors';
import { SabreTokenService, deriveSabreSecret, type SabreFetch } from './auth/token.service';
import { REDACTED } from './redaction';

const CREDENTIALS = { epr: '500001', homePcc: 'U9PK', password: 'Pa55w0rd!' } as const;

/** `V1:{EPR}:{PCC}:{Domain}` — la mitad de identidad del `secret`. */
const CLIENT_ID = `V1:${CREDENTIALS.epr}:${CREDENTIALS.homePcc}:AA`;
const SECRET = deriveSabreSecret(CREDENTIALS);

/**
 * Evidencia real capturada por la re-auditoría: Sabre devuelve el `error` de OAuth2 con la request
 * pegada detrás. Ese sufijo `VmpF…` es el `Authorization: Basic` entero.
 */
const ECHOED_ERROR = `invalid_client:${CLIENT_ID}:${SECRET}`;

/** Todo lo que jamás puede salir del proceso, ni en un mensaje ni en un log (RNF-07, R-13). */
const FORBIDDEN = [SECRET, CLIENT_ID, CREDENTIALS.password] as const;

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return { host: SABRE_HOSTS.cert.rest, ...CREDENTIALS, ...overrides };
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

function spyFetch(responder: () => Response): { fetch: SabreFetch; count: () => number } {
  let calls = 0;
  return {
    count: () => calls,
    fetch: () => {
      calls += 1;
      return Promise.resolve(responder());
    },
  };
}

interface AuthFailure {
  error: SabreApiError;
  logs: LogCall[];
  attempts: number;
}

/** Puerta pública: se pide un token y se recoge el `SabreApiError` que sale del carril 401. */
async function failAuth(body: Record<string, unknown>): Promise<AuthFailure> {
  const spy = spyFetch(() => new Response(JSON.stringify(body), { status: 401 }));
  const { logger, calls } = spyLogger();
  const service = new SabreTokenService(config(), {
    fetch: spy.fetch,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
  });
  const error = (await service.getToken().catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return { error, logs: calls, attempts: spy.count() };
}

describe('hallazgo ALTO 2 — el `code` del error no puede llevar el secret encima', () => {
  it('un 401 con la request en eco no filtra el secret ni el clientId por message ni por code', async () => {
    const { error, logs } = await failAuth({ error: ECHOED_ERROR });

    for (const secreto of FORBIDDEN) {
      expect(error.message).not.toContain(secreto);
      expect(error.code ?? '').not.toContain(secreto);
      expect(error.body).not.toContain(secreto);
      expect(JSON.stringify(logs)).not.toContain(secreto);
    }
    // La redacción tiene que haberse aplicado de verdad, no haberse quedado sin `code`.
    expect(error.code).toContain(REDACTED);
    expect(error.message).toContain(REDACTED);
  });

  it('sigue siendo diagnosticable: el literal que clasifica sobrevive a la redacción', async () => {
    const { error } = await failAuth({ error: ECHOED_ERROR });

    expect(error.code).toContain('invalid_client');
    expect(error.message).toContain('[AUTH_POOL]');
    expect(error.message).toContain('/v2/auth/token');
  });

  // La clasificación mira el texto CRUDO: si se redactara antes de clasificar, este veredicto
  // cambiaría y una saturación de TAM Pool pasaría a ser un fallo genérico.
  it('el veredicto no cambia: invalid_client sigue siendo AUTH_POOL reintentable', async () => {
    const { error, attempts } = await failAuth({ error: ECHOED_ERROR });

    expect(error.failure.kind).toBe('AUTH_POOL');
    expect(error.failure.disableAccount).toBe(false);
    expect(error.retryable).toBe(true);
    expect(attempts).toBe(3);
  });

  // El caso que de verdad importa para la política BYOC: «Wrong clientID» marca la cuenta. Esa
  // decisión depende de comparar literales, y tiene que seguir saliendo igual con el eco delante.
  it('el veredicto no cambia: Wrong clientID sigue marcando la cuenta BYOC y no se reintenta', async () => {
    const { error, attempts } = await failAuth({
      error: ECHOED_ERROR,
      error_description: `Wrong clientID or clientSecret for ${CLIENT_ID}`,
    });

    expect(error.failure.kind).toBe('CREDENTIALS_INVALID');
    expect(error.failure.disableAccount).toBe(true);
    expect(attempts).toBe(1);
    for (const secreto of FORBIDDEN) {
      expect(error.message).not.toContain(secreto);
      expect(error.code ?? '').not.toContain(secreto);
    }
  });

  // `toLogMeta` es lo que acaba en el transporte de logs. Que el `LoggerPort` del token service lo
  // pase por `redactMeta` no basta: cualquier otro consumidor lo serializa tal cual.
  it('toLogMeta sale ya redactado, sin depender de que el consumidor redacte', async () => {
    const { error } = await failAuth({ error: ECHOED_ERROR });
    const dump = JSON.stringify(error.toLogMeta());

    for (const secreto of FORBIDDEN) expect(dump).not.toContain(secreto);
  });

  // El `path` también entra al mensaje. La ruta se conserva —es el único dato que dice qué se
  // rompió— pero la query, que es por donde viajan localizadores y PII, no.
  it('la query del path no entra al mensaje; la ruta sí', () => {
    const error = new SabreApiError(
      404,
      '{}',
      '/v1/trip/orders/getBooking?passportNumber=AB1234567',
    );

    expect(error.message).toContain('/v1/trip/orders/getBooking');
    expect(error.message).not.toContain('AB1234567');
    expect(error.path).toBe(`/v1/trip/orders/getBooking?${REDACTED}`);
  });
});

/**
 * «El recorrido terminó y no apareció nada con severidad error» es VACUAMENTE cierto para algo que
 * no es un sobre. La carga de la prueba invertida existe justamente para no aceptar vacíos.
 */
describe('hallazgo BAJO — un escalar JSON no es un sobre verificable', () => {
  it('un 200 con cuerpo escalar no es éxito', () => {
    expect(classifySabreEnvelope('OK').ok).toBe(false);
    expect(classifySabreEnvelope(true).ok).toBe(false);
    expect(classifySabreEnvelope(42).ok).toBe(false);
    expect(classifySabreEnvelope('').ok).toBe(false);
    expect(classifySabreEnvelope(null).ok).toBe(false);
    expect(classifySabreEnvelope(undefined).ok).toBe(false);
  });

  it('cae por la puerta de siempre: no exhaustivo ⇒ ENVELOPE_NOT_VERIFIABLE', () => {
    const verdict = classifySabreEnvelope('OK');

    expect(verdict.exhaustive).toBe(false);
    expect(verdict.failures).toContainEqual({
      source: 'application',
      severity: 'error',
      category: SABRE_ISSUE_NOT_VERIFIABLE,
    });
  });

  /**
   * RONDA 3 — esta fila decía lo contrario, y la doctrina del propio módulo la contradecía.
   *
   * Un `{}` cumple «el recorrido terminó y no apareció nada con severidad error» exactamente igual
   * de VACÍAMENTE que el escalar `"OK"` de los tests de arriba, que sí se rechaza. Aceptar uno y
   * rechazar el otro no era una regla, era una asimetría: un `createBooking` que responde `{}` no
   * ha devuelto la reserva que el contrato promete. El coste de rechazarlo es un reintento; el de
   * aceptarlo, una reserva que el cliente pagó y no existe.
   *
   * El sobre con CONTENIDO y sin problemas sigue siendo éxito: ahí no hay nada vacuo.
   */
  it('un sobre vacío tampoco es un sobre verificable', () => {
    for (const empty of [{}, []]) {
      const verdict = classifySabreEnvelope(empty);
      expect(verdict.ok).toBe(false);
      expect(verdict.exhaustive).toBe(false);
      expect(verdict.failures).toContainEqual({
        source: 'application',
        severity: 'error',
        category: SABRE_ISSUE_NOT_VERIFIABLE,
      });
    }
  });

  // Y la regla no se pasa de frenada: en cuanto hay contenido, el sobre se juzga por su contenido.
  it('un sobre con contenido y sin problemas sigue siendo éxito', () => {
    expect(classifySabreEnvelope({ groupedItineraryResponse: { version: '5' } }).ok).toBe(true);
    expect(classifySabreEnvelope({ errors: [] }).ok).toBe(true);
    expect(classifySabreEnvelope([{ id: 1 }]).ok).toBe(true);
  });
});
