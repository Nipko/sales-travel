import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import {
  SABRE_ENVELOPE_MAX_DEPTH,
  SABRE_ENVELOPE_NODE_BUDGET,
  SABRE_ISSUE_NOT_PROCESSED,
  SABRE_ISSUE_NOT_VERIFIABLE,
  SABRE_MAX_ATTEMPTS,
  SABRE_MIN_BACKOFF_MS,
  SabreApiError,
  classifySabreEnvelope,
  classifySabreFailure,
  sabreBackoffDelayMs,
  type SabreFailureSignal,
} from './errors';

describe('classifySabreFailure — capa de gateway (tabla oficial 2SG)', () => {
  const cases: Array<
    [string, SabreFailureSignal, { retry: string; circuit: string; kind: string }]
  > = [
    ['red caída', { status: 0 }, { retry: 'RETRY_BACKOFF', circuit: 'COUNT', kind: 'TRANSPORT' }],
    [
      '400 request inválida',
      { status: 400, code: 'ERR.2SG.CLIENT.INVALID_REQUEST' },
      { retry: 'NO_RETRY', circuit: 'IGNORE', kind: 'CLIENT_BUG' },
    ],
    [
      '401 token rechazado por el gateway',
      { status: 401, code: 'ERR.2SG.SEC.INVALID_CREDENTIALS' },
      { retry: 'RETRY_AFTER_REAUTH', circuit: 'IGNORE', kind: 'AUTH_EXPIRED' },
    ],
    [
      '403 producto no activado',
      { status: 403, code: 'ERR.2SG.SEC.NOT_AUTHORIZED' },
      { retry: 'NO_RETRY', circuit: 'IGNORE', kind: 'ENTITLEMENT' },
    ],
    [
      '403 path inexistente',
      { status: 403, code: 'ERR.2SG.CLIENT.SERVICE_UNKNOWN' },
      { retry: 'NO_RETRY', circuit: 'IGNORE', kind: 'CLIENT_BUG' },
    ],
    [
      '404 sin datos',
      { status: 404, text: 'Response does not contain any data' },
      { retry: 'NO_RETRY', circuit: 'IGNORE', kind: 'NO_DATA' },
    ],
    [
      '429 throttling',
      { status: 429, code: 'ERR.2SG.GATEWAY.REQUEST_THROTTLED' },
      { retry: 'RETRY_BACKOFF', circuit: 'IGNORE', kind: 'THROTTLED' },
    ],
    [
      '429 concurrencia',
      { status: 429, text: 'Active token count is exceeded' },
      { retry: 'RETRY_BACKOFF', circuit: 'IGNORE', kind: 'THROTTLED' },
    ],
    [
      '500 timeout del gateway',
      { status: 500, code: 'ERR.2SG.GATEWAY.TIMEOUT' },
      { retry: 'RETRY_BACKOFF', circuit: 'COUNT', kind: 'UPSTREAM' },
    ],
    [
      '500 respuesta del proveedor rota',
      { status: 500, code: 'ERR.2SG.GATEWAY.INVALID_PROVIDER_RESPONSE' },
      { retry: 'NO_RETRY', circuit: 'OPEN_NOW', kind: 'UPSTREAM' },
    ],
    ['503', { status: 503 }, { retry: 'RETRY_BACKOFF', circuit: 'OPEN_NOW', kind: 'UPSTREAM' }],
    ['504', { status: 504 }, { retry: 'RETRY_BACKOFF', circuit: 'OPEN_NOW', kind: 'UPSTREAM' }],
  ];

  it.each(cases)('%s', (_label, signal, expected) => {
    const failure = classifySabreFailure(signal);
    expect({ retry: failure.retry, circuit: failure.circuit, kind: failure.kind }).toEqual(
      expected,
    );
  });

  // Un 403 de entitlement y un 404 sin datos NO pueden abrir el circuito: si lo hicieran, el
  // breaker abriría en cada ruta sin vuelos y en cada tenant sin el producto activado (RNF-03).
  it('entitlement y sin-datos no cuentan para el breaker', () => {
    expect(classifySabreFailure({ status: 403 }).circuit).toBe('IGNORE');
    expect(classifySabreFailure({ status: 404 }).circuit).toBe('IGNORE');
  });
});

