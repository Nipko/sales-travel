import { Logger } from '@nestjs/common';
import type { SearchContext } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelContentBatch,
  HotelContentFetchOptions,
  HotelContentLanguage,
  HotelContentRecord,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import {
  fakeHotelsDb,
  type CatalogoBajoDemanda,
  type FilaFoto,
} from './__fixtures__/fake-hotels-db.js';
import { HotelCatalogStore } from './hotel-catalog.store.js';
import {
  HOTEL_CONTENT_BATCH_CACHE_TTL_S,
  HOTEL_CONTENT_BATCH_FETCH_TIMEOUT_MS,
  HOTEL_CONTENT_BATCH_MAX_FETCH,
  HOTEL_CONTENT_BATCH_RETRY_AFTER_MS,
  HOTEL_CONTENT_BATCH_WAIT_MS,
  HotelContentService,
} from './hotel-content.service.js';
import { HOTEL_IMAGE_PROXY_PATH } from './hotel-image-proxy.js';

/**
 * Fotos de los resultados por lote (estrategia de fotos del 2026-09-29): lo que el catálogo tiene
 * sale al instante, lo que falta se le pide al proveedor en lotes, se GUARDA y se devuelve, y nada
 * bloquea la búsqueda. La base es la de mentira de hoteles con el compilador real de Postgres; el
 * proveedor, el stub anónimo con `fetchHotelContents` espiable y su propio dominio de fotos.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROVEEDOR = 'stub-hotels';
const OTRO = 'otro-hotels';
const HOST = 'img.example';

type FetchContents = Mock<
  (
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    ctx: SearchContext,
    options: HotelContentFetchOptions,
  ) => Promise<HotelContentBatch>
>;

function registro(hotelId: string, lang: HotelContentLanguage = 'es'): HotelContentRecord {
  return {
    hotelId,
    lang,
    source: 'details',
    name: `Hotel ${hotelId}`,
    descriptionHtml: '<p>Cerca del centro</p>',
    sections: [],
    facilities: ['Piscina'],
    attractionsHtml: null,
    images: [`https://${HOST}/${hotelId}/1.jpg`, `https://${HOST}/${hotelId}/2.jpg`],
    phone: null,
    websiteUrl: null,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    contentHash: 'a'.repeat(64),
  };
}

/** Responde el contenido de lo que se pidió, salvo `sinContenido`. */
function proveedorQueResponde(sinContenido: readonly string[] = []): FetchContents {
  return vi.fn((ids, lang) =>
    Promise.resolve({
      contents: ids.filter((id) => !sinContenido.includes(id)).map((id) => registro(id, lang)),
      missingHotelIds: ids.filter((id) => sinContenido.includes(id)),
    }),
  );
}

function foto(wantHotel: string, providerCode = PROVEEDOR, url?: string): FilaFoto {
  return {
    want_provider: PROVEEDOR,
    want_hotel: wantHotel,
    provider_code: providerCode,
    image_count: 2,
    first_images: [url ?? `https://${HOST}/${wantHotel}/1.jpg`],
  };
}

