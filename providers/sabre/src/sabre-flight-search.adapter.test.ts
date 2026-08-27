import { OfferSchema, type Offer } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import type { FlightSearchCriteria, SearchContext } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import adultFixture from './__fixtures__/v5-roundtrip-adult-200.json';
import childFixture from './__fixtures__/v5-roundtrip-child-baggage-200.json';
import familyFixture from './__fixtures__/v5-roundtrip-family-200.json';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, parseSabreConfig, type SabreConfig } from './config';
import { SabreApiError, SabreConfigError } from './errors';
import {
  SabreFlightSearchAdapter,
  censoDeContenido,
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

/**
 * El cuerpo que salió por el cable, como texto.
 *
 * No es `String(init.body)`: `BodyInit` admite `Blob`, `FormData` y streams, y sobre esos
 * `String()` devuelve `'[object Object]'` — un `expect(...).toContain('BrandedFareIndicators')`
 * pasaría a ser una aserción que no puede fallar nunca. Acá la suposición se declara y se rompe
 * ruidosamente si deja de valer.
 */
function cuerpo(init: RequestInit): string {
  const { body } = init;
  if (typeof body !== 'string') throw new Error('el cuerpo de la petición a Sabre no es texto');
  return body;
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

describe('sin credenciales usables el adapter NO se construye', () => {
  // La avería que este bloque sustituye: al faltar una credencial el adapter caía a fixtures y
  // devolvía tres ofertas con la MISMA forma canónica que una tarifa real. Ya no hay rama a la
  // que caer — construirlo falla, y el proveedor queda ausente de la búsqueda.
  it.each([
    ['epr', config({ epr: undefined })],
    ['password', config({ password: undefined })],
    ['homePcc', config({ homePcc: undefined })],
  ])('falta %s → la construcción lanza', (field, cfg) => {
    expect(() => adapter(cfg)).toThrowError(SabreConfigError);
    expect(() => adapter(cfg)).toThrowError(new RegExp(field));
  });

  it('el error nombra el campo pero nunca su valor', () => {
    let mensaje = '';
    try {
      adapter(config({ epr: undefined }));
    } catch (err) {
      mensaje = err instanceof Error ? err.message : String(err);
    }
    expect(mensaje).toContain('epr');
    expect(mensaje).not.toContain(PASSWORD);
  });

  it('con las tres credenciales se construye y no le falta ninguna', () => {
    const sut = adapter(config());
    expect(sut.missingCredentials).toEqual([]);
  });

  it('el JSONB de la cuenta no puede reintroducir un modo simulado', () => {
    // `config.mock` era el último interruptor que quedaba encendible desde datos del tenant.
    // `SabreConfigSchema` ya no declara el campo y Zod descarta lo que no declara, así que una
    // cuenta con `mock: true` y sin credenciales sigue siendo una cuenta sin credenciales.
    const conMockDeclarado = parseSabreConfig({
      host: SABRE_HOSTS.cert.rest,
      mock: true,
    });
    expect(conMockDeclarado).not.toHaveProperty('mock');
    expect(() => adapter(conMockDeclarado)).toThrowError(SabreConfigError);
  });
});

describe('la búsqueda no tiene ninguna rama que no llame a Sabre', () => {
  it('una búsqueda siempre sale por el cable', async () => {
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);
    expect(spy.calls).toHaveLength(1);
  });
});

describe('search en modo real', () => {
  // La moneda va POR FIXTURE porque es la que cada ejemplo oficial cotiza de verdad: el de
  // adulto en USD y los otros dos en EUR. Buscar los tres con una sola moneda no probaría el
  // mapeo, probaría la puerta de moneda del ACL —que descarta lo que vuelve en otra— y dejaría
  // dos de los tres ejemplos oficiales sin comprobar. Esa puerta tiene sus propios tests en
  // `shop/currency-guard.test.ts`.
  const officialFixtures = [
    ['adulto', adultFixture, 'USD'],
    ['menor con equipaje', childFixture, 'EUR'],
    ['familia', familyFixture, 'EUR'],
  ] as const;

  it.each(officialFixtures)(
    'el ejemplo oficial "%s" produce Offer[] válido',
    async (_name, fixture, currency) => {
      const spy = spyFetch(() => json(fixture));
      const offers = await adapter(config(), { fetch: spy.fetch }).search(
        { ...CRITERIA, currency },
        CTX,
      );

      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(() => OfferSchema.parse(offer)).not.toThrow();
        expect(offer.tenantId).toBe(TENANT_ID);
        expect(offer.provider.name).toBe('sabre');
        expect(offer.fetchedAt).toBe('2026-08-26T12:00:00.000Z');
        expect(offer.total.currency).toBe(currency);
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

/* ────────────────────────────────────────────────────────────────────────────
 * Marcas tarifarias: degradar, nunca tumbar la búsqueda
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Estos cinco tests existen por un incidente concreto y no por completar una matriz.
 *
 * Se soltó `brandedUpsells: true` para toda la red sin poder probarlo contra un PCC real. El de
 * producción no ignoró la petición: devolvió un fallo de NEGOCIO dentro de un 200, y como
 * `latam-ndc` ya venía descartado por moneda, `POST /search/flights` quedó en 502. Una mejora
 * opcional tumbó lo único que la plataforma no puede permitirse perder.
 *
 * Lo que se prueba acá no es que las marcas funcionen —eso depende del alta comercial de cada
 * agencia con Sabre y no hay test que lo sustituya—, sino que **no funcionar no cueste la
 * búsqueda**.
 */
describe('marcas tarifarias: si el PCC no las tiene, la búsqueda igual sale', () => {
  /** Sobre 200 con un fallo de negocio dentro: es la forma EXACTA del rechazo de producción. */
  function rechazoDeNegocio(): Response {
    return json({
      groupedItineraryResponse: {
        messages: [
          {
            severity: 'Error',
            type: 'BusinessError',
            code: 'ERR.2SG.CLIENT.INVALID_INPUT',
            description: 'Branded fares not enabled for this PCC',
          },
        ],
      },
    });
  }

  it('rechazada la consulta con marcas, se reintenta SIN ellas y el vendedor ve ofertas', async () => {
    const spy = spyFetch((n) => (n === 1 ? rechazoDeNegocio() : json(adultFixture)));
    const { logger, calls } = spyLogger();
    const offers = await adapter(config(), {
      fetch: spy.fetch,
      logger,
      shopOptions: { brandedFares: 'upsell' },
    }).search(CRITERIA, CTX);

    expect(offers.length).toBeGreaterThan(0);
    expect(spy.calls).toHaveLength(2);

    // La degradación baja UN escalón: `upsell` → `single`. La segunda llamada SIGUE pidiendo
    // marcas, sólo que la variante que el motor sí acepta. Apagarlas del todo cambiaría una
    // función que en producción funciona por ninguna.
    const cuerpos = spy.calls.map((c) => cuerpo(c.init));
    expect(cuerpos[0]).toContain('MultipleBrandedFares');
    expect(cuerpos[1]).toContain('SingleBrandedFare');
    expect(cuerpos[1]).not.toContain('MultipleBrandedFares');

    expect(calls.map((c) => c.message)).toContain('sabre.shop.branded_fares_degradado');
  });

  it('no se vuelve a preguntar: la segunda búsqueda ya sale sin marcas', async () => {
    const spy = spyFetch((n) => (n === 1 ? rechazoDeNegocio() : json(adultFixture)));
    const sut = adapter(config(), { fetch: spy.fetch, shopOptions: { brandedFares: 'upsell' } });

    await sut.search(CRITERIA, CTX);
    await sut.search(CRITERIA, CTX);

    // 2 de la primera búsqueda (rechazo + reintento) + 1 de la segunda. Si fueran 4, estaríamos
    // pagando una llamada de más por búsqueda y por siempre.
    expect(spy.calls).toHaveLength(3);
    // Y la segunda búsqueda arranca YA en el escalón aprendido, sin volver a probar el de arriba.
    expect(cuerpo(spy.calls[2]!.init)).not.toContain('MultipleBrandedFares');
    expect(cuerpo(spy.calls[2]!.init)).toContain('SingleBrandedFare');
  });

  it('sin marcas pedidas NO hay reintento: un fallo de negocio sigue siendo un fallo', async () => {
    // El reintento es una degradación acotada, no un «si algo falla, prueba otra cosa».
    //
    // `brandedUpsells: false` va EXPLÍCITO. Antes este test omitía las opciones y pasaba por la
    // avería que arregla el bloque de abajo: sin opciones las marcas quedaban apagadas, así que
    // el test verificaba el default roto en vez de la regla que dice cubrir.
    const spy = spyFetch(() => rechazoDeNegocio());
    await expect(
      adapter(config(), { fetch: spy.fetch, shopOptions: { brandedFares: 'off' } }).search(
        CRITERIA,
        CTX,
      ),
    ).rejects.toThrow(SabreApiError);
    expect(spy.calls).toHaveLength(1);
  });

  it('un fallo de TRANSPORTE con marcas pedidas no se disfraza de degradación', async () => {
    // 503 es «Sabre está caído», no «tu PCC no tiene marcas». Reintentar sin marcas ocultaría
    // una caída detrás de una lista más pobre.
    const spy = spyFetch(() => json({ error: 'unavailable' }, 503));
    await expect(
      adapter(config(), { fetch: spy.fetch, shopOptions: { brandedFares: 'upsell' } }).search(
        CRITERIA,
        CTX,
      ),
    ).rejects.toThrow(SabreApiError);
    // El cliente HTTP reintenta un 503 por su cuenta; lo que no puede es acabar sin marcas.
    for (const call of spy.calls) {
      expect(cuerpo(call.init)).toContain('BrandedFareIndicators');
    }
  });

  it('si el PCC SÍ las acepta, no hay llamada de más', async () => {
    const spy = spyFetch(() => json(adultFixture));
    const offers = await adapter(config(), {
      fetch: spy.fetch,
      shopOptions: { brandedFares: 'upsell' },
    }).search(CRITERIA, CTX);

    expect(offers.length).toBeGreaterThan(0);
    expect(spy.calls).toHaveLength(1);
    expect(cuerpo(spy.calls[0]!.init)).toContain('BrandedFareIndicators');
  });
});

describe('marcas tarifarias: el fallo silencioso, que es el peor', () => {
  /**
   * Sobre 200 EN CONTRATO, sin errores y sin itinerarios. Sabre «acepta» y no devuelve nada.
   *
   * `version` y `messages` van porque el mapper los exige: un sobre a medias no probaría el
   * camino de la respuesta vacía, sino el del sobre inválido, que es otro test.
   */
  function vacio(): Response {
    return json({
      groupedItineraryResponse: {
        version: '5',
        messages: [{ severity: 'Info', type: 'SERVER', code: 'GCA14-ISELL', text: '0' }],
        itineraryGroups: [],
      },
    });
  }

  it('si pedir marcas VACÍA la respuesta, se reintenta sin ellas antes de decir «no hay vuelos»', async () => {
    // Es el modo de fallo que la doc del proyecto documenta para el tier: no un rechazo, un
    // cero indistinguible de una ruta sin oferta. Un buscador que dice «no hay vuelos» en una
    // ruta que sí los tiene es peor que uno que da error: nadie se entera.
    const spy = spyFetch((n) => (n === 1 ? vacio() : json(adultFixture)));
    const { logger, calls } = spyLogger();
    const offers = await adapter(config(), {
      fetch: spy.fetch,
      logger,
      shopOptions: { brandedFares: 'upsell' },
    }).search(CRITERIA, CTX);

    expect(offers.length).toBeGreaterThan(0);
    expect(spy.calls).toHaveLength(2);
    expect(calls.map((c) => c.message)).toContain('sabre.shop.branded_fares_vacian_la_respuesta');
  });

  it('una ruta VACÍA DE VERDAD se reintenta una vez y se acepta como vacía', async () => {
    const spy = spyFetch(() => vacio());
    const sut = adapter(config(), { fetch: spy.fetch, shopOptions: { brandedFares: 'upsell' } });

    expect(await sut.search(CRITERIA, CTX)).toEqual([]);
    expect(spy.calls).toHaveLength(2);

    // Y la cuenta NO queda marcada como incapaz por una ruta sin vuelos: la siguiente búsqueda
    // vuelve a pedir marcas.
    await sut.search(CRITERIA, CTX);
    expect(cuerpo(spy.calls[2]!.init)).toContain('BrandedFareIndicators');
  });

  it('una cuenta que YA dio ofertas con marcas no paga la llamada de comprobación', async () => {
    // Primera búsqueda con resultados: queda probado que soporta marcas. Segunda vacía: es una
    // ruta sin vuelos, no una sospecha, y no se gasta una segunda llamada.
    const spy = spyFetch((n) => (n === 1 ? json(adultFixture) : vacio()));
    const sut = adapter(config(), { fetch: spy.fetch, shopOptions: { brandedFares: 'upsell' } });

    await sut.search(CRITERIA, CTX);
    expect(await sut.search(CRITERIA, CTX)).toEqual([]);
    expect(spy.calls).toHaveLength(2);
  });
});

describe('censoDeContenido: qué trae la respuesta, no cuánto', () => {
  function oferta(over: Partial<Offer> = {}): Offer {
    return {
      id: 'x',
      tenantId: TENANT_ID,
      products: ['flight'],
      provider: { name: 'sabre', offerRef: 'r' },
      total: { amountMinor: 100, currency: 'USD' },
      baseFare: { amountMinor: 80, currency: 'USD' },
      taxes: { amountMinor: 20, currency: 'USD' },
      fetchedAt: '2026-08-26T12:00:00.000Z',
      expiresAt: '2026-08-26T12:30:00.000Z',
      ...over,
    };
  }

  it('cuenta las marcas y las nombra', () => {
    // `offers: 50` no distingue «50 vuelos con una tarifa» de «50 tarifas de 12 vuelos», que es
    // justo la pregunta al encender el upsell.
    const censo = censoDeContenido([
      oferta({ fareFamily: { name: 'LIGHT', cabin: 'economy' } }),
      oferta({ fareFamily: { name: 'PLUS', cabin: 'economy' } }),
      oferta({ fareFamily: { name: 'LIGHT', cabin: 'economy' } }),
      oferta(),
    ]);

    expect(censo.conMarca).toBe(3);
    expect(censo.marcas).toEqual(['LIGHT', 'PLUS']);
  });

  it('sin marcas el censo lo dice con un cero, no con un hueco', () => {
    const censo = censoDeContenido([oferta(), oferta()]);
    expect(censo).toEqual({ conMarca: 0, marcas: [], conEquipaje: 0, conMarcaDisponible: 0 });
  });

  it('distingue «no hay marcas» de «las hay y no nos llegan»', () => {
    // Los dos casos se ven idénticos en pantalla —el vendedor no ve tipos de tarifa— y piden
    // acciones opuestas: uno no tiene arreglo posible y el otro es un alta comercial con Sabre.
    // `brandsOnAnyMarket` es lo único que los separa, y lo dice el propio proveedor.
    const sinContenido = censoDeContenido([
      oferta({ provider: { name: 'sabre', offerRef: 'r', raw: { brandsOnAnyMarket: false } } }),
      oferta({ provider: { name: 'sabre', offerRef: 'r', raw: { brandsOnAnyMarket: null } } }),
    ]);
    expect(sinContenido.conMarcaDisponible).toBe(0);
    expect(sinContenido.conMarca).toBe(0);

    const hayYNoLlegan = censoDeContenido([
      oferta({ provider: { name: 'sabre', offerRef: 'r', raw: { brandsOnAnyMarket: true } } }),
      oferta({ provider: { name: 'sabre', offerRef: 'r', raw: { brandsOnAnyMarket: true } } }),
    ]);
    expect(hayYNoLlegan.conMarcaDisponible).toBe(2);
    expect(hayYNoLlegan.conMarca).toBe(0);
  });

  it('el equipaje se cuenta aparte de la marca: son dos ausencias distintas', () => {
    const censo = censoDeContenido([
      oferta({
        baggage: { personalItem: 1, carryOn: { qty: 1 }, checked: { qty: 1 } },
      }),
      oferta({ fareFamily: { name: 'TOP', cabin: 'economy' } }),
    ]);

    expect(censo.conEquipaje).toBe(1);
    expect(censo.conMarca).toBe(1);
  });

  it('la lista de marcas no crece con la respuesta', () => {
    // Una respuesta de BFM trae cientos de itinerarios; el log no puede crecer con ellos.
    const muchas = Array.from({ length: 40 }, (_, i) =>
      oferta({ fareFamily: { name: `MARCA${String(i).padStart(2, '0')}`, cabin: 'economy' } }),
    );
    expect(censoDeContenido(muchas).marcas).toHaveLength(12);
    expect(censoDeContenido(muchas).conMarca).toBe(40);
  });
});

describe('el default de las marcas llega hasta el cable, no se queda en el Zod', () => {
  it('SIN opciones se piden marcas: el default del esquema no puede quedarse a medio camino', async () => {
    // La avería exacta: el adapter leía `opciones.brandedUpsells === true` sobre la entrada SIN
    // parsear —donde el campo no existe— así que salía `false`, y encima se lo pasaba explícito
    // al builder pisando su propio default. Las marcas estaban apagadas para toda la red mientras
    // el código decía que estaban encendidas; en producción se leía `pidioMarcas: false`.
    const spy = spyFetch(() => json(adultFixture));

    await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);

    expect(cuerpo(spy.calls[0]!.init)).toContain('BrandedFareIndicators');
  });

  it('y apagarlo por cuenta sigue funcionando', async () => {
    const spy = spyFetch(() => json(adultFixture));

    await adapter(config(), {
      fetch: spy.fetch,
      shopOptions: { brandedFares: 'off' },
    }).search(CRITERIA, CTX);

    expect(cuerpo(spy.calls[0]!.init)).not.toContain('BrandedFareIndicators');
  });
});

describe('MFPI: varias tarifas por itinerario, apagado por defecto', () => {
  function rechazo(): Response {
    return json({
      groupedItineraryResponse: {
        version: '5',
        messages: [{ severity: 'Error', type: 'MIP', code: 'PROCESS' }],
      },
    });
  }

  it('por defecto NO se pide: cero evidencia en la colección, y eso ya costó un 502', async () => {
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), { fetch: spy.fetch }).search(CRITERIA, CTX);
    expect(cuerpo(spy.calls[0]!.init)).not.toContain('FlexibleFares');
  });

  it('encendido pide DOS grupos: la más barata y la más barata con maleta', async () => {
    // Es la comparación que decide la venta: «sin maleta $X, con maleta $Y».
    const spy = spyFetch(() => json(adultFixture));
    await adapter(config(), {
      fetch: spy.fetch,
      shopOptions: { multipleFares: 'with-baggage' },
    }).search(CRITERIA, CTX);

    const body = JSON.parse(cuerpo(spy.calls[0]!.init)) as {
      OTA_AirLowFareSearchRQ: {
        TravelPreferences: { TPA_Extensions: { FlexibleFares?: { FareParameters: unknown[] } } };
      };
    };
    expect(
      body.OTA_AirLowFareSearchRQ.TravelPreferences.TPA_Extensions.FlexibleFares?.FareParameters,
    ).toEqual([{}, { Baggage: { FreePieceRequired: true } }]);
  });

  it('si el motor lo rechaza, se apaga MFPI y las MARCAS se conservan', async () => {
    // La parte que importa: MFPI es experimental y las marcas en esta cuenta funcionan. Apagar
    // las dos de golpe cambiaría una función que anda por una que nadie encendió por defecto.
    const spy = spyFetch((n) => (n === 1 ? rechazo() : json(adultFixture)));
    const { logger, calls } = spyLogger();

    const offers = await adapter(config(), {
      fetch: spy.fetch,
      logger,
      shopOptions: { multipleFares: 'with-baggage' },
    }).search(CRITERIA, CTX);

    expect(offers.length).toBeGreaterThan(0);
    expect(calls.map((c) => c.message)).toContain('sabre.shop.multiple_fares_no_soportadas');

    const reintento = cuerpo(spy.calls[1]!.init);
    expect(reintento).not.toContain('FlexibleFares');
    expect(reintento).toContain('BrandedFareIndicators');
  });

  it('y no se vuelve a pedir en la siguiente búsqueda', async () => {
    const spy = spyFetch((n) => (n === 1 ? rechazo() : json(adultFixture)));
    const sut = adapter(config(), {
      fetch: spy.fetch,
      shopOptions: { multipleFares: 'with-baggage' },
    });

    await sut.search(CRITERIA, CTX);
    await sut.search(CRITERIA, CTX);

    expect(spy.calls).toHaveLength(3);
    expect(cuerpo(spy.calls[2]!.init)).not.toContain('FlexibleFares');
  });
});
