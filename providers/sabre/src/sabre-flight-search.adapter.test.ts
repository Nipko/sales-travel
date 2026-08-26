import { OfferSchema } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import type { FlightSearchCriteria, SearchContext } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { isSabreMockOffer } from './fixtures';
import {
  SabreFlightSearchAdapter,
  countWarningsByCode,
  type SabreFlightSearchDeps,
} from './sabre-flight-search.adapter';
import { SABRE_SHOP_PATH } from './shop/request.builder';
import { SabreShopMappingError, type SabreMapWarning } from './shop/response.mapper';

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const NOW_MS = Date.parse('2026-08-26T12:00:00.000Z');
const PASSWORD = 'Pa55w0rd!';

const CRITERIA: FlightSearchCriteria = {
  origin: 'BOG',
  destination: 'LIM',
  departureDate: '2026-09-11',
  returnDate: '2026-09-18',
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'USD',
};

const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'req-42' };

/** `ZZZZ` es el PCC falso del criterio de salida §6.4: ningún PCC de tercero vive en el código. */
function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: PASSWORD,
    conversationIdPrefix: 'sales-travel',
    ...overrides,
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

const fakeTokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

interface FetchSpy {
  fetch: SabreFetch;
  calls: Array<{ url: string; init: RequestInit }>;
}

function spyFetch(responder: (n: number) => Response): FetchSpy {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(responder(calls.length));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function adapter(
  cfg: SabreConfig,
  extras: Partial<SabreFlightSearchDeps> = {},
): SabreFlightSearchAdapter {
  return new SabreFlightSearchAdapter(cfg, {
    tokens: fakeTokens,
    now: () => NOW_MS,
    uuid: () => 'conv-fijo',
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    ...extras,
  });
}

describe('isMock — el fallback silencioso tiene que ser visible', () => {
  // Sin este getter un tenant mal configurado cotiza precios inventados con aspecto de reales.
  it.each([
    ['epr', config({ epr: undefined })],
    ['password', config({ password: undefined })],
    ['homePcc', config({ homePcc: undefined })],
  ])('falta %s → isMock', (field, cfg) => {
    const sut = adapter(cfg);
    expect(sut.isMock).toBe(true);
    expect(sut.missingCredentials).toContain(field);
  });

  it('con las tres credenciales no es mock', () => {
    const sut = adapter(config());
    expect(sut.isMock).toBe(false);
    expect(sut.missingCredentials).toEqual([]);
  });

  it('mock: true fuerza el modo aunque las credenciales estén', () => {
    expect(adapter(config({ mock: true })).isMock).toBe(true);
  });

  it('avisa al construirse en modo mock, con NOMBRES de credencial y nunca valores', () => {
    const { logger, calls } = spyLogger();
    adapter(config({ password: undefined }), { logger });

    const aviso = calls.find((call) => call.message === 'sabre.adapter.modo_mock');
    expect(aviso?.level).toBe('warn');
    expect(aviso?.meta?.['missing']).toEqual(['password']);
    expect(JSON.stringify(calls)).not.toContain(PASSWORD);
  });

  it('no avisa cuando hay credenciales', () => {
    const { logger, calls } = spyLogger();
    adapter(config(), { logger });
    expect(calls.filter((call) => call.message === 'sabre.adapter.modo_mock')).toHaveLength(0);
  });
});

describe('search en modo mock', () => {
  it('devuelve Offer[] válido sin tocar la red', async () => {
    const spy = spyFetch(() => json({}));
    const offers = await adapter(config({ homePcc: undefined }), { fetch: spy.fetch }).search(
      CRITERIA,
      CTX,
    );

    expect(spy.calls).toHaveLength(0);
    expect(offers).toHaveLength(3);
    for (const offer of offers) {
      expect(() => OfferSchema.parse(offer)).not.toThrow();
      expect(offer.tenantId).toBe(TENANT_ID);
      expect(isSabreMockOffer(offer)).toBe(true);
    }
  });

  it('avisa en cada búsqueda, no sólo al arrancar', async () => {
    const { logger, calls } = spyLogger();
    const sut = adapter(config({ epr: undefined }), { logger });
    await sut.search(CRITERIA, CTX);
    await sut.search(CRITERIA, CTX);

    const avisos = calls.filter((call) => call.message === 'sabre.adapter.busqueda_mock');
    expect(avisos).toHaveLength(2);
    expect(avisos[0]?.level).toBe('warn');
    expect(avisos[0]?.meta?.['missing']).toEqual(['epr']);
  });
});

describe('search en modo real', () => {
  const officialFixtures = [
    ['adulto', adultFixture],
    ['menor con equipaje', childFixture],
    ['familia', familyFixture],
  ] as const;

  it.each(officialFixtures)(
    'el ejemplo oficial "%s" produce Offer[] válido',
    async (_name, fixture) => {
      const spy = spyFetch(() => json(fixture));
      const offers = await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);

      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(() => OfferSchema.parse(offer)).not.toThrow();
        expect(offer.tenantId).toBe(TENANT_ID);
        expect(offer.provider.name).toBe('sabre');
        expect(isSabreMockOffer(offer)).toBe(false);
        expect(offer.fetchedAt).toBe('2026-08-26T12:00:00.000Z');
      }
    },
  );

  it('llega a /v5/offers/shop con el PCC de la config y ningún otro', async () => {
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);

    const call = spy.calls[0];
    expect(call?.url).toBe(`${SABRE_HOSTS.cert.rest}${SABRE_SHOP_PATH}`);

    const body = typeof call?.init.body === 'string' ? call.init.body : '';
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('ZZZZ');
    for (const ajeno of ['U9PK', 'G7RE', '7KFA', 'G7HE', 'N87F', 'GF1I']) {
      expect(body).not.toContain(ajeno);
    }
  });

  it('el Conversation-ID conserva el prefijo y el requestId del contexto', async () => {
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);

    const headers = spy.calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.['Conversation-ID']).toBe('sales-travel-req-42');
  });

  it('sin requestId el cliente genera su propio Conversation-ID', async () => {
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, { tenantId: TENANT_ID });

    const headers = spy.calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.['Conversation-ID']).toBe('sales-travel-conv-fijo');
  });

  it('sin token inyectado autentica primero y luego busca', async () => {
    // Cubre el cableado por defecto: `SabreTokenService` + `SabreHttpClient` compartiendo `fetch`.
    const spy = spyFetch((n) =>
      n === 1
        ? json({ access_token: 'ATK-SUPERSECRETO', expires_in: 604_800 })
        : json(adultFixture),
    );
    const sut = new SabreFlightSearchAdapter(config(), {
      fetch: spy.fetch,
      now: () => NOW_MS,
      uuid: () => 'conv-fijo',
    });
    const offers = await sut.search(CRITERIA, CTX);

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toBe(`${SABRE_HOSTS.cert.rest}/v2/auth/token`);
    expect(spy.calls[1]?.url).toBe(`${SABRE_HOSTS.cert.rest}${SABRE_SHOP_PATH}`);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('una búsqueda sí se reintenta: no mueve dinero', async () => {
    const spy = spyFetch((n) => (n === 1 ? json({ message: 'boom' }, 503) : json(adultFixture)));
    const offers = await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);

    expect(spy.calls).toHaveLength(2);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('un 200 con errors[] es un fallo, no una lista vacía', async () => {
    const spy = spyFetch(() =>
      json({
        errors: [
          { category: 'BUSINESS', type: 'VALIDATION', code: 'ERR.2SG.CLIENT.INVALID_INPUT' },
        ],
      }),
    );

    await expect(
      adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX),
    ).rejects.toBeInstanceOf(SabreApiError);
  });

  it('un 200 fuera de contrato lanza SabreShopMappingError, sin filtrar valores', async () => {
    const spy = spyFetch(() =>
      json({ groupedItineraryResponse: { pasajero: 'PEREZ/JUAN', statistics: {} } }),
    );

    const promesa = adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);
    await expect(promesa).rejects.toBeInstanceOf(SabreShopMappingError);
    await expect(promesa).rejects.toThrow(/^(?!.*PEREZ)/s);
  });
});

