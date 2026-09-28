import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { TBO_REDACTED } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { InMemoryProviderPayloadsRepository } from './__fixtures__/in-memory-provider-payloads.repository.js';
import { withProviderPayloadScope } from './provider-payload-scope.js';
import {
  loadProviderPayloadsConfig,
  type ProviderPayloadsConfig,
} from './provider-payloads.config.js';
import {
  PROVIDER_PAYLOADS_PURGE_BATCH,
  PROVIDER_PAYLOADS_PURGE_MAX_BATCHES,
  PROVIDER_PAYLOAD_MAX_BODY_BYTES,
  ProviderPayloadExportInputError,
  ProviderPayloadsService,
} from './provider-payloads.service.js';
import { PROVIDER_PAYLOAD_EVENTS, type ProviderPayloadWrite } from './provider-payloads.types.js';

/**
 * La bóveda de payloads por su puerta pública (docs/tbo/09 PR-4.9; D-TBO-31 A; 08 RNF-05).
 *
 * Criterio de salida del PR: nada de la bóveda llega al log; la exportación en live sale
 * redactada; toda lectura emite un evento de auditoría; la purga borra lo vencido. La RLS y el
 * borrado real están en `provider-payloads.integration.test.ts`.
 */

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const OTRO_DUENO = '44444444-4444-4444-8444-444444444444';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CUENTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDEN = '99999999-9999-4999-8999-999999999999';
const OTRA_ORDEN = '88888888-8888-4888-8888-888888888888';
const LECTOR = { userId: '77777777-7777-4777-8777-777777777777', tenantId: CONSOLIDADOR };

// Sintéticos con forma de dato personal, para buscarlos en cualquier salida.
const NOMBRE = 'Xiomara';
const APELLIDO = 'Quintanilla';
const EMAIL = 'xiomara.q@example.test';
const TELEFONO = '+57 300 555 0199';
const PII = [NOMBRE, APELLIDO, EMAIL, TELEFONO];

const BOOK_RQ = JSON.stringify({
  BookingCode: '1120548!TB!1!TB!abc',
  BookingReferenceId: 'STT-0001',
  PaymentMode: 'Limit',
  TotalFare: 340.12,
  EmailId: EMAIL,
  PhoneNumber: TELEFONO,
  CustomerDetails: [{ CustomerNames: [{ FirstName: NOMBRE, LastName: APELLIDO, Type: 'Adult' }] }],
});
const BOOK_RS = JSON.stringify({
  Status: { Code: 500, Description: 'Unexpected Error' },
  BookingDetail: { HotelRoomsDetails: [{ HotelPassenger: [{ FirstName: NOMBRE }] }] },
});

function clave(): string {
  return randomBytes(32).toString('base64');
}

function config(
  env: Record<string, string> = { PROVIDER_PAYLOADS_KEY: clave() },
): ProviderPayloadsConfig {
  return loadProviderPayloadsConfig(env);
}

function escritura(overrides: Partial<ProviderPayloadWrite> = {}): ProviderPayloadWrite {
  return {
    providerCode: 'tbo-hotels',
    requestId: '0b8f2f7e-6a55-4c38-9d8e-6d1f0f5f1a01',
    attempt: 1,
    operation: 'book',
    environment: 'live',
    ownerTenantId: CONSOLIDADOR,
    providerAccountId: CUENTA,
    accountRef: '0123456789abcdef',
    sentAt: new Date('2026-09-25T12:00:00.000Z'),
    durationMs: 1_234,
    httpStatus: 500,
    providerStatusCode: 500,
    outcome: 'UPSTREAM',
    requestBody: BOOK_RQ,
    responseBody: BOOK_RS,
    ...overrides,
  };
}

interface Montaje {
  readonly service: ProviderPayloadsService;
  readonly repo: InMemoryProviderPayloadsRepository;
  readonly audit: RecordingAuditService;
}

function montar(
  cfg: ProviderPayloadsConfig = config(),
  repo = new InMemoryProviderPayloadsRepository(),
): Montaje {
  const audit = new RecordingAuditService();
  return { service: new ProviderPayloadsService(repo, cfg, audit.asService()), repo, audit };
}

