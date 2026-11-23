import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import type {
  ProviderPayloadWrite,
  ProviderPayloadWriter,
} from '../provider-payloads/provider-payloads.types.js';
import {
  AVAILABILITY_UN_ORL_FAMILY,
  BOOK_SUCCESS,
} from './__fixtures__/despegar-activities.fixtures.js';
import {
  DespegarActivitiesNotConfiguredError,
  DespegarActivitiesProviderFactory,
  shouldVaultActivitiesPayload,
} from './despegar-activities.factory.js';

function resolved(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-1',
    ownerTenantId: 'owner-1',
    providerCode: 'despegar-hotels',
    label: 'default',
    config: { baseUrl: 'https://api-dev.despegar.com/v3', language: 'ES', countryCode: 'BR' },
    credentials: { apiKey: 'k-tenant' },
    inherited: true,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function writer(): ProviderPayloadWriter & { writes: ProviderPayloadWrite[] } {
  const writes: ProviderPayloadWrite[] = [];
  return {
    enabled: true,
    writes,
    record: (w: ProviderPayloadWrite) => {
      writes.push(w);
      return Promise.resolve();
    },
  };
}

function stubFetch(body: unknown) {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('DespegarActivitiesProviderFactory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('usa la MISMA cuenta BYOC que hoteles (`despegar-hotels`), heredada del consolidador', async () => {
    const resolve = vi.fn(() => Promise.resolve(resolved()));
    const f = new DespegarActivitiesProviderFactory({
      resolve,
    } as unknown as ProviderCredentialsService);
    const r = await f.forTenant('tenant-1');
    expect(resolve).toHaveBeenCalledWith('tenant-1', 'despegar-hotels');
    expect(r).toMatchObject({ credentialSource: 'inherited', accountId: 'acc-1', site: 'BR' });

    const fetchFn = stubFetch(AVAILABILITY_UN_ORL_FAMILY);
    await r.adapter.getAvailability({
      id: 'UN_ORL',
      modality: 'M',
      date: '2026-12-10',
      participants: { adults: 2, childrenAges: [] },
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toMatch(
      /^https:\/\/api-dev\.despegar\.com\/v3\/activities-api\/availability\?/,
    );
    expect((init?.headers as Record<string, string>)['x-apikey']).toBe('k-tenant');
    // El idioma de la cuenta (ES) se usa en minúsculas en availability.
    expect(String(url)).toContain('language=es');
  });

  it('la misma versión de la cuenta reusa el adapter; otra versión lo reemplaza', async () => {
    let updatedAt = new Date('2026-01-01T00:00:00Z');
    const f = new DespegarActivitiesProviderFactory({
      resolve: () => Promise.resolve(resolved({ updatedAt })),
    } as unknown as ProviderCredentialsService);
    const a = await f.forTenant('t');
    expect(await f.forTenant('t')).toBe(a);
    updatedAt = new Date('2026-02-01T00:00:00Z');
    expect(await f.forTenant('t')).not.toBe(a);
  });

  it('sin cuenta, la clave de la plataforma; sin ninguna, no está configurado', async () => {
    const creds = {
      resolve: () => Promise.reject(new NotFoundException()),
    } as unknown as ProviderCredentialsService;
    vi.stubEnv('DESPEGAR_API_KEY', '');
    await expect(
      new DespegarActivitiesProviderFactory(creds).forTenant('t'),
    ).rejects.toBeInstanceOf(DespegarActivitiesNotConfiguredError);
    vi.stubEnv('DESPEGAR_API_KEY', 'k-plataforma');
    const r = await new DespegarActivitiesProviderFactory(creds).forTenant('t');
    expect(r).toMatchObject({ credentialSource: 'env', accountId: null });
  });

  it('guarda en la bóveda la venta con el código `despegar-activities` y su cuenta', async () => {
    const w = writer();
    const f = new DespegarActivitiesProviderFactory(
      { resolve: () => Promise.resolve(resolved()) } as unknown as ProviderCredentialsService,
      w,
    );
    const { adapter } = await f.forTenant('t');
    stubFetch(BOOK_SUCCESS);
    await adapter.getBookStatus('815222296950');
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]).toMatchObject({
      providerCode: 'despegar-activities',
      operation: 'activitiesBookStatus',
      providerAccountId: 'acc-1',
      ownerTenantId: 'owner-1',
      environment: 'test',
    });
  });

  it('las búsquedas sólo van a la bóveda si fallaron', () => {
    expect(shouldVaultActivitiesPayload({ operation: 'activitiesBook', outcome: 'SUCCESS' })).toBe(
      true,
    );
    expect(
      shouldVaultActivitiesPayload({ operation: 'activitiesDiscovery', outcome: 'SUCCESS' }),
    ).toBe(false);
    expect(
      shouldVaultActivitiesPayload({ operation: 'activitiesDiscovery', outcome: 'REJECTED' }),
    ).toBe(true);
  });
});