describe('classifySabreFailure — los dos 401 que se parecen y no son lo mismo', () => {
  it('invalid_client NUNCA deshabilita la cuenta: puede ser el TAM Pool agotado', () => {
    const failure = classifySabreFailure({ status: 401, code: 'invalid_client' });
    expect(failure.kind).toBe('AUTH_POOL');
    expect(failure.retry).toBe('RETRY_BACKOFF');
    expect(failure.disableAccount).toBe(false);
  });

  it('"Wrong clientID or clientSecret" sí marca la cuenta como inválida', () => {
    const failure = classifySabreFailure({
      status: 401,
      text: 'Wrong clientID or clientSecret',
    });
    expect(failure.kind).toBe('CREDENTIALS_INVALID');
    expect(failure.retry).toBe('NO_RETRY');
    expect(failure.disableAccount).toBe(true);
  });

  it('"Credentials are missing or the syntax is not correct" es bug nuestro del doble base64', () => {
    const failure = classifySabreFailure({
      status: 401,
      text: 'Credentials are missing or the syntax is not correct',
    });
    expect(failure.kind).toBe('CLIENT_BUG');
    expect(failure.disableAccount).toBe(false);
    expect(failure.operatorAlert).toBe(true);
  });
});

describe('classifySabreFailure — capa de aplicación dentro de un 200', () => {
  /**
   * Aquí había dos tests que desempataban los siete `UNAUTHORIZED` con `signal.description`, y uno
   * de ellos esperaba `RETRY_AFTER_REAUTH`. Medían una rama que producción NO podía ejecutar:
   * ningún sitio de llamada rellena `description` porque el texto libre del proveedor no cruza la
   * frontera de `SabreIssue` (RNF-07). Es el patrón de la ronda 2 en pequeño — test verde sobre
   * código que nadie invoca — y la rama se borró junto con el campo.
   *
   * Lo que queda es el comportamiento real, y el mismo caso entra además por la puerta pública en
   * `errors.benign.regression.test.ts`, que es donde de verdad se demuestra.
   */
  it('UNAUTHORIZED dentro de un 200 es entitlement y no se reintenta', () => {
    const failure = classifySabreFailure({
      status: 200,
      category: 'UNAUTHORIZED',
      type: 'UNAUTHORIZED_ACCESS',
    });
    expect(failure.kind).toBe('ENTITLEMENT');
    expect(failure.retry).toBe('NO_RETRY');
    expect(failure.operatorAlert).toBe(true);
  });

  /**
   * La recuperación del token expirado no se pierde con esa rama: vive en los dos carriles que sí
   * están cableados —el código del gateway y el 401— y se reintenta en los dos.
   */
  it('el token expirado se recupera por los carriles que sí invoca producción', () => {
    expect(
      classifySabreFailure({ status: 200, code: 'ERR.2SG.SEC.INVALID_CREDENTIALS' }).retry,
    ).toBe('RETRY_AFTER_REAUTH');
    expect(classifySabreFailure({ status: 401 }).retry).toBe('RETRY_AFTER_REAUTH');
  });

  it('ATH_TOKEN_FAILURE se reintenta: Sabre lo pide explícitamente', () => {
    expect(classifySabreFailure({ status: 200, type: 'ATH_TOKEN_FAILURE' }).retry).toBe(
      'RETRY_BACKOFF',
    );
  });

  it('los warnings de reserva a medias van a revisión humana, nunca a reintento', () => {
    const failure = classifySabreFailure({ status: 200, type: 'PARTIAL_FULFILLMENT' });
    expect(failure.kind).toBe('HUMAN_REVIEW');
    expect(failure.retry).toBe('NO_RETRY');
  });

  // Las categorías compuestas aparecen 43 veces en las listas oficiales; la errata también existe.
  it('normaliza categorías compuestas y la errata APPLICATION_EROR', () => {
    expect(classifySabreFailure({ status: 200, category: 'CANCELLATION_ERROR/WARNING' }).kind).toBe(
      'BUSINESS',
    );
    expect(classifySabreFailure({ status: 200, category: 'APPLICATION_EROR' }).kind).toBe(
      'BUSINESS',
    );
  });

  it('un fallo de negocio hace fallar la operación pero no abre circuito', () => {
    const failure = classifySabreFailure({
      status: 200,
      category: 'BAD_REQUEST',
      type: 'REQUIRED_FIELD_MISSING',
    });
    expect(failure.kind).toBe('BUSINESS');
    expect(failure.circuit).toBe('IGNORE');
  });
});