/** Todo lo que se entregó al logger de Nest, en un solo texto. */
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

describe('ProviderPayloadsService.record', () => {
  it('apagada: no escribe, y `enabled` se lo dice al factory para que ni conecte el ACL', async () => {
    const { service, repo } = montar(config({}));

    await service.record(escritura());

    expect(service.enabled).toBe(false);
    expect(repo.rows).toEqual([]);
    expect(logs()).toContain('PROVIDER_PAYLOADS_KEY no configurada');
  });

  it('cifra RQ y RS: en la fila no queda ningún dato del huésped, sólo metadatos operativos', async () => {
    const cfg = config({ PROVIDER_PAYLOADS_KEY: clave(), PROVIDER_PAYLOADS_RETENTION_DAYS: '14' });
    const { service, repo } = montar(cfg);

    await service.record(escritura());

    expect(service.enabled).toBe(true);
    expect(repo.rows).toHaveLength(1);
    const fila = repo.rows[0]!;
    expect(fila).toMatchObject({
      providerCode: 'tbo-hotels',
      requestId: '0b8f2f7e-6a55-4c38-9d8e-6d1f0f5f1a01',
      attempt: 1,
      operation: 'book',
      environment: 'live',
      ownerTenantId: CONSOLIDADOR,
      providerAccountId: CUENTA,
      accountRef: '0123456789abcdef',
      tenantId: null,
      orderId: null,
      durationMs: 1_234,
      httpStatus: 500,
      providerStatusCode: 500,
      outcome: 'UPSTREAM',
      keyId: cfg.keyring?.current.id,
      requestBytes: Buffer.byteLength(BOOK_RQ),
      responseBytes: Buffer.byteLength(BOOK_RS),
      retentionDays: 14,
    });
    expect(fila.requestEnc).toBeInstanceOf(Buffer);
    expect(fila.responseEnc).toBeInstanceOf(Buffer);
    const bytes = [fila.requestEnc, fila.responseEnc].map((b) => b?.toString('latin1')).join('');
    for (const dato of [...PII, 'BookingCode', 'TotalFare']) expect(bytes).not.toContain(dato);
  });

  it('la orden y el tenant salen del contexto en que corrió la llamada', async () => {
    const { service, repo } = montar();

    await requestContextStorage.run({ tenantId: AGENCIA, userId: LECTOR.userId }, async () => {
      await service.record(escritura({ attempt: 1 }));
      await withProviderPayloadScope({ orderId: ORDEN }, () =>
        service.record(escritura({ attempt: 2 })),
      );
      await withProviderPayloadScope({ tenantId: OTRO_DUENO }, () =>
        withProviderPayloadScope({ orderId: OTRA_ORDEN }, () =>
          service.record(escritura({ attempt: 3 })),
        ),
      );
    });
    await withProviderPayloadScope({ orderId: 'no-es-un-uuid', tenantId: 'tampoco' }, () =>
      service.record(escritura({ attempt: 4 })),
    );

    expect(repo.rows.map((r) => [r.attempt, r.tenantId, r.orderId])).toEqual([
      [1, AGENCIA, null],
      [2, AGENCIA, ORDEN],
      // El alcance anidado hereda el tenant del de afuera.
      [3, OTRO_DUENO, OTRA_ORDEN],
      // Un id que la base rechazaría no tumba la evidencia: se guarda sin él.
      [4, null, null],
    ]);
  });

  it('un cuerpo por encima del tope se guarda sin cuerpo pero con su tamaño, y lo avisa', async () => {
    const { service, repo } = montar();
    const enorme = 'x'.repeat(PROVIDER_PAYLOAD_MAX_BODY_BYTES + 1);

    await service.record(
      escritura({ operation: 'search', responseBody: enorme, requestBody: undefined }),
    );

    expect(repo.rows[0]).toMatchObject({
      requestBytes: null,
      requestEnc: null,
      responseBytes: PROVIDER_PAYLOAD_MAX_BODY_BYTES + 1,
      responseEnc: null,
    });
    expect(logs()).toContain(`response de ${PROVIDER_PAYLOAD_MAX_BODY_BYTES + 1} bytes`);
  });

  it('un registro mal formado no se guarda, y el aviso nombra campos sin repetir valores', async () => {
    const { service, repo } = montar();

    await service.record(
      escritura({ requestId: `${NOMBRE} ${APELLIDO}`, environment: 'produccion' as 'live' }),
    );

    expect(repo.rows).toEqual([]);
    expect(logs()).toContain('requestId:invalid_string');
    expect(logs()).toContain('environment:invalid_enum_value');
    expect(logs()).not.toContain('produccion');
    for (const dato of PII) expect(logs()).not.toContain(dato);
  });

  it('una duración negativa (el reloj retrocedió) se guarda como 0 en vez de perder la evidencia', async () => {
    const { service, repo } = montar();

    await service.record(escritura({ durationMs: -12.4 }));

    expect(repo.rows.map((r) => r.durationMs)).toEqual([0]);
  });

  it('el dueño se guarda en minúsculas, como lo devuelve Postgres, y se sigue pudiendo abrir', async () => {
    const { service, repo } = montar();
    await service.record(
      escritura({ ownerTenantId: CONSOLIDADOR.toUpperCase(), environment: 'test' }),
    );

    const [entrada] = (await service.exportByRequestId(escritura().requestId, LECTOR)).entries;

    expect(repo.rows[0]?.ownerTenantId).toBe(CONSOLIDADOR);
    expect(entrada?.request).toEqual({ kind: 'json', value: JSON.parse(BOOK_RQ) as unknown });
  });

  it('un fallo de la base no llega al ACL: resuelve igual, y el aviso lleva el SQLSTATE y no el mensaje', async () => {
    const repo = new InMemoryProviderPayloadsRepository();
    repo.insertError = Object.assign(new Error(`duplicate key: ${NOMBRE}`), {
      code: '23505',
      detail: `Key (request_id)=(${APELLIDO}) already exists.`,
    });
    const { service } = montar(config(), repo);

    await expect(service.record(escritura())).resolves.toBeUndefined();
    expect(logs()).toContain('sqlstate 23505');
    for (const dato of PII) expect(logs()).not.toContain(dato);
  });
});

