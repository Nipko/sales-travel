import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreApiError, classifySabreEnvelope, type SabreIssue } from '../errors';
import { SabreHttpClient, isNonIdempotentSabrePath } from './sabre-http.client';

/**
 * Dos cosas que el cliente HTTP tiraba y que no son de seguridad, sino de PODER DIAGNOSTICAR.
 *
 * ## 1. Los `warnings` del veredicto se perdían
 *
 * Cuando un sobre se rechaza, `classifySabreEnvelope` devuelve DOS listas y el cliente sólo pasaba
 * `failures` al `SabreApiError`. Medido sobre 12.000 sobres hostiles: en 750 (6,25 %) el rechazo
 * llegaba con un único issue de categoría `UNSTRUCTURED` —o sea, «había algo bajo una clave de
 * error y no tenía forma reconocible»— mientras el ÚNICO dato estructurado que explicaba el fallo
 * (`category`, `type`, `code`, `fieldPath`) vivía en un issue de severidad `warning`.
 *
 * Resultado para soporte: un error real, con el dato en la mano del paquete, y un log que dice
 * «hubo algo y no sé qué era».
 *
 * ## 2. La ruta con `#` dejaba de ser una operación de dinero
 *
 * `isNonIdempotentSabrePath` tenía su propia normalización de rutas, copia de `sabreOperationToken`
 * de `errors.ts`, y **ya había divergido**: partía sólo por `?`. Con un `#` en la ruta,
 * `moneyOperation` salía `false` y `postJson` volvía a permitir reintentos de una escritura.
 * Reintentar una reserva crea dos.
 */

const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';
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

interface FetchSpy {
  readonly calls: string[];
  readonly fetch: SabreFetch;
}

function spyFetch(respond: () => Response): FetchSpy {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url) => {
      calls.push(url);
      return Promise.resolve(respond());
    },
  };
}

function client(fetchImpl: SabreFetch): SabreHttpClient {
  return new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
}

/** Puerta pública: el sobre entra por `postJson` y sale por el error que lanza. */
async function errorFor(payload: unknown, path = SHOP_PATH): Promise<SabreApiError> {
  const spy = spyFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
  const error = (await client(spy.fetch)
    .postJson(path, {}, { idempotent: true })
    .catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return error;
}

/**
 * El sobre del caso medido: el rechazo lo produce un issue SIN estructura y todo lo que explica el
 * fallo está en el warning. Si el cliente sólo pasa `failures`, el log sale ciego.
 */
const UNSTRUCTURED_WITH_STRUCTURED_WARNING = {
  errors: ['algo que no tiene forma de issue'],
  warnings: [
    {
      severity: 'Warning',
      category: 'BUSINESS_ERROR',
      type: 'VALIDATION',
      code: 'ERR.0161',
      fieldPath: 'passenger.givenName',
    },
  ],
};

describe('el error de un sobre rechazado publica también los warnings del veredicto', () => {
  it('la premisa del caso: el fallo es UNSTRUCTURED y el dato vive en warnings', () => {
    // Sin esta comprobación el test podría pasar por un sobre que sí traía failures estructuradas,
    // que no es el caso que se está arreglando.
    const verdict = classifySabreEnvelope(UNSTRUCTURED_WITH_STRUCTURED_WARNING, {
      path: SHOP_PATH,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((issue: SabreIssue) => issue.category)).toEqual(['UNSTRUCTURED']);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]?.code).toBe('ERR.0161');
  });

  it('`toLogMeta()` publica el warning con sus campos estructurados', async () => {
    const error = await errorFor(UNSTRUCTURED_WITH_STRUCTURED_WARNING);
    const issues = error.toLogMeta()['issues'] as ReadonlyArray<Record<string, unknown>>;

    expect(issues, 'el veredicto traía dos issues y el error publicó menos').toHaveLength(2);
    const warning = issues.find((issue) => issue['severity'] === 'warning');
    expect(
      warning,
      'el único dato que explicaba el fallo se quedó en el veredicto y no llegó al log',
    ).toBeDefined();
    expect(warning?.['category']).toBe('BUSINESS_ERROR');
    expect(warning?.['type']).toBe('VALIDATION');
    expect(warning?.['code']).toBe('ERR.0161');
    expect(warning?.['fieldPath']).toBe('passenger.givenName');
  });

  it('la severidad los separa: un warning no puede leerse como la causa del rechazo', async () => {
    const error = await errorFor(UNSTRUCTURED_WITH_STRUCTURED_WARNING);
    const issues = error.toLogMeta()['issues'] as ReadonlyArray<Record<string, unknown>>;

    expect(issues.map((issue) => issue['severity'])).toEqual(['error', 'warning']);
    // Y el orden no es casual: las failures primero, que es lo que soporte lee arriba.
    expect(issues[0]?.['category']).toBe('UNSTRUCTURED');
  });

  it('la CLASIFICACIÓN sigue saliendo sólo de `failures[0]`', async () => {
    // El warning trae `category: 'BUSINESS_ERROR'`. Si el clasificador lo mirara, el `kind`
    // cambiaría respecto del mismo sobre sin warning — y con él la política de reintento.
    const sinWarning = await errorFor({ errors: ['algo que no tiene forma de issue'] });
    const conWarning = await errorFor(UNSTRUCTURED_WITH_STRUCTURED_WARNING);

    expect(conWarning.failure.kind).toBe(sinWarning.failure.kind);
    expect(conWarning.failure.retry).toBe(sinWarning.failure.retry);
    expect(conWarning.failure.circuit).toBe(sinWarning.failure.circuit);
  });
});