function clave(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

interface Banco {
  service: HotelContentService;
  registry: ReturnType<typeof hotelRegistry>;
  db: ReturnType<typeof fakeHotelsDb>;
  breaker: CircuitBreakerService;
  cache: MemoryCacheAdapter;
  fetchContents: FetchContents;
  /** Fotos guardadas: lo que la base devuelve en la próxima lectura de fotos. */
  guardadas: FilaFoto[];
}

interface BancoOpts {
  fetchContents?: FetchContents;
  /** Lo que la base sabe de cada hotel (por id): por defecto, en el catálogo y sin detalle. */
  estado?: Record<string, { in_catalog: boolean; has_details: boolean }>;
  fotos?: FilaFoto[];
  flag?: boolean;
  bajo?: Partial<CatalogoBajoDemanda>;
}

function banco(ids: readonly string[], opts: BancoOpts = {}): Banco {
  const fetchContents = opts.fetchContents ?? proveedorQueResponde();
  const factory = new StubHotelProviderFactory({
    code: PROVEEDOR,
    callPolicy: 'opt-in',
    searchProfile: { idSpace: 'provider', contentFromCatalog: true, imageHosts: [HOST] },
  });
  const adapter = factory.adapterFor(TENANT);
  Object.assign(adapter, { fetchHotelContents: fetchContents, contentBatchSize: 10 });
  vi.spyOn(factory, 'adapterFor').mockReturnValue(adapter);
  const otro = new StubHotelProviderFactory({
    code: OTRO,
    searchProfile: { idSpace: 'platform', imageHosts: ['cdn.otro.example'] },
  });
  const registry = hotelRegistry(
    [factory, otro],
    hotelFlags((_tenant, code) => code !== PROVEEDOR || (opts.flag ?? true)),
  );

  const guardadas: FilaFoto[] = [...(opts.fotos ?? [])];
  const estado: Record<string, { in_catalog: boolean; has_details: boolean }> = {};
  for (const id of ids) {
    estado[`${PROVEEDOR} ${id}`] = opts.estado?.[id] ?? { in_catalog: true, has_details: false };
  }
  // Lo que se guarda aparece en la próxima lectura de fotos, como en Postgres.
  const db = fakeHotelsDb({
    catalogoBajoDemanda: {
      fotos: () => guardadas,
      estado,
      alGuardar: (provider, filas) => {
        for (const fila of filas) {
          estado[`${provider} ${String(fila['hotelId'])}`] = {
            in_catalog: true,
            has_details: true,
          };
          const images = fila['images'] as string[];
          if (images.length > 0) {
            guardadas.push({ ...foto(String(fila['hotelId'])), first_images: [...images] });
          }
        }
      },
      ...opts.bajo,
    },
  });
  const breaker = new CircuitBreakerService();
  const cache = new MemoryCacheAdapter();
  const service = new HotelContentService(registry, db.service, breaker, cache);
  return { service, registry, db, breaker, cache, fetchContents, guardadas };
}

function pedir(b: Banco, ids: readonly string[], providerCode = PROVEEDOR) {
  return b.service.getContentBatch(TENANT, {
    lang: 'es',
    hotels: ids.map((hotelId) => ({ providerCode, hotelId })),
  });
}

const ids = (n: number, desde = 1): string[] =>
  Array.from({ length: n }, (_, i) => String(1_000_000 + desde + i));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lo que el catálogo ya tiene sale al instante', () => {
  it('foto guardada → `ready` con la URL del proxy propio, sin llamar al proveedor', async () => {
    const b = banco(['H1'], { fotos: [foto('H1')] });

    const res = await pedir(b, ['H1']);

    expect(res).toEqual({
      lang: 'es',
      items: [
        {
          providerCode: PROVEEDOR,
          hotelId: 'H1',
          status: 'ready',
          mainImage: { url: `${HOTEL_IMAGE_PROXY_PATH}${clave(`https://${HOST}/H1/1.jpg`)}` },
          imageCount: 2,
        },
      ],
    });
    expect(b.fetchContents).not.toHaveBeenCalled();
    expect(b.db.consultasMarcadas('store-contents')).toEqual([]);
  });

  it('con varios proveedores, la foto del MISMO hotel en otro (equivalencia aceptada)', async () => {
    const b = banco(['H1'], {
      fotos: [foto('H1', OTRO, 'https://cdn.otro.example/h1.jpg')],
    });

    const [item] = (await pedir(b, ['H1'])).items;

    expect(item?.mainImage?.url).toBe(
      `${HOTEL_IMAGE_PROXY_PATH}${clave('https://cdn.otro.example/h1.jpg')}`,
    );
    expect(b.fetchContents).not.toHaveBeenCalled();
    // La consulta busca las equivalencias aceptadas del hotel pedido.
    const [consulta] = b.db.consultasMarcadas('main-images');
    expect(consulta?.sql).toContain("own.status = 'accepted'");
    expect(consulta?.sql).toContain("other.status = 'accepted'");
  });

  it('una foto de un dominio que no es del proveedor no sale: se prueba la siguiente', async () => {
    const b = banco(['H1'], {
      fotos: [
        {
          ...foto('H1'),
          first_images: [
            'https://evil.example/x.jpg',
            `http://${HOST}/inseguro.jpg`,
            `https://${HOST}/ok.jpg`,
          ],
        },
      ],
    });
    const [item] = (await pedir(b, ['H1'])).items;
    expect(item?.mainImage?.url).toBe(
      `${HOTEL_IMAGE_PROXY_PATH}${clave(`https://${HOST}/ok.jpg`)}`,
    );
  });
});