describe('ProviderPayloadsService — exportación', () => {
  it('live: sale redactado, y la lectura queda auditada para el dueño de la cuenta sin datos personales', async () => {
    const { service, repo } = montar();
    await service.record(escritura());

    const out = await service.exportByRequestId(escritura().requestId, LECTOR);

    expect(out.lookup).toEqual({ kind: 'request', requestId: escritura().requestId });
    expect(out.entries).toHaveLength(1);
    const [entrada] = out.entries;
    expect(entrada).toMatchObject({
      providerCode: 'tbo-hotels',
      operation: 'book',
      environment: 'live',
      sentAt: '2026-09-25T12:00:00.000Z',
      httpStatus: 500,
      providerStatusCode: 500,
      outcome: 'UPSTREAM',
      redacted: true,
      request: {
        kind: 'json',
        value: {
          BookingReferenceId: 'STT-0001',
          PaymentMode: 'Limit',
          EmailId: TBO_REDACTED,
          PhoneNumber: TBO_REDACTED,
          CustomerDetails: [
            { CustomerNames: [{ FirstName: TBO_REDACTED, LastName: TBO_REDACTED, Type: 'Adult' }] },
          ],
        },
      },
      response: {
        kind: 'json',
        value: {
          Status: { Code: 500, Description: 'Unexpected Error' },
          BookingDetail: { HotelRoomsDetails: [{ HotelPassenger: [{ FirstName: TBO_REDACTED }] }] },
        },
      },
    });
    for (const dato of PII) expect(JSON.stringify(out)).not.toContain(dato);

    expect(repo.readers).toEqual([LECTOR]);
    expect(repo.audits).toEqual([
      {
        eventType: PROVIDER_PAYLOAD_EVENTS.exported,
        tenantId: CONSOLIDADOR,
        actorUserId: LECTOR.userId,
        aggregateType: 'provider_payload',
        aggregateId: escritura().requestId,
        payload: {
          lookup: 'request',
          requestId: escritura().requestId,
          records: 1,
          providers: ['tbo-hotels'],
          environments: ['live'],
          revealed: false,
        },
      },
    ]);
  });

  it('test: sale tal cual, porque los datos son sintéticos y el proveedor necesita verlos (D-TBO-31 A)', async () => {
    const { service } = montar();
    await service.record(escritura({ environment: 'test' }));

    const [entrada] = (await service.exportByRequestId(escritura().requestId, LECTOR)).entries;

    expect(entrada?.redacted).toBe(false);
    expect(entrada?.request).toEqual({ kind: 'json', value: JSON.parse(BOOK_RQ) as unknown });
    expect(entrada?.response).toEqual({ kind: 'json', value: JSON.parse(BOOK_RS) as unknown });
  });

  it('live con ticket del proveedor: sin redactar, y el ticket queda en el rastro', async () => {
    const { service, repo } = montar();
    await service.record(escritura());

    const out = await service.exportByRequestId(escritura().requestId, LECTOR, {
      reveal: { supportTicket: 'TBO-4521' },
    });

    expect(out.entries[0]).toMatchObject({
      redacted: false,
      request: { kind: 'json', value: JSON.parse(BOOK_RQ) as unknown },
    });
    expect(repo.audits[0]?.payload).toMatchObject({ supportTicket: 'TBO-4521', revealed: true });
  });

  it('por orden: todo lo que corrió en su alcance, en orden, y nada de otra orden', async () => {
    const { service, repo } = montar();
    await withProviderPayloadScope({ orderId: ORDEN }, async () => {
      await service.record(
        escritura({ requestId: 'pre-1', operation: 'prebook', environment: 'test' }),
      );
      await service.record(escritura({ requestId: 'book-1', environment: 'test' }));
    });
    await withProviderPayloadScope({ orderId: OTRA_ORDEN }, () =>
      service.record(escritura({ requestId: 'book-2', environment: 'test' })),
    );

    const out = await service.exportByOrderId(ORDEN, LECTOR, { providerCode: 'tbo-hotels' });

    expect(out.lookup).toEqual({ kind: 'order', orderId: ORDEN, providerCode: 'tbo-hotels' });
    expect(out.entries.map((e) => [e.requestId, e.operation, e.orderId])).toEqual([
      ['pre-1', 'prebook', ORDEN],
      ['book-1', 'book', ORDEN],
    ]);
    expect(repo.audits[0]).toMatchObject({
      aggregateId: ORDEN,
      payload: { lookup: 'order', orderId: ORDEN, providerCode: 'tbo-hotels', records: 2 },
    });
  });

  it('un evento por dueño de cuenta, cada uno con lo suyo', async () => {
    const { service, repo } = montar();
    await withProviderPayloadScope({ orderId: ORDEN }, async () => {
      await service.record(escritura({ requestId: 'a' }));
      await service.record(
        escritura({ requestId: 'b', ownerTenantId: OTRO_DUENO, environment: 'test' }),
      );
    });

    await service.exportByOrderId(ORDEN, LECTOR);

    expect(
      repo.audits.map((e) => [e.tenantId, e.payload?.['records'], e.payload?.['environments']]),
    ).toEqual([
      [CONSOLIDADOR, 1, ['live']],
      [OTRO_DUENO, 1, ['test']],
    ]);
  });

  it('una lectura que no encuentra nada también se audita, con el tenant activo del lector', async () => {
    const { service, repo } = montar();

    const out = await service.exportByRequestId('no-existe', LECTOR);

    expect(out.entries).toEqual([]);
    expect(repo.audits).toEqual([
      expect.objectContaining({
        eventType: PROVIDER_PAYLOAD_EVENTS.exported,
        tenantId: CONSOLIDADOR,
        payload: { lookup: 'request', requestId: 'no-existe', records: 0, revealed: false },
      }),
    ]);
  });

  it('si el evento de auditoría no entra, la exportación falla y no devuelve nada', async () => {
    const repo = new InMemoryProviderPayloadsRepository();
    const { service } = montar(config(), repo);
    await service.record(escritura());
    repo.auditError = new Error('domain_events no disponible');

    await expect(service.exportByRequestId(escritura().requestId, LECTOR)).rejects.toThrow(
      'domain_events no disponible',
    );
    expect(repo.audits).toEqual([]);
  });

  it('un pedido mal formado es un 400 que nombra el campo sin repetir el valor', async () => {
    const { service, repo } = montar();

    const errores = await Promise.all([
      service.exportByRequestId(`${NOMBRE} ${APELLIDO}`, LECTOR).catch((e: unknown) => e),
      service.exportByOrderId('no-es-uuid', LECTOR).catch((e: unknown) => e),
      service
        .exportByRequestId('ok', LECTOR, { providerCode: 'TBO Hotels' })
        .catch((e: unknown) => e),
      service
        .exportByRequestId('ok', LECTOR, { reveal: { supportTicket: `${NOMBRE} pidió` } })
        .catch((e: unknown) => e),
    ]);

    expect(errores.map((e) => (e as ProviderPayloadExportInputError).fields)).toEqual([
      ['requestId'],
      ['orderId'],
      ['providerCode'],
      ['reveal.supportTicket'],
    ]);
    for (const e of errores) {
      expect(e).toBeInstanceOf(ProviderPayloadExportInputError);
      expect((e as Error).message).not.toContain(NOMBRE);
    }
    // Rechazado antes de leer: tampoco hay lectura que auditar.
    expect(repo.audits).toEqual([]);
  });

  it('con la bóveda apagada, lo ya guardado se lista con los cuerpos retenidos hasta que venza', async () => {
    const repo = new InMemoryProviderPayloadsRepository();
    await montar(config(), repo).service.record(escritura({ environment: 'test' }));
    const apagada = montar(config({}), repo).service;

    const [entrada] = (await apagada.exportByRequestId(escritura().requestId, LECTOR)).entries;

    expect(entrada?.request).toEqual({
      kind: 'withheld',
      reason: 'undecryptable',
      bytes: Buffer.byteLength(BOOK_RQ),
    });
  });

  it('una fila adulterada en la base (live pasada a test, u otro dueño) sale retenida, no en claro', async () => {
    const { service, repo } = montar();
    await service.record(escritura());
    await service.record(escritura({ requestId: 'ajena' }));
    // Lo que haría quien escribe en la base sin la clave: cambiar las columnas que deciden cómo
    // sale la fila (si se redacta) y quién la lee (la RLS mira `owner_tenant_id`).
    repo.rows[0] = { ...repo.rows[0]!, environment: 'test' };
    repo.rows[1] = { ...repo.rows[1]!, ownerTenantId: OTRO_DUENO };

    const [comoTest] = (await service.exportByRequestId(escritura().requestId, LECTOR)).entries;
    const [deOtro] = (await service.exportByRequestId('ajena', LECTOR)).entries;

    for (const entrada of [comoTest, deOtro]) {
      expect(entrada?.request).toEqual({
        kind: 'withheld',
        reason: 'undecryptable',
        bytes: Buffer.byteLength(BOOK_RQ),
      });
      expect(entrada?.response).toMatchObject({ kind: 'withheld', reason: 'undecryptable' });
    }
    for (const dato of PII) expect(JSON.stringify([comoTest, deOtro])).not.toContain(dato);
  });

  it('rotar la clave no pierde lo guardado mientras la anterior siga en PROVIDER_PAYLOADS_KEY_PREVIOUS', async () => {
    const repo = new InMemoryProviderPayloadsRepository();
    const vieja = clave();
    await montar(config({ PROVIDER_PAYLOADS_KEY: vieja }), repo).service.record(
      escritura({ environment: 'test' }),
    );
    const rotada = montar(
      config({ PROVIDER_PAYLOADS_KEY: clave(), PROVIDER_PAYLOADS_KEY_PREVIOUS: vieja }),
      repo,
    ).service;

    const [entrada] = (await rotada.exportByRequestId(escritura().requestId, LECTOR)).entries;

    expect(entrada?.request).toEqual({ kind: 'json', value: JSON.parse(BOOK_RQ) as unknown });
  });
});