describe('`partialUnauthorized` viaja en el error — una sola vez', () => {
  const UNAUTHORIZED_WARNING = {
    errors: ['algo que no tiene forma de issue'],
    warnings: [{ severity: 'Warning', category: 'UNAUTHORIZED', type: 'ENTITLEMENT' }],
  };

  it('la marca de entitlement llega al log', async () => {
    const error = await errorFor(UNAUTHORIZED_WARNING);
    const issues = error.toLogMeta()['issues'] as ReadonlyArray<Record<string, unknown>>;

    expect(issues.filter((issue) => issue['category'] === 'UNAUTHORIZED')).toHaveLength(1);
  });

  it('y no se duplica, porque es un FILTRO de failures ∪ warnings', async () => {
    // La afirmación que el comentario del cliente hace —«`partialUnauthorized` ya está aquí»— se
    // fija aquí en vez de creerse: si `classifySabreEnvelope` dejara de calcularlo como filtro de
    // esas dos listas, concatenarlo aparte pasaría a ser necesario y esto se pondría rojo.
    const verdict = classifySabreEnvelope(UNAUTHORIZED_WARNING, { path: SHOP_PATH });
    const union = [...verdict.failures, ...verdict.warnings];
    for (const issue of verdict.partialUnauthorized) {
      expect(
        union,
        'partialUnauthorized dejó de ser un subconjunto de failures ∪ warnings',
      ).toContain(issue);
    }

    const error = await errorFor(UNAUTHORIZED_WARNING);
    expect(error.issues).toHaveLength(union.length);
  });
});

describe('la ruta con fragmento sigue siendo una operación de dinero', () => {
  it.each([
    ['fragmento', `${CREATE_BOOKING_PATH}#tramo`],
    ['query y fragmento', `${CREATE_BOOKING_PATH}?pcc=ZZZZ#tramo`],
    ['fragmento y barra final', `${CREATE_BOOKING_PATH}/#tramo`],
  ])('%s: `isNonIdempotentSabrePath` la reconoce', (_name, path) => {
    expect(isNonIdempotentSabrePath(path)).toBe(true);
  });

  it('y `postJson` NO la reintenta aunque quien llame jure que es idempotente', async () => {
    // El fallo que esto cierra: con la normalización vieja —partir sólo por `?`— este mismo caso
    // hacía tres intentos. Tres `createBooking` son hasta tres reservas cobradas.
    const spy = spyFetch(
      () =>
        new Response(JSON.stringify({ errorCode: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED' }), {
          status: 429,
        }),
    );

    await expect(
      client(spy.fetch).postJson(`${CREATE_BOOKING_PATH}#tramo`, {}, { idempotent: true }),
    ).rejects.toBeInstanceOf(SabreApiError);

    expect(spy.calls, 'una escritura se reintentó: eso duplica la reserva').toHaveLength(1);
  });

  it('el mismo 429 sobre una búsqueda sí agota los reintentos (el test de arriba no es vacuo)', async () => {
    const spy = spyFetch(
      () =>
        new Response(JSON.stringify({ errorCode: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED' }), {
          status: 429,
        }),
    );

    await expect(
      client(spy.fetch).postJson(`${SHOP_PATH}#tramo`, {}, { idempotent: true }),
    ).rejects.toBeInstanceOf(SabreApiError);

    expect(spy.calls).toHaveLength(3);
  });
});