describe('lo que falta se pide en lotes, se guarda y se devuelve', () => {
  it('lotes de 10 en el idioma pedido, pasivos para el circuito, y lo guardado sale `ready`', async () => {
    const pedidos = ids(12);
    const b = banco(pedidos);
    const execute = vi.spyOn(b.breaker, 'execute');

    const res = await pedir(b, pedidos);

    expect(b.fetchContents.mock.calls.map((c) => [c[0].length, c[1]])).toEqual([
      [10, 'es'],
      [2, 'es'],
    ]);
    expect(b.fetchContents.mock.calls[0]?.[3]).toMatchObject({
      timeoutMs: HOTEL_CONTENT_BATCH_FETCH_TIMEOUT_MS,
    });
    expect(execute.mock.calls.every((c) => c[2]?.passive === true && c[2]?.scope === 'sales')).toBe(
      true,
    );
    // Guardado por la función de 0054, con las filas del proveedor tal cual (huella incluida).
    const guardar = b.db.consultasMarcadas('store-contents');
    expect(guardar).toHaveLength(2);
    expect(guardar[0]?.parameters[0]).toBe(PROVEEDOR);
    const filas = JSON.parse(String(guardar[0]?.parameters[1])) as HotelContentRecord[];
    expect(filas).toHaveLength(10);
    expect(filas[0]).toEqual(registro(pedidos[0] as string));
    expect(res.items.every((i) => i.status === 'ready')).toBe(true);
    expect(res.retryAfterMs).toBeUndefined();
  });

  it('sólo hoteles del catálogo del proveedor, sin detalle todavía: el resto sale `none`', async () => {
    const b = banco(['H1', 'H2', 'H3'], {
      estado: {
        H2: { in_catalog: false, has_details: false },
        H3: { in_catalog: true, has_details: true },
      },
    });

    const res = await pedir(b, ['H1', 'H2', 'H3']);

    expect(b.fetchContents.mock.calls.map((c) => c[0])).toEqual([['H1']]);
    expect(res.items.map((i) => [i.hotelId, i.status])).toEqual([
      ['H1', 'ready'],
      ['H2', 'none'],
      ['H3', 'none'],
    ]);
  });

  it('el mismo hotel dos veces se responde una; sólo proveedores desconocidos, ni se consulta', async () => {
    const b = banco(['H1'], { fotos: [foto('H1')] });
    const res = await pedir(b, ['H1', 'H1']);
    expect(res.items).toHaveLength(1);

    const nadie = await b.service.getContentBatch(TENANT, {
      lang: 'es',
      hotels: [{ providerCode: 'nadie-hotels', hotelId: '1' }],
    });
    expect(nadie.items.map((i) => i.status)).toEqual(['none']);
  });

  it('una fila rota o de un proveedor desconocido no da foto', async () => {
    const b = banco(['H1', 'H2'], {
      estado: {
        H1: { in_catalog: true, has_details: true },
        H2: { in_catalog: true, has_details: true },
      },
      fotos: [
        { ...foto('H1'), first_images: null as unknown as unknown[] },
        foto('H2', 'nadie-hotels'),
      ],
    });
    expect((await pedir(b, ['H1', 'H2'])).items.map((i) => i.status)).toEqual(['none', 'none']);
  });

  it('un proveedor cuyo contenido no sale del catálogo, o desconocido, no se pide', async () => {
    const b = banco([]);
    const res = await b.service.getContentBatch(TENANT, {
      lang: 'es',
      hotels: [
        { providerCode: OTRO, hotelId: '101' },
        { providerCode: 'nadie-hotels', hotelId: '1' },
      ],
    });
    expect(res.items.map((i) => i.status)).toEqual(['none', 'none']);
    expect(b.fetchContents).not.toHaveBeenCalled();
    expect(b.db.consultasMarcadas('content-state')).toEqual([]);
  });

  it('a lo sumo dos lotes por petición: el resto sale `pending` con cuándo volver', async () => {
    const pedidos = ids(24);
    const b = banco(pedidos);

    const res = await pedir(b, pedidos);

    expect(b.fetchContents.mock.calls.flatMap((c) => c[0])).toHaveLength(
      HOTEL_CONTENT_BATCH_MAX_FETCH,
    );
    expect(res.items.filter((i) => i.status === 'pending')).toHaveLength(4);
    expect(res.retryAfterMs).toBe(HOTEL_CONTENT_BATCH_RETRY_AFTER_MS);
  });

  it('lo que el proveedor no devuelve queda `none` y no se vuelve a pedir por un rato', async () => {
    const b = banco(['H1', 'H2'], { fetchContents: proveedorQueResponde(['H2']) });

    expect((await pedir(b, ['H1', 'H2'])).items.map((i) => i.status)).toEqual(['ready', 'none']);
    expect(await b.cache.get('hotels:content-batch:stub-hotels:H2:es')).toBe('empty');

    await pedir(b, ['H2']);
    expect(b.fetchContents).toHaveBeenCalledTimes(1);
  });

  it('sólo guarda lo pedido y en el idioma pedido', async () => {
    const fetchContents: FetchContents = vi.fn(() =>
      Promise.resolve({
        contents: [registro('H1'), registro('INTRUSO'), registro('H1', 'en')],
        missingHotelIds: [],
      }),
    );
    const b = banco(['H1'], { fetchContents });

    await pedir(b, ['H1']);

    const filas = JSON.parse(
      String(b.db.consultasMarcadas('store-contents')[0]?.parameters[1]),
    ) as HotelContentRecord[];
    expect(filas.map((f) => [f.hotelId, f.lang])).toEqual([['H1', 'es']]);
  });
});

