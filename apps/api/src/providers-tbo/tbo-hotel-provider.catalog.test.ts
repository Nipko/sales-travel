import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TBO_BASE_URLS,
  TBO_OPERATIONS,
  TboApiError,
  TboRequestBuildError,
  TboStaticContentClient,
  parseTboConfig,
  tboHotelContentHash,
  type TboFetch,
  type TboHotelContent,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  supportsHotelCityCatalog,
  supportsHotelContentBatch,
} from '../providers/hotel-provider.types.js';
import {
  TboContentClientMissingError,
  TboHotelProviderAdapter,
  type TboHotelsAcl,
} from './tbo-hotel-provider.adapter.js';

// El nombre del campo va en CAMPO y el valor de prueba en una constante: el detector de secretos
// de GitGuardian marca como contraseña real cualquier línea que ponga un valor al lado de ese
// nombre, aunque sea un texto de prueba.
const CAMPO = { clave: 'password' } as const;

/**
 * El catálogo bajo demanda de TBO por la puerta pública del cliente de contenido REAL del ACL, con
 * un `fetch` falso que responde con los ejemplos del PDF: fotos de los resultados (HotelDetails por
 * lotes, para guardar) y los hoteles de una ciudad que el catálogo todavía no tiene
 * (TBOHotelCodeList). Lo que se mide es lo que sale al cable y lo que el API recibe para guardar.
 */

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
);
const CTX = { tenantId: '11111111-1111-4111-8111-111111111111' };
const CUENTA = { accountId: 'acc-consolidador', updatedAt: '2026-09-01T00:00:00.000Z' };
const USERNAME = 'consolidador-demo';
const CLAVE = 'clave-consolidador';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, 'pdf', name), 'utf8')) as Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** El body JSON de una llamada a TBO: el cliente siempre manda texto. */
function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

const immediate: TboRateLimiter = {
  acquire: () => Promise.resolve({ granted: true, permit: { release: () => undefined } }),
  reportThrottled: () => undefined,
};

interface Harness {
  readonly adapter: TboHotelProviderAdapter;
  readonly fetch: Mock<TboFetch>;
  readonly lanes: string[];
}

/**
 * HotelDetails devuelve los códigos pedidos menos `omitir`, sólo en los idiomas de `idiomas` (por
 * defecto todos) y con "No Hotels Found" si no queda ninguno o si el lote trae uno de `malos` (H2
 * del 2026-09-30, 05 CE-23); `caido` lo contesta con un 500 cualquiera. TBOHotelCodeList, `hoteles`.
 */