describe('ProviderPayloadsService.purgeExpired', () => {
  it('borra por lotes hasta que uno sale corto, y deja un evento con el total', async () => {
    const { service, repo, audit } = montar();
    repo.purgeResults.push(PROVIDER_PAYLOADS_PURGE_BATCH, PROVIDER_PAYLOADS_PURGE_BATCH, 7);

    const total = await service.purgeExpired();

    expect(total).toBe(2 * PROVIDER_PAYLOADS_PURGE_BATCH + 7);
    expect(repo.purgeLimits).toEqual([
      PROVIDER_PAYLOADS_PURGE_BATCH,
      PROVIDER_PAYLOADS_PURGE_BATCH,
      PROVIDER_PAYLOADS_PURGE_BATCH,
    ]);
    expect(audit.events).toEqual([
      {
        eventType: PROVIDER_PAYLOAD_EVENTS.purged,
        tenantId: null,
        actorUserId: null,
        aggregateType: 'provider_payload',
        payload: { purged: total, complete: true },
      },
    ]);
  });

  it('sin nada vencido no deja evento', async () => {
    const { service, audit } = montar();

    expect(await service.purgeExpired()).toBe(0);
    expect(audit.events).toEqual([]);
  });

  it('corre aunque la bóveda esté apagada: lo guardado con una clave retirada también vence', async () => {
    const { service, repo } = montar(config({}));
    repo.purgeResults.push(3);

    expect(await service.purgeExpired()).toBe(3);
  });

  it('corta a los 100 lotes y dice que quedan más para la próxima corrida', async () => {
    const { service, repo, audit } = montar();
    repo.purgeResults.push(
      ...Array.from(
        { length: PROVIDER_PAYLOADS_PURGE_MAX_BATCHES + 5 },
        () => PROVIDER_PAYLOADS_PURGE_BATCH,
      ),
    );

    const total = await service.purgeExpired();

    expect(repo.purgeLimits).toHaveLength(PROVIDER_PAYLOADS_PURGE_MAX_BATCHES);
    expect(total).toBe(PROVIDER_PAYLOADS_PURGE_MAX_BATCHES * PROVIDER_PAYLOADS_PURGE_BATCH);
    expect(audit.events[0]?.payload).toEqual({ purged: total, complete: false });
    expect(logs()).toContain('quedan más');
  });
});

