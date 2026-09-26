import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { HotelSearchCriteria } from '@sales-travel/canonical';
import type { TboFetch, TboPayloadRecord } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import { InMemoryProviderPayloadsRepository } from '../provider-payloads/__fixtures__/in-memory-provider-payloads.repository.js';
import { withProviderPayloadScope } from '../provider-payloads/provider-payload-scope.js';
import { loadProviderPayloadsConfig } from '../provider-payloads/provider-payloads.config.js';
import { ProviderPayloadsService } from '../provider-payloads/provider-payloads.service.js';
import type { ProviderPayloadWriter } from '../provider-payloads/provider-payloads.types.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';
import {
  TBO_ALWAYS_VAULTED_OPERATIONS,
  shouldVaultTboPayload,
  toProviderPayloadWrite,
} from './tbo-payload-vault.js';

/**
 * El ACL de TBO escribiendo en la bóveda de payloads (docs/tbo/09 PR-4.9; 01 §11.2; D-TBO-31 A):
 * qué se guarda, con qué dueño y con qué orden, y que nada de lo guardado aparece en el log.
 */

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CUENTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDEN = '99999999-9999-4999-8999-999999999999';

// Sintéticos con forma de dato personal y de credencial, para buscarlos en el log.
const NOMBRE = 'Xiomara';
const APELLIDO = 'Quintanilla';
const USUARIO = 'consolidador-demo';
const CONTRASENA = 'Pa55-w0rd-tbo';

const CRITERIO: HotelSearchCriteria = {
  hotelIds: ['1120548', '1120549'],
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  currency: 'USD',
  guestNationality: 'CO',
};