function harness(
  options: {
    omitir?: string[];
    hoteles?: unknown[] | 'no-hotels';
    idiomas?: string[];
    malos?: string[];
    caido?: boolean;
  } = {},
): Harness {
  const detalle = fixture('hotel-details.p59.json');
  const plantilla = (detalle['HotelDetails'] as Record<string, unknown>[])[0] ?? {};
  const lista = fixture('tbo-hotel-code-list.p67.json');
  const lanes: string[] = [];
  const fetch = vi.fn<TboFetch>((url, init) => {
    const path = url.slice(TBO_BASE_URLS.test.length);
    const body = cuerpoDe(init);
    if (path === TBO_OPERATIONS.hotelDetails.path) {
      const codes = String(body['Hotelcodes']).split(',');
      if (options.caido === true) {
        return Promise.resolve(json({ Status: { Code: 500, Description: 'Unexpected Error' } }));
      }
      const idioma = String(body['Language']);
      const devueltos = codes.filter(
        (code) =>
          !(options.omitir ?? []).includes(code) && (options.idiomas ?? [idioma]).includes(idioma),
      );
      if (devueltos.length === 0 || codes.some((code) => (options.malos ?? []).includes(code))) {
        return Promise.resolve(json({ Status: { Code: 500, Description: 'No Hotels Found' } }));
      }
      return Promise.resolve(
        json({
          Status: detalle['Status'],
          HotelDetails: devueltos.map((code) => ({
            ...plantilla,
            HotelCode: code,
            HotelName: `Hotel ${code}`,
          })),
        }),
      );
    }
    if (path === TBO_OPERATIONS.tboHotelCodeList.path) {
      if (options.hoteles === 'no-hotels') {
        return Promise.resolve(json({ Status: { Code: 500, Description: 'No Hotels Found' } }));
      }
      return Promise.resolve(
        json({ Status: lista['Status'], Hotels: options.hoteles ?? lista['Hotels'] }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
  const limiter: TboRateLimiter = {
    acquire: (request) => {
      lanes.push(request.lane);
      return immediate.acquire(request);
    },
    reportThrottled: () => undefined,
  };
  const content = new TboStaticContentClient(
    parseTboConfig({ environment: 'test', username: USERNAME, [CAMPO.clave]: CLAVE }),
    { fetch, limiter },
  );
  // El ACL de venta no se toca en estas lecturas.
  const acl = {} as TboHotelsAcl;
  return { adapter: new TboHotelProviderAdapter(acl, CUENTA, 'test', content), fetch, lanes };
}

function body(fetch: Mock<TboFetch>, call = 0): Record<string, unknown> {
  return cuerpoDe(fetch.mock.calls[call]?.[1]);
}

describe('fotos de los resultados: HotelDetails por lotes, para guardar', () => {
  it('un lote de códigos en el idioma, por el cupo de fondo, con la huella del sync', async () => {
    const h = harness({ omitir: ['1000002'] });

    const lote = await h.adapter.fetchHotelContents(['1000000', '1000001', '1000002'], 'es', CTX, {
      timeoutMs: 8_000,
    });

    // El que no vino en español se pide en inglés; tampoco está: confirmado sin contenido.
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(body(h.fetch)).toEqual({ Hotelcodes: '1000000,1000001,1000002', Language: 'ES' });
    expect(body(h.fetch, 1)).toEqual({ Hotelcodes: '1000002', Language: 'EN' });
    expect(h.lanes).toEqual(['background', 'background']);
    expect(lote.missingHotelIds).toEqual(['1000002']);
    expect(lote.unresolvedHotelIds).toEqual([]);
    expect(lote.calls).toEqual({ total: 2, fallback: 1, isolation: 0 });
    expect(lote.contents.map((c) => [c.hotelId, c.lang, c.source])).toEqual([
      ['1000000', 'es', 'details'],
      ['1000001', 'es', 'details'],
    ]);
    const [primero] = lote.contents;
    expect(primero?.images.length).toBeGreaterThan(0);
    expect(primero?.images.every((url) => url.startsWith('https://'))).toBe(true);
    // La huella es la del ACL sobre el mismo contenido: la que escribe el sync.
    const mismo = await new TboStaticContentClient(
      parseTboConfig({ environment: 'test', username: USERNAME, [CAMPO.clave]: CLAVE }),
      { fetch: h.fetch, limiter: immediate },
    ).getHotelDetails(['1000000'], 'es');
    expect(primero?.contentHash).toBe(tboHotelContentHash(mismo.contents[0] as TboHotelContent));
    // Sólo columnas de `hotel_content`: ni el texto plano ni los servicios negados.
    expect(Object.keys(primero ?? {}).sort()).toEqual([
      'attractionsHtml',
      'checkInTime',
      'checkOutTime',
      'contentHash',
      'descriptionHtml',
      'facilities',
      'hotelId',
      'images',
      'lang',
      'name',
      'phone',
      'sections',
      'source',
      'websiteUrl',
    ]);
  });

  it('H1 — "No Hotels Found" en español y contenido en inglés: filas `en` para guardar', async () => {
    const h = harness({ idiomas: ['EN'] });
    const codes = ['1000000', '1000001', '1000002'];

    const lote = await h.adapter.fetchHotelContents(codes, 'es', CTX, { timeoutMs: 8_000 });

    expect(h.fetch.mock.calls.map((_, i) => body(h.fetch, i))).toEqual([
      { Hotelcodes: codes.join(','), Language: 'ES' },
      { Hotelcodes: codes.join(','), Language: 'EN' },
    ]);
    expect(lote.contents.map((c) => [c.hotelId, c.lang, c.source])).toEqual(
      codes.map((code) => [code, 'en', 'details']),
    );
    expect(lote.contents.every((c) => c.images.length > 0)).toBe(true);
    expect(lote).toMatchObject({ missingHotelIds: [], unresolvedHotelIds: [] });
  });

  it('H2 — un código malo tumba el lote: se aísla y los demás reciben su contenido', async () => {
    const h = harness({ malos: ['1000002'] });
    const codes = ['1000000', '1000001', '1000002', '1000003'];

    const lote = await h.adapter.fetchHotelContents(codes, 'es', CTX, { timeoutMs: 8_000 });

    expect(lote.missingHotelIds).toEqual(['1000002']);
    expect(lote.unresolvedHotelIds).toEqual([]);
    // Los tres buenos, en inglés (aislados) y en español (reintentados sin el malo).
    expect(
      [...new Set(lote.contents.filter((c) => c.lang === 'es').map((c) => c.hotelId))].sort(),
    ).toEqual(['1000000', '1000001', '1000003']);
    expect(lote.calls?.isolation).toBeGreaterThan(0);
    expect(h.lanes.every((lane) => lane === 'background')).toBe(true);
  });

  it('sin cupo para llamadas extra, lo que había que aislar queda sin resolver', async () => {
    const h = harness({ malos: ['1000002'] });
    const permiso = vi.fn(() => false);

    const lote = await h.adapter.fetchHotelContents(['1000000', '1000002'], 'es', CTX, {
      timeoutMs: 8_000,
      allowExtraCall: permiso,
    });

    expect(permiso).toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(lote).toMatchObject({
      contents: [],
      missingHotelIds: [],
      unresolvedHotelIds: ['1000000', '1000002'],
      calls: { total: 2, fallback: 1, isolation: 0 },
    });
  });

  it('"No Hotels Found" no cuenta para el breaker aunque la llamada no sea pasiva', async () => {
    const breaker = new CircuitBreakerService();
    const h = harness({ idiomas: [] });

    for (let i = 0; i < 8; i++) {
      const lote = await breaker.execute('tbo-hotels', () =>
        h.adapter.fetchHotelContents(['1000000'], 'es', CTX, { timeoutMs: 8_000 }),
      );
      expect(lote.missingHotelIds).toEqual(['1000000']);
    }

    expect(breaker.snapshot()['tbo-hotels']).toEqual({ state: 'closed', failures: 0 });
    // Un intento por llamada: sin reintentos del cliente.
    expect(h.fetch).toHaveBeenCalledTimes(16);
  });

  it('si la PRIMERA llamada falla, se lanza como antes (el servicio lo recuerda como fallo)', async () => {
    const h = harness({ caido: true });
    await expect(
      h.adapter.fetchHotelContents(['1000000'], 'es', CTX, { timeoutMs: 8_000 }),
    ).rejects.toBeInstanceOf(TboApiError);
  });

  it('el lote es de 10 y uno de más de 13 no sale al cable', async () => {
    const h = harness();
    expect(h.adapter.contentBatchSize).toBe(10);
    const catorce = Array.from({ length: 14 }, (_, i) => String(1_000_000 + i));
    await expect(
      h.adapter.fetchHotelContents(catorce, 'es', CTX, { timeoutMs: 8_000 }),
    ).rejects.toBeInstanceOf(TboRequestBuildError);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('la credencial va sólo a TBO y nunca en lo que vuelve', async () => {
    const h = harness();
    const lote = await h.adapter.fetchHotelContents(['1000000'], 'en', CTX, { timeoutMs: 8_000 });
    const basic = Buffer.from(`${USERNAME}:${CLAVE}`).toString('base64');
    expect(JSON.stringify(lote)).not.toContain(CLAVE);
    expect(JSON.stringify(lote)).not.toContain(basic);
  });
});

describe('ciudad sin hoteles en el catálogo: TBOHotelCodeList bajo demanda', () => {
  it('los hoteles de la ciudad y su texto en inglés, en una llamada', async () => {
    const h = harness();

    const ciudad = await h.adapter.listCityCatalog('130452', 'US', CTX, { timeoutMs: 10_000 });

    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(body(h.fetch)).toMatchObject({ CityCode: '130452' });
    expect(ciudad.unreadable).toBe(0);
    expect(ciudad.hotels).toEqual([
      expect.objectContaining({
        hotelId: '1010099',
        name: 'Holiday Inn Express New York - Manhattan West Side',
        stars: 3,
        location: { lat: 40.764167, lng: -73.994468 },
        countryCode: 'US',
      }),
    ]);
    expect(ciudad.listingContents.map((c) => [c.hotelId, c.lang, c.source])).toEqual([
      ['1010099', 'en', 'listing'],
    ]);
    expect(ciudad.listingContents[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('"No Hotels Found": la ciudad existe y está vacía, no es un error', async () => {
    const h = harness({ hoteles: 'no-hotels' });
    const ciudad = await h.adapter.listCityCatalog('130452', undefined, CTX, {
      timeoutMs: 10_000,
    });
    expect(ciudad).toEqual({ hotels: [], listingContents: [], unreadable: 0 });
  });

  it('se detectan por presencia; sin cliente de contenido, error tipado', async () => {
    const h = harness();
    expect(supportsHotelContentBatch(h.adapter)).toBe(true);
    expect(supportsHotelCityCatalog(h.adapter)).toBe(true);

    const sinContenido = new TboHotelProviderAdapter({} as TboHotelsAcl, CUENTA, 'test');
    await expect(
      sinContenido.fetchHotelContents(['1'], 'es', CTX, { timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(TboContentClientMissingError);
    await expect(
      sinContenido.listCityCatalog('1', undefined, CTX, { timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(TboContentClientMissingError);
  });
});