describe('nunca bloquea ni tumba la respuesta', () => {
  it('un lote que tarda más que la espera sale `pending`, y lo que trae se guarda igual', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let responder: (batch: HotelContentBatch) => void = () => undefined;
    const fetchContents: FetchContents = vi.fn(
      () => new Promise<HotelContentBatch>((resolve) => (responder = resolve)),
    );
    const b = banco(['H1'], { fetchContents });

    const pendiente = pedir(b, ['H1']);
    await vi.advanceTimersByTimeAsync(HOTEL_CONTENT_BATCH_WAIT_MS);
    const res = await pendiente;

    expect(res.items[0]?.status).toBe('pending');
    expect(res.retryAfterMs).toBe(HOTEL_CONTENT_BATCH_RETRY_AFTER_MS);

    // Otra pantalla pide el mismo hotel mientras sigue en vuelo: espera ESE lote, no pide otro.
    const segunda = pedir(b, ['H1']);
    await vi.advanceTimersByTimeAsync(0);
    responder({ contents: [registro('H1')], missingHotelIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    const res2 = await segunda;
    expect(b.fetchContents).toHaveBeenCalledTimes(1);
    expect(b.db.consultasMarcadas('store-contents')).toHaveLength(1);
    expect(res2.items[0]?.status).toBe('ready');
  });

  it('un lote que falla deja sus hoteles `none`, lo recuerda poco y no se lleva a los demás', async () => {
    const fetchContents: FetchContents = vi.fn((hotelIds) =>
      hotelIds.includes('1000001')
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve({ contents: hotelIds.map((id) => registro(id)), missingHotelIds: [] }),
    );
    const pedidos = ids(11);
    const b = banco(pedidos, { fetchContents });

    const res = await pedir(b, pedidos);

    expect(res.items.filter((i) => i.status === 'none')).toHaveLength(10);
    expect(res.items.find((i) => i.hotelId === '1000011')?.status).toBe('ready');
    expect(await b.cache.get('hotels:content-batch:stub-hotels:1000001:es')).toBe('failed');
    expect(HOTEL_CONTENT_BATCH_CACHE_TTL_S.failed).toBeLessThan(
      HOTEL_CONTENT_BATCH_CACHE_TTL_S.empty,
    );
    // En el log, sólo códigos y conteos.
    const lineas = warn.mock.calls.map((c) => String(c[0]));
    expect(lineas.some((l) => l.includes('hotels.content_batch.lote_fallo'))).toBe(true);
    expect(lineas.join('\n')).not.toContain('1000001');
  });

  it('con el proveedor apagado por kill-switch no sale nada y no se recuerda como fallo', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', PROVEEDOR);
    const b = banco(['H1']);

    const res = await pedir(b, ['H1']);

    expect(res.items[0]?.status).toBe('none');
    expect(b.fetchContents).not.toHaveBeenCalled();
    expect(await b.cache.get('hotels:content-batch:stub-hotels:H1:es')).toBeNull();
    vi.unstubAllEnvs();
  });

  it('con el proveedor apagado para la agencia (`opt-in`) no se le pide nada', async () => {
    const b = banco(['H1'], { flag: false });
    expect((await pedir(b, ['H1'])).items[0]?.status).toBe('none');
    expect(b.fetchContents).not.toHaveBeenCalled();
  });

  it('un proveedor que no se puede resolver deja sus hoteles `none` y lo dice por clase', async () => {
    const b = banco(['H1']);
    vi.spyOn(b.registry, 'byCodeForSale').mockRejectedValue(new TypeError('bóveda caída'));

    const res = await pedir(b, ['H1']);

    expect(res.items[0]?.status).toBe('none');
    expect(b.fetchContents).not.toHaveBeenCalled();
    const lineas = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lineas).toContain('hotels.content_batch.proveedor_no_resuelto');
    expect(lineas).toContain('error=TypeError');
    expect(lineas).not.toContain('bóveda caída');
  });

  it('un adapter sin el puerto de contenido por lote no se llama', async () => {
    const b = banco(['H1']);
    const resuelto = await b.registry.byCodeForSale(TENANT, PROVEEDOR);
    const { fetchHotelContents: _sin, ...sinPuerto } = resuelto.adapter as unknown as Record<
      string,
      unknown
    >;
    vi.spyOn(b.registry, 'byCodeForSale').mockResolvedValue({
      ...resuelto,
      adapter: sinPuerto as unknown as typeof resuelto.adapter,
    });

    expect((await pedir(b, ['H1'])).items[0]?.status).toBe('none');
    expect(b.fetchContents).not.toHaveBeenCalled();
  });

  it('filas que la base rechaza (HTML o fotos fuera de contrato) se cuentan en el log', async () => {
    const b = banco(['H1'], { bajo: { rechazadas: 1 } });
    await pedir(b, ['H1']);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.content_batch.filas_rechazadas',
    );
  });

  it('un hotel cuya fila la base rechazó se recuerda sin contenido: no se vuelve a pedir', async () => {
    // La base rechaza la fila: el hotel sigue sin `details` (no se marca como guardado).
    const b = banco(['H1'], { bajo: { rechazadas: 1, alGuardar: () => undefined } });
    const res = await pedir(b, ['H1']);

    expect(res.items[0]?.status).toBe('none');
    expect(await b.cache.get('hotels:content-batch:stub-hotels:H1:es')).toBe('empty');
    await pedir(b, ['H1']);
    expect(b.fetchContents).toHaveBeenCalledTimes(1);
  });

  it('si después de un rechazo no se puede leer el estado, el plazo corto de un fallo', async () => {
    // La primera lectura del estado (qué pedir) es la de verdad; la de después de guardar falla.
    const estado = vi.spyOn(HotelCatalogStore.prototype, 'contentState');
    const fetchContents: FetchContents = vi.fn((hotelIds, lang) => {
      estado.mockRejectedValue(new Error('db caída'));
      return Promise.resolve({
        contents: hotelIds.map((id) => registro(id, lang)),
        missingHotelIds: [],
      });
    });
    const b = banco(['H1'], {
      fetchContents,
      bajo: { rechazadas: 1, alGuardar: () => undefined },
    });

    const res = await pedir(b, ['H1']);

    expect(res.items[0]?.status).toBe('none');
    expect(await b.cache.get('hotels:content-batch:stub-hotels:H1:es')).toBe('failed');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'hotels.content_batch.estado_no_disponible',
    );
  });

  it('si guardar falla, sus hoteles quedan `none` y la respuesta sale igual', async () => {
    const b = banco(['H1'], { bajo: { fallan: { 'store-contents': new Error('db caída') } } });
    const res = await pedir(b, ['H1']);
    expect(res.items[0]?.status).toBe('none');
    expect(await b.cache.get('hotels:content-batch:stub-hotels:H1:es')).toBe('failed');
  });
});