describe('ProviderPayloadsService — nada de la bóveda llega al log (RNF-05)', () => {
  it('escribir, exportar (redactado y sin redactar), fallar y purgar no deja cuerpos en el log', async () => {
    const repo = new InMemoryProviderPayloadsRepository();
    const { service } = montar(config(), repo);

    await withProviderPayloadScope({ orderId: ORDEN }, async () => {
      await service.record(escritura());
      await service.record(escritura({ requestId: 'test-1', environment: 'test' }));
      await service.record(
        escritura({
          requestId: 'grande',
          responseBody: `${NOMBRE}${'x'.repeat(PROVIDER_PAYLOAD_MAX_BODY_BYTES)}`,
        }),
      );
    });
    await service.exportByOrderId(ORDEN, LECTOR);
    await service.exportByOrderId(ORDEN, LECTOR, { reveal: { supportTicket: 'TBO-1' } });
    repo.insertError = Object.assign(new Error(`${NOMBRE} ${EMAIL}`), { detail: BOOK_RQ });
    await service.record(escritura({ requestId: 'falla' }));
    repo.purgeResults.push(2);
    await service.purgeExpired();

    const salida = logs();
    // Hubo líneas de log: si no, la aserción de abajo no probaría nada.
    expect(salida).toContain('exportación de payloads por orden');
    expect(salida).toContain('purga de la bóveda de payloads');
    for (const prohibido of [
      ...PII,
      'BookingCode',
      'CustomerDetails',
      'TotalFare',
      'Unexpected Error',
    ]) {
      expect(salida).not.toContain(prohibido);
    }
  });
});