describe('logs del mapeo', () => {
  it('sube la degradación declarada por Sabre, sin texto del proveedor', async () => {
    const degradado = structuredClone(adultFixture) as {
      groupedItineraryResponse: {
        messages: Array<Record<string, unknown>>;
        statistics?: Record<string, number>;
      };
    };
    degradado.groupedItineraryResponse.messages = [
      { severity: 'Warning', type: 'SCHEDULE', code: '1234', text: 'PEREZ/JUAN sin cupo' },
    ];

    const { logger, calls } = spyLogger();
    const spy = spyFetch(() => json(degradado));
    await adapter(config(), { fetch: spy.fetch, logger }).search(CRITERIA, CTX);

    const aviso = calls.find((call) => call.message === 'sabre.shop.degradado');
    expect(aviso?.level).toBe('warn');
    expect(aviso?.meta?.['tenantId']).toBe(TENANT_ID);
    expect(JSON.stringify(calls)).not.toContain('PEREZ');
    expect(JSON.stringify(calls)).not.toContain('sin cupo');
  });

  it('agrega los warnings del mapper por código, no uno por itinerario', async () => {
    const { logger, calls } = spyLogger();
    const spy = spyFetch(() => json(childFixture));
    await adapter(config(), { fetch: spy.fetch, logger }).search(CRITERIA, CTX);

    const aviso = calls.find((call) => call.message === 'sabre.shop.warnings');
    expect(aviso?.level).toBe('warn');
    const counts = aviso?.meta?.['warnings'] as Record<string, number> | undefined;
    expect(counts).toBeDefined();
    for (const value of Object.values(counts ?? {})) {
      expect(typeof value).toBe('number');
    }
  });

  it('un mapeo limpio se loguea en debug con el conteo de ofertas', async () => {
    const { logger, calls } = spyLogger();
    const spy = spyFetch(() => json({ groupedItineraryResponse: { version: 5, messages: [] } }));
    const offers = await adapter(config(), { fetch: spy.fetch, logger }).search(CRITERIA, CTX);

    expect(offers).toEqual([]);
    const ok = calls.find((call) => call.message === 'sabre.shop.ok');
    expect(ok?.level).toBe('debug');
    expect(ok?.meta?.['offers']).toBe(0);
  });

  it('nunca loguea el token ni el body saliente', async () => {
    const { logger, calls } = spyLogger();
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), { fetch: spy.fetch, logger }).search(CRITERIA, CTX);

    const serializado = JSON.stringify(calls);
    expect(serializado).not.toContain('ATK-SUPERSECRETO');
    expect(serializado).not.toContain(PASSWORD);
    expect(serializado).not.toContain('OTA_AirLowFareSearchRQ');
  });
});

describe('countWarningsByCode', () => {
  it('cuenta por código en vez de listar', () => {
    const warnings: SabreMapWarning[] = [
      { code: 'ndc-content-skipped', path: 'a' },
      { code: 'ndc-content-skipped', path: 'b' },
      { code: 'offer-invalid', path: 'c' },
    ];
    expect(countWarningsByCode(warnings)).toEqual({
      'ndc-content-skipped': 2,
      'offer-invalid': 1,
    });
  });

  it('sin warnings devuelve un objeto vacío', () => {
    expect(countWarningsByCode([])).toEqual({});
  });
});