function registro(overrides: Partial<TboPayloadRecord> = {}): TboPayloadRecord {
  return {
    requestId: 'req-1',
    operation: 'book',
    path: '/Book',
    method: 'POST',
    attempt: 1,
    accountRef: '0123456789abcdef',
    environment: 'test',
    sentAt: '2026-09-25T12:00:00.000Z',
    durationMs: 812,
    requestBody: '{"PaymentMode":"Limit"}',
    responseStatus: 200,
    responseBody: '{"Status":{"Code":500}}',
    tboCode: 500,
    outcome: 'UPSTREAM',
    ...overrides,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function boveda(): ProviderCredentialsService {
  return {
    resolve: vi.fn((_tenantId: string, providerCode: string) =>
      Promise.resolve({
        id: CUENTA,
        ownerTenantId: CONSOLIDADOR,
        providerCode,
        label: 'default',
        config: { environment: 'test' },
        credentials: { username: USUARIO, password: CONTRASENA },
        inherited: true,
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    ),
    ownerTenantType: vi.fn(() => Promise.resolve('consolidator')),
  } as unknown as ProviderCredentialsService;
}

function montar(responder: () => Response, writer?: ProviderPayloadWriter) {
  const repo = new InMemoryProviderPayloadsRepository();
  const payloads =
    writer ??
    new ProviderPayloadsService(
      repo,
      loadProviderPayloadsConfig({ PROVIDER_PAYLOADS_KEY: randomBytes(32).toString('base64') }),
      new RecordingAuditService().asService(),
    );
  const fetch = vi.fn<TboFetch>(() => Promise.resolve(responder()));
  const factory = new TboHotelsProviderFactory(boveda(), fetch, payloads);
  return { factory, repo, payloads, fetch };
}

/** El ACL escribe la bóveda sin esperarla: se deja correr la cadena de promesas. */
function drenar(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let logs: () => string;

beforeEach(() => {
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
  logs = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldVaultTboPayload', () => {
  it('la reserva y su post-venta se guardan siempre, salgan bien o mal', () => {
    expect([...TBO_ALWAYS_VAULTED_OPERATIONS]).toEqual([
      'prebook',
      'book',
      'bookingDetail',
      'cancel',
      'bookingDetailsByDate',
    ]);
    for (const operation of TBO_ALWAYS_VAULTED_OPERATIONS) {
      expect(shouldVaultTboPayload({ operation, outcome: 'SUCCESS' }), operation).toBe(true);
      expect(shouldVaultTboPayload({ operation, outcome: 'TRANSPORT' }), operation).toBe(true);
    }
  });

  it('búsquedas y estáticos, sólo si fallaron: una búsqueda que respondió no tiene nada que reportar', () => {
    expect({
      searchOk: shouldVaultTboPayload({ operation: 'search', outcome: 'SUCCESS' }),
      searchVacia: shouldVaultTboPayload({ operation: 'search', outcome: 'NO_AVAILABILITY' }),
      search500: shouldVaultTboPayload({ operation: 'search', outcome: 'UPSTREAM' }),
      searchIlegible: shouldVaultTboPayload({ operation: 'search', outcome: 'MALFORMED_RESPONSE' }),
      estaticoOk: shouldVaultTboPayload({ operation: 'hotelDetails', outcome: 'SUCCESS' }),
      estaticoCaido: shouldVaultTboPayload({ operation: 'cityList', outcome: 'TRANSPORT' }),
    }).toEqual({
      searchOk: false,
      searchVacia: false,
      search500: true,
      searchIlegible: true,
      estaticoOk: false,
      estaticoCaido: true,
    });
  });
});

describe('toProviderPayloadWrite', () => {
  it('traduce el registro de TBO al contrato neutral con la cuenta con que se construyó el cliente', () => {
    expect(
      toProviderPayloadWrite(registro(), { accountId: CUENTA, ownerTenantId: CONSOLIDADOR }),
    ).toEqual({
      providerCode: 'tbo-hotels',
      requestId: 'req-1',
      attempt: 1,
      operation: 'book',
      environment: 'test',
      ownerTenantId: CONSOLIDADOR,
      providerAccountId: CUENTA,
      accountRef: '0123456789abcdef',
      sentAt: new Date('2026-09-25T12:00:00.000Z'),
      durationMs: 812,
      httpStatus: 200,
      providerStatusCode: 500,
      outcome: 'UPSTREAM',
      requestBody: '{"PaymentMode":"Limit"}',
      responseBody: '{"Status":{"Code":500}}',
    });
  });

  it('un GET sin cuerpo y una llamada sin respuesta no inventan cuerpos ni códigos', () => {
    const write = toProviderPayloadWrite(
      registro({
        requestBody: undefined,
        responseBody: undefined,
        tboCode: undefined,
        responseStatus: 0,
        outcome: 'TRANSPORT',
      }),
      { accountId: CUENTA, ownerTenantId: CONSOLIDADOR },
    );
    expect(write).not.toHaveProperty('requestBody');
    expect(write).not.toHaveProperty('responseBody');
    expect(write).not.toHaveProperty('providerStatusCode');
    expect(write.httpStatus).toBe(0);
  });
});

describe('TboHotelsProviderFactory con la bóveda de payloads', () => {
  it('un Search que falla queda guardado con su RQ, a nombre del dueño de la cuenta heredada', async () => {
    const { factory, repo } = montar(() => json({ Status: { Code: 400, Description: 'Bad' } }));
    const { adapter } = await factory.resolveForTenant(AGENCIA);

    await requestContextStorage.run({ tenantId: AGENCIA }, () =>
      adapter.searchAvailability(CRITERIO, { tenantId: AGENCIA }).catch(() => undefined),
    );
    await vi.waitFor(() => expect(repo.rows).toHaveLength(1));

    expect(repo.rows[0]).toMatchObject({
      providerCode: 'tbo-hotels',
      operation: 'search',
      environment: 'test',
      ownerTenantId: CONSOLIDADOR,
      providerAccountId: CUENTA,
      tenantId: AGENCIA,
      orderId: null,
      httpStatus: 200,
      providerStatusCode: 400,
      outcome: 'CLIENT_BUG',
    });
    expect(repo.rows[0]?.requestBytes).toBeGreaterThan(0);
    expect(repo.rows[0]?.requestEnc).toBeInstanceOf(Buffer);
  });

  it('un Search que respondió (aunque sin disponibilidad) no se guarda', async () => {
    const { factory, repo, fetch } = montar(() =>
      json({ Status: { Code: 201, Description: 'No Available rooms' } }),
    );
    const { adapter } = await factory.resolveForTenant(AGENCIA);

    await adapter.searchAvailability(CRITERIO, { tenantId: AGENCIA });
    await drenar();

    expect(fetch).toHaveBeenCalled();
    expect(repo.rows).toEqual([]);
  });

  it('una lectura de la reserva dentro del alcance de su orden queda atada a esa orden', async () => {
    const { factory, repo } = montar(() => json({ Status: { Code: 400, Description: 'Bad' } }));
    const { adapter } = await factory.resolveForTenant(AGENCIA);

    await requestContextStorage.run({ tenantId: AGENCIA }, () =>
      withProviderPayloadScope({ orderId: ORDEN }, () =>
        adapter.getBooking('TBO-CONF-1', { tenantId: AGENCIA }).catch(() => undefined),
      ),
    );
    await vi.waitFor(() => expect(repo.rows).toHaveLength(1));

    expect(repo.rows[0]).toMatchObject({
      operation: 'bookingDetail',
      orderId: ORDEN,
      tenantId: AGENCIA,
    });
  });

  it('con la bóveda apagada el factory no la conecta: el ACL ni la llama', async () => {
    const writer = { enabled: false, record: vi.fn(() => Promise.resolve()) };
    const { factory } = montar(() => json({ Status: { Code: 400, Description: 'Bad' } }), writer);
    const { adapter } = await factory.resolveForTenant(AGENCIA);

    await adapter.getBooking('TBO-CONF-1', { tenantId: AGENCIA }).catch(() => undefined);
    await drenar();

    expect(writer.record).not.toHaveBeenCalled();
  });

  it('lo que va a la bóveda no llega al log: ni cuerpos, ni nombres, ni la credencial', async () => {
    const { factory, repo } = montar(() =>
      json({
        Status: { Code: 200, Description: 'Successful' },
        BookingDetail: {
          HotelRoomsDetails: [{ HotelPassenger: [{ FirstName: NOMBRE, LastName: APELLIDO }] }],
        },
      }),
    );
    const { adapter } = await factory.resolveForTenant(AGENCIA);

    await adapter.getBooking('TBO-CONF-1', { tenantId: AGENCIA }).catch(() => undefined);
    await vi.waitFor(() => expect(repo.rows).toHaveLength(1));

    // Sí se guardó la respuesta entera, cifrada…
    expect(repo.rows[0]?.responseBytes).toBeGreaterThan(0);
    // …y el log sólo tiene metadatos: hubo líneas, pero ningún cuerpo.
    const salida = logs();
    expect(salida).toContain('tbo.http');
    for (const prohibido of [NOMBRE, APELLIDO, USUARIO, CONTRASENA, 'Successful']) {
      expect(salida).not.toContain(prohibido);
    }
  });
});
