import { NotFoundException } from '@nestjs/common';
import { DespegarCancelNotAllowedError } from '@sales-travel/despegar-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type {
  ProviderPayloadWrite,
  ProviderPayloadWriter,
} from '../provider-payloads/provider-payloads.types.js';
import {
  supportsHotelBookingContext,
  supportsHotelBookingsByDate,
} from '../providers/hotel-provider.types.js';
import { ProviderAccountIncompleteError } from '../providers/provider.types.js';
import { DespegarContextHotelProviderAdapter } from './despegar-hotel-context.adapter.js';
import {
  DespegarHotelsProviderFactory,
  despegarEnvironmentOf,
  shouldVaultDespegarPayload,
} from './despegar-hotels.factory.js';

/*
 * Lo que el factory de Despegar suma para reservar por órdenes: el adapter con contexto sólo con
 * una cuenta de la bóveda, el entorno de la cuenta, sus datos de facturación, la post-venta con la
 * cuenta de la orden, la conciliación por cuenta y la bóveda de payloads.
 */

function resolved(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: 'owner-1',
    providerCode: 'despegar-hotels',
    label: 'default',
    config: { baseUrl: 'https://api-dev.despegar.com/v3', language: 'ES', countryCode: 'CO' },
    credentials: { apiKey: 'k' },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function factoryCon(
  creds: Record<string, unknown>,
  writer?: ProviderPayloadWriter,
): DespegarHotelsProviderFactory {
  return new DespegarHotelsProviderFactory(creds as unknown as ProviderCredentialsService, writer);
}

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response),
    ),
  );
}