/**
 * Los siete bypasses que la auditoría demostró EJECUTANDO contra la versión anterior de la regla:
 * en los siete `ok` valía `true`, es decir, un fallo de negocio de Sabre pasaba por reserva
 * confirmada. Cada uno vive aquí para que no vuelva.
 */
describe('classifySabreEnvelope — los siete bypasses de la regla dura', () => {
  it('1. errors[] a profundidad ≥ 4 no se escapa del recorrido', () => {
    const verdict = classifySabreEnvelope({
      a: {
        b: { c: { d: { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] } } },
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.type).toBe('UNABLE_TO_CREATE');
  });

  it('2. errors[] dentro de un elemento de array cuenta igual', () => {
    const verdict = classifySabreEnvelope({
      orders: [
        { confirmationId: 'ABC123' },
        { errors: [{ category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' }] },
      ],
    });
    expect(verdict.ok).toBe(false);
  });

  it('3. ApplicationResults dentro de un array cuenta igual', () => {
    const verdict = classifySabreEnvelope({
      results: [{ ApplicationResults: { status: 'NotProcessed', Error: [{ type: 'Transport' }] } }],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((i) => i.category === SABRE_ISSUE_NOT_PROCESSED)).toBe(true);
  });

  it('4. errors: ["texto plano"] — un errors POBLADO jamás es éxito', () => {
    const verdict = classifySabreEnvelope({ errors: ['Booking failed: no seats available'] });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    // El texto libre puede arrastrar PII del pasajero: se reporta el problema, no su contenido.
    expect(JSON.stringify(verdict)).not.toContain('no seats');
  });

  it('4-bis. errors: [1] y errors: [true] tampoco son éxito', () => {
    expect(classifySabreEnvelope({ errors: [1] }).ok).toBe(false);
    expect(classifySabreEnvelope({ errors: [true] }).ok).toBe(false);
  });

  it('5. errors como OBJETO (la forma de los carriles derivados de XML/SOAP)', () => {
    const verdict = classifySabreEnvelope({
      errors: { category: 'APPLICATION_ERROR', type: 'UNABLE_TO_CREATE' },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.type).toBe('UNABLE_TO_CREATE');
  });

  it('5-bis. Fault de SOAP y errors como cadena suelta', () => {
    expect(classifySabreEnvelope({ soapFault: { faultstring: 'x' } }).ok).toBe(false);
    expect(classifySabreEnvelope({ error: 'invalid_grant' }).ok).toBe(false);
  });

  it('6. messages[] sin severity ni type: no se puede demostrar inocuo ⇒ error', () => {
    const verdict = classifySabreEnvelope({
      messages: [{ content: 'Booking could not be completed' }],
    });
    expect(verdict.ok).toBe(false);
  });

  it('6-bis. el prefijo del code de hoteles decide cuando no hay severity', () => {
    expect(classifySabreEnvelope({ messages: [{ code: 'ERR.0161' }] }).ok).toBe(false);
    const warn = classifySabreEnvelope({ Message: [{ code: 'WARN.0788', value: 'x' }] });
    expect(warn.ok).toBe(true);
    expect(warn.warnings).toHaveLength(1);
  });

  it('7. status NotProcessed en la raíz, sin ApplicationResults de por medio', () => {
    const verdict = classifySabreEnvelope({ status: 'NotProcessed', data: {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.category).toBe(SABRE_ISSUE_NOT_PROCESSED);
  });
});

/**
 * `ErrorDetails` / `WarningDetails` NO son claves en ningún contrato: son **valores de `code`**
 * dentro de `Message[]` (`get-hotel-avail-v5.0.yml:163`,
 * `help/get-hotel-avail-v4/v4-errors.txt:12,49`). La entrada que los trataba como claves era
 * código muerto; lo que hace falta es reconocerlos donde de verdad aparecen.
 */
describe('classifySabreEnvelope — ErrorDetails/WarningDetails donde de verdad viven', () => {
  it('reconoce la forma REST oficial de un warning de hoteles', () => {
    const verdict = classifySabreEnvelope({
      GetHotelAvailRS: {
        ApplicationResults: {
          status: 'Complete',
          Success: [{ timeStamp: '2024-05-30T00:17:56.715-05:00' }],
          Warning: [
            {
              type: 'Validation',
              SystemSpecificResults: [
                {
                  Message: [
                    { code: 'WARN.0788', value: 'Invalid format for search by distance' },
                    { code: 'WarningDetails', value: 'Cannot sort by distance' },
                  ],
                },
              ],
            },
          ],
        },
        HotelAvailInfos: { OffSet: 1 },
      },
    });
    // Un warning de hoteles NO tumba la búsqueda: degrada.
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('el mismo sobre con Error/ErrorDetails sí la tumba', () => {
    const verdict = classifySabreEnvelope({
      GetHotelAvailRS: {
        ApplicationResults: {
          status: 'Complete',
          Error: [
            {
              type: 'Validation',
              SystemSpecificResults: [
                {
                  Message: [
                    { code: 'ERR.0161', value: 'Search Criteria Invalid' },
                    { code: 'ErrorDetails', value: 'Invalid property code' },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(verdict.ok).toBe(false);
  });

  it('los Message dentro de Success[] no son problemas: el contrato los declara éxito', () => {
    const verdict = classifySabreEnvelope({
      ApplicationResults: {
        status: 'Complete',
        Success: [{ SystemSpecificResults: [{ Message: [{ value: 'ok' }] }] }],
      },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(0);
  });
});

describe('classifySabreEnvelope — lo que YA funcionaba y no puede romperse', () => {
  it('un 200 con errors[] NO es éxito, y el fieldValue no viaja al issue', () => {
    const verdict = classifySabreEnvelope({
      timestamp: '2026-07-03T07:29:11.347Z',
      errors: [
        {
          category: 'BAD_REQUEST',
          type: 'INVALID_VALUE',
          description: 'Incorrect request data provided.',
          fieldPath: 'fare.programs[0].values',
          fieldValue: '[AAA123], []',
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]?.type).toBe('INVALID_VALUE');
    expect(verdict.failures[0]?.fieldPath).toBe('fare.programs[0].values');
    expect(JSON.stringify(verdict)).not.toContain('AAA123');
    expect(JSON.stringify(verdict)).not.toContain('Incorrect request data');
  });

  it('BFM: messages[].severity === "Error" dentro de groupedItineraryResponse', () => {
    const verdict = classifySabreEnvelope({
      groupedItineraryResponse: {
        version: '5',
        messages: [{ code: 'ERR', severity: 'Error', type: 'DEFAULT' }],
        itineraryGroups: [],
      },
    });
    expect(verdict.ok).toBe(false);
  });

  it('Offer Price NDC: messages[].type === "ERROR"', () => {
    const verdict = classifySabreEnvelope({
      messages: [{ type: 'ERROR', message: 'Offer expired', service: 'OfferPrice' }],
    });
    expect(verdict.ok).toBe(false);
    // Ni el texto del mensaje ni el nombre del servicio salen del proveedor.
    expect(JSON.stringify(verdict)).not.toContain('Offer expired');
  });

  it('hoteles: ApplicationResults.status NotProcessed', () => {
    const verdict = classifySabreEnvelope({
      GetHotelAvailRS: {
        ApplicationResults: { status: 'NotProcessed', Error: [{ type: 'Transport' }] },
      },
    });
    expect(verdict.ok).toBe(false);
  });

  it('un severity Warning no tumba la respuesta', () => {
    const verdict = classifySabreEnvelope({
      groupedItineraryResponse: { messages: [{ code: 'X', severity: 'Warning' }] },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(1);
  });

  it('detecta el entitlement parcial de un 200 aparentemente bueno', () => {
    const verdict = classifySabreEnvelope({
      warnings: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
      itineraries: [],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.partialUnauthorized).toHaveLength(1);
  });

  it('un UNAUTHORIZED de severidad error sigue siendo error y sigue marcándose parcial', () => {
    const verdict = classifySabreEnvelope({
      errors: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.partialUnauthorized).toHaveLength(1);
  });

  it('una respuesta limpia es éxito', () => {
    const verdict = classifySabreEnvelope({ groupedItineraryResponse: { version: '5' } });
    expect(verdict.ok).toBe(true);
    expect(verdict.exhaustive).toBe(true);
  });

  /**
   * «El recorrido terminó y no apareció nada con severidad error» sale cierto DE VACÍO tanto para
   * un escalar (`"OK"`, `true`, `42`) como para un contenedor vacío (`{}`, `[]`), y vacuamente
   * cierto no es demostrado benigno. La ronda 3 igualó los dos casos: antes `{}` pasaba como
   * éxito, y un `createBooking` que responde `{}` no ha devuelto la reserva que el contrato
   * promete. El caso real del 204 y el del cuerpo no parseable los corta el cliente HTTP antes de
   * llegar a esta regla.
   */
  it('ni un escalar ni un sobre vacío son un sobre verificable', () => {
    for (const payload of [null, undefined, '', 'OK', 0, false, {}, []]) {
      expect(classifySabreEnvelope(payload).ok).toBe(false);
    }
    // En cuanto hay contenido, el sobre se juzga por su contenido y no por su forma.
    expect(classifySabreEnvelope({ groupedItineraryResponse: { version: '5' } }).ok).toBe(true);
  });

  it('errors/warnings ausentes, vacíos o en cero no inventan fallos', () => {
    for (const payload of [
      { errors: [] },
      { errors: null },
      { warnings: [] },
      { errorCode: null },
      { hasErrors: false },
      { errorCount: 0 },
      { messages: [] },
    ]) {
      expect(classifySabreEnvelope(payload).ok).toBe(true);
    }
  });

  it('el messages[] real de BFM v5, todo severity Info, es éxito', () => {
    const verdict = classifySabreEnvelope({
      groupedItineraryResponse: {
        version: '5',
        messages: [
          {
            severity: 'Info',
            type: 'SERVER',
            code: 'GCA14-ISELL-TN-00-2024-12-01-WL5P',
            text: '27131',
          },
          {
            severity: 'Info',
            type: 'WORKERTHREAD',
            code: 'TRANSACTIONID',
            text: '7346539295149655838',
          },
          { severity: 'Info', type: 'DRE', code: 'RULEID', text: '18411' },
          { severity: 'Info', type: 'DEFAULT', code: 'RULEID', text: '31139' },
        ],
        statistics: { itineraryCount: 1 },
      },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(0);
  });

  /**
   * `errorHandlingPolicy` es campo de REQUEST (`booking-management-v1.yml:352,492,566,698`).
   * Si alguien amplía la lista de claves con un `startsWith('ERROR')`, este test lo caza.
   */
  it('errorHandlingPolicy no es un error: es una política del request', () => {
    expect(classifySabreEnvelope({ errorHandlingPolicy: ['HALT_ON_ERROR'] }).ok).toBe(true);
  });

  /**
   * El guardarraíl contra el falso positivo, que es el modo de fallo que mataría esta regla: si
   * un sobre REAL y bueno empieza a dar error, el equipo desactiva la regla y volvemos al agujero.
   * Ya cazó uno: `type: "DEFAULT"` de BFM contiene la subcadena `"FAULT"`.
   */
  it.each([
    ['adult', adultFixture],
    ['child-baggage', childFixture],
    ['family', familyFixture],
  ])('el fixture oficial de BFM v5 "%s" es éxito, sin un solo issue', (name, fixture) => {
    const verdict = classifySabreEnvelope(fixture);
    expect(verdict.ok, name).toBe(true);
    expect(verdict.failures, name).toHaveLength(0);
    expect(verdict.warnings, name).toHaveLength(0);
    expect(verdict.exhaustive, name).toBe(true);
  });
});

describe('classifySabreEnvelope — coste acotado y carga de la prueba', () => {
  it('un sobre que no se puede recorrer entero NO es éxito', () => {
    // Más nodos que presupuesto: el recorrido se corta y el veredicto lo dice.
    const huge = Array.from({ length: SABRE_ENVELOPE_NODE_BUDGET + 10 }, () => ({ id: 1 }));
    const verdict = classifySabreEnvelope({ itineraries: huge });
    expect(verdict.exhaustive).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.category).toBe(SABRE_ISSUE_NOT_VERIFIABLE);
  });

  it('un anidamiento patológico falla cerrado, no revienta la pila', () => {
    let deep: Record<string, unknown> = { errors: [{ type: 'X' }] };
    for (let i = 0; i < SABRE_ENVELOPE_MAX_DEPTH + 50; i++) deep = { nested: deep };
    const verdict = classifySabreEnvelope(deep);
    expect(verdict.exhaustive).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  it('una referencia circular no cuelga el clasificador', () => {
    const cyclic: Record<string, unknown> = { version: '5' };
    cyclic['self'] = cyclic;
    const verdict = classifySabreEnvelope(cyclic);
    expect(verdict.ok).toBe(true);
    expect(verdict.nodesVisited).toBeLessThan(10);
  });

  it('un sobre grande y limpio se recorre entero y sigue siendo barato', () => {
    const payload = {
      groupedItineraryResponse: {
        version: '5',
        itineraryGroups: Array.from({ length: 200 }, (_, i) => ({
          groupDescription: { legDescriptions: [{ departureDate: '2026-09-01' }] },
          itineraries: [
            { id: i, pricingInformation: [{ fare: { totalFare: { totalPrice: 100 } } }] },
          ],
        })),
      },
    };
    const verdict = classifySabreEnvelope(payload);
    expect(verdict.ok).toBe(true);
    expect(verdict.exhaustive).toBe(true);
    expect(verdict.nodesVisited).toBeLessThan(SABRE_ENVELOPE_NODE_BUDGET);
  });
});

describe('sabreBackoffDelayMs', () => {
  it('nunca baja del suelo de 500 ms que publica Sabre', () => {
    for (let attempt = 1; attempt <= SABRE_MAX_ATTEMPTS; attempt++) {
      expect(sabreBackoffDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(SABRE_MIN_BACKOFF_MS);
    }
  });

  it('crece exponencialmente y admite jitter determinista', () => {
    expect(sabreBackoffDelayMs(1, () => 0)).toBe(500);
    expect(sabreBackoffDelayMs(2, () => 0)).toBe(1000);
    expect(sabreBackoffDelayMs(3, () => 1)).toBe(2250);
  });
});

describe('SabreApiError', () => {
  it('redacta el body en el constructor: ni el mensaje ni la propiedad filtran secretos', () => {
    const raw = JSON.stringify({
      access_token: 'ATK-DEL-CLIENTE',
      password: 'Pa55w0rd!',
      passengers: [{ givenName: 'Ana', passportNumber: 'AB1234567' }],
    });
    const error = new SabreApiError(500, raw, '/v1/trip/orders/getBooking');

    for (const secret of ['ATK-DEL-CLIENTE', 'Pa55w0rd!', 'AB1234567', 'Ana']) {
      expect(error.message).not.toContain(secret);
      expect(error.body).not.toContain(secret);
    }
    expect(error.body).toContain('«REDACTADO»');
  });

  it('toLogMeta no incluye el body', () => {
    const error = new SabreApiError(
      403,
      '{"errorCode":"ERR.2SG.SEC.NOT_AUTHORIZED"}',
      '/v5/offers/shop',
      {
        code: 'ERR.2SG.SEC.NOT_AUTHORIZED',
        conversationId: 'conv-1',
      },
    );
    const meta = error.toLogMeta();
    expect(meta['body']).toBeUndefined();
    expect(meta['kind']).toBe('ENTITLEMENT');
    expect(meta['circuit']).toBe('IGNORE');
    expect(error.retryable).toBe(false);
  });
});