beforeEach(() => {
  vi.stubEnv('DESPEGAR_API_KEY', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cuenta de la bóveda vs clave de plataforma', () => {
  it('con cuenta de la bóveda reserva por órdenes; con la clave de plataforma, no', async () => {
    vi.stubEnv('DESPEGAR_API_KEY', 'plataforma');
    let mode: 'byoc' | 'env' = 'byoc';
    const factory = factoryCon({
      resolve: () =>
        mode === 'env'
          ? Promise.reject(new NotFoundException('none'))
          : Promise.resolve(resolved()),
    });

    const { adapter: conCuenta } = await factory.resolveForTenant('t1');
    expect(conCuenta).toBeInstanceOf(DespegarContextHotelProviderAdapter);
    expect(supportsHotelBookingContext(conCuenta)).toBe(true);
    expect((conCuenta as DespegarContextHotelProviderAdapter).searchAccount).toEqual({
      accountId: 'acc-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    mode = 'env';
    const { adapter: plataforma, credentialSource } = await factory.resolveForTenant('t2');
    expect(credentialSource).toBe('env');
    expect(supportsHotelBookingContext(plataforma)).toBe(false);
    // La misma instancia para todos los tenants que caen a la plataforma.
    expect((await factory.resolveForTenant('t3')).adapter).toBe(plataforma);
  });

  it.each([
    ['https://api.despegar.com/v3', 'live'],
    ['https://api-dev.despegar.com/v3', 'test'],
    ['https://apis-uat.despegar.com/v3', 'test'],
    ['no es una url', 'test'],
  ])('el entorno de %s es %s', (baseUrl, entorno) => {
    expect(despegarEnvironmentOf(baseUrl)).toBe(entorno);
  });

  it('la cuenta declara su entorno para que la web avise las de prueba', async () => {
    const factory = factoryCon({
      resolve: () =>
        Promise.resolve(resolved({ config: { baseUrl: 'https://api.despegar.com/v3' } })),
    });
    const { adapter } = await factory.resolveForTenant('t1');
    expect((adapter as { accountEnvironment?: string }).accountEnvironment).toBe('live');
  });

  it('los datos de facturación salen del blob cifrado, o de config; inválidos no se usan', async () => {
    const invoice = {
      fiscalStatus: 'PERSONA_JURIDICA',
      fiscalIdentification: { type: 'NIT', number: '900123456' },
    };
    const opciones = async (
      credentials: Record<string, unknown>,
      config: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const factory = factoryCon({
        resolve: () =>
          Promise.resolve(resolved({ credentials: { apiKey: 'k', ...credentials }, config })),
      });
      const { adapter } = await factory.resolveForTenant('t1');
      return (adapter as unknown as { options: Record<string, unknown> }).options;
    };

    expect((await opciones({ invoice }, {}))['invoice']).toEqual(invoice);
    expect((await opciones({}, { invoice }))['invoice']).toEqual(invoice);
    expect(await opciones({ invoice: { fiscalStatus: '' } }, {})).not.toHaveProperty('invoice');
    expect((await opciones({}, { paymentType: 'DEFERRED' }))['paymentType']).toBe('DEFERRED');
    expect(await opciones({}, { paymentType: 'CASH' })).not.toHaveProperty('paymentType');
  });
});

describe('factura cargada desde el panel (claves planas)', () => {
  async function invoiceDe(credentials: Record<string, unknown>): Promise<unknown> {
    const factory = factoryCon({
      resolve: () => Promise.resolve(resolved({ credentials: { apiKey: 'k', ...credentials } })),
    });
    const { adapter } = await factory.resolveForTenant('t1');
    return (adapter as unknown as { options: Record<string, unknown> }).options['invoice'];
  }

  it('arma la factura con dirección', async () => {
    expect(
      await invoiceDe({
        invoiceFiscalStatus: 'PERSONA_JURIDICA',
        invoiceIdType: 'NIT',
        invoiceIdNumber: ' 900123456 ',
        invoiceFiscalName: 'Agencia SAS',
        invoiceCityId: '2345',
        invoiceStreet: 'Calle 93',
        invoiceStreetNumber: '12',
        invoiceZipCode: '110221',
      }),
    ).toEqual({
      fiscalStatus: 'PERSONA_JURIDICA',
      fiscalIdentification: { type: 'NIT', number: '900123456' },
      fiscalName: 'Agencia SAS',
      fiscalAddress: { street: 'Calle 93', number: '12', cityId: '2345', zipCode: '110221' },
    });
  });

  it('sin dirección no inventa una; sin documento no hay factura', async () => {
    expect(
      await invoiceDe({
        invoiceFiscalStatus: 'PERSONA_FISICA',
        invoiceIdType: 'CC',
        invoiceIdNumber: '1',
      }),
    ).toEqual({
      fiscalStatus: 'PERSONA_FISICA',
      fiscalIdentification: { type: 'CC', number: '1' },
    });
    expect(await invoiceDe({ invoiceFiscalStatus: 'PERSONA_FISICA' })).toBeUndefined();
    expect(await invoiceDe({ invoiceIdType: '  ' })).toBeUndefined();
  });
});

describe('post-venta por orden y conciliación por cuenta', () => {
  it('la orden sale con la cuenta que la creó', async () => {
    const resolveForOrder = vi.fn(() => Promise.resolve(resolved({ inherited: true })));
    const { adapter, credentialSource } = await factoryCon({ resolveForOrder }).resolveForOrder(
      't1',
      'o1',
    );
    expect(resolveForOrder).toHaveBeenCalledWith('t1', 'o1');
    expect(credentialSource).toBe('inherited');
    expect(adapter).toBeInstanceOf(DespegarContextHotelProviderAdapter);
  });

  it('una orden de otro proveedor no se resuelve aquí', async () => {
    const resolveForOrder = vi.fn(() => Promise.resolve(resolved({ providerCode: 'tbo-hotels' })));
    await expect(
      factoryCon({ resolveForOrder }).resolveForOrder('t1', 'o1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la conciliación resuelve UNA cuenta propia del dueño', async () => {
    const resolveOwnAccount = vi.fn(() => Promise.resolve(resolved()));
    const { adapter, credentialSource } = await factoryCon({
      resolveOwnAccount,
    }).resolveForAccount('owner-1', 'acc-1');
    expect(resolveOwnAccount).toHaveBeenCalledWith('owner-1', 'acc-1', 'despegar-hotels');
    expect(credentialSource).toBe('own');
    expect(supportsHotelBookingsByDate(adapter)).toBe(true);
  });

  it('una cuenta sin clave no se construye: falta el campo', async () => {
    const resolveForOrder = vi.fn(() => Promise.resolve(resolved({ credentials: {} })));
    await expect(
      factoryCon({ resolveForOrder }).resolveForOrder('t1', 'o1'),
    ).rejects.toBeInstanceOf(ProviderAccountIncompleteError);
  });
});

describe('bóveda de payloads', () => {
  function conBoveda(enabled = true) {
    const record = vi.fn((_w: ProviderPayloadWrite) => Promise.resolve());
    const factory = factoryCon({ resolve: () => Promise.resolve(resolved()) }, { enabled, record });
    return { factory, record };
  }

  const BUSQUEDA = {
    checkinDate: '2026-12-10',
    checkoutDate: '2026-12-12',
    currency: 'USD',
    hotelIds: ['1'],
    rooms: [{ adults: 2, childrenAges: [] }],
  };

  it('guarda la venta y la post-venta con su cuenta y su dueño', async () => {
    stubFetch(200, { reservationId: 'R-1', status: 'SUCCESS', products: [] });
    const { factory, record } = conBoveda();
    await (await factory.forTenant('t1')).getReservation('R-1');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      providerCode: 'despegar-hotels',
      operation: 'bookStatus',
      environment: 'test',
      ownerTenantId: 'owner-1',
      providerAccountId: 'acc-1',
      httpStatus: 200,
      outcome: 'SUCCESS',
    });
    expect(record.mock.calls[0]?.[0].responseBody).toContain('R-1');
  });

  it('una búsqueda que respondió no se guarda; una que falló, sí', async () => {
    stubFetch(200, { items: [] });
    const { factory, record } = conBoveda();
    const acl = await factory.forTenant('t1');
    await acl.searchAvailability(BUSQUEDA);
    expect(record).not.toHaveBeenCalled();

    stubFetch(500, { code: 'X' });
    await acl.searchAvailability(BUSQUEDA).catch(() => undefined);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ outcome: 'PROVIDER_ERROR', httpStatus: 500 });
  });

  it('con la clave de plataforma queda a nombre del tenant y sin cuenta', async () => {
    vi.stubEnv('DESPEGAR_API_KEY', 'plataforma');
    stubFetch(200, { reservationId: 'R-1', status: 'SUCCESS', products: [] });
    const record = vi.fn((_w: ProviderPayloadWrite) => Promise.resolve());
    const factory = factoryCon(
      { resolve: () => Promise.reject(new NotFoundException('none')) },
      { enabled: true, record },
    );
    await (await factory.forTenant('t9')).getReservation('R-1');
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      ownerTenantId: 't9',
      providerAccountId: null,
    });
  });

  it('sin clave de la bóveda no se conecta, y un fallo de la bóveda no cambia la llamada', async () => {
    stubFetch(200, { reservationId: 'R-1', status: 'SUCCESS', products: [] });
    const apagada = conBoveda(false);
    await (await apagada.factory.forTenant('t1')).getReservation('R-1');
    expect(apagada.record).not.toHaveBeenCalled();

    const rota = conBoveda();
    rota.record.mockRejectedValueOnce(new Error('bóveda caída'));
    await expect((await rota.factory.forTenant('t1')).getReservation('R-1')).resolves.toMatchObject(
      { reservationId: 'R-1' },
    );
  });

  it('qué se guarda siempre y qué sólo si falla', () => {
    expect(shouldVaultDespegarPayload({ operation: 'book', outcome: 'SUCCESS' })).toBe(true);
    expect(shouldVaultDespegarPayload({ operation: 'cancel', outcome: 'SUCCESS' })).toBe(true);
    expect(shouldVaultDespegarPayload({ operation: 'availability', outcome: 'SUCCESS' })).toBe(
      false,
    );
    expect(shouldVaultDespegarPayload({ operation: 'availability', outcome: 'TRANSPORT' })).toBe(
      true,
    );
  });
});

describe('errores de la cancelación', () => {
  it('traduce la negativa de Despegar a cancelar', () => {
    const factory = factoryCon({ resolve: () => Promise.resolve(resolved()) });
    expect(
      factory.humanizeError(
        new DespegarCancelNotAllowedError({
          productId: 'P',
          allowance: 'DISALLOWED',
          disallowedReason: 'ALREADY_CANCELLED',
        }),
      ),
    ).toContain('ya está cancelada');
  });
});
