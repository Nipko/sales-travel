import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NotFoundException } from '@nestjs/common';
import { TBO_BASE_URLS, type TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TenantType } from '../database/database.types.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import {
  StubHotelProviderFactory,
  type StubHotelFactoryOptions,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelContentFetchOptions,
  HotelContentLanguage,
  HotelProviderContent,
  HotelProviderFactory,
} from '../providers/hotel-provider.types.js';
import type { SearchContext } from '@sales-travel/domain';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import {
  fakeDespegarFactory,
  FakeDespegarHotelsAdapter,
  hotelFlags,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import {
  fakeHotelsDb,
  type FakeHotelsDbOptions,
  type FilaContenido,
} from './__fixtures__/fake-hotels-db.js';
import {
  HOTEL_CONTENT_CACHE_TTL_S,
  HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS,
  HotelContentService,
  isAllowlistedHtml,
  type HotelContentView,
} from './hotel-content.service.js';
import { UnknownHotelProviderError } from './hotel-provider-errors.js';

/**
 * Ficha de un hotel (docs/tbo/09 PR-3.6; 05 §4 y §6.3; 08 RF-32 y RNF-16).
 *
 * Criterio de salida del plan: sólo HTML saneado e imágenes `https`; sin contenido, la ficha sale
 * sin imágenes y no es un error. Más lo que el diseño exige alrededor: respaldo en inglés, lectura
 * bajo demanda con plazo corto, por el circuito y con caché, y ninguna escritura en las tablas del
 * catálogo.
 *
 * La base es la de mentira de hoteles con el compilador REAL de Postgres: lo que se afirma del SQL
 * es lo que recibiría Postgres. El proveedor de contenido es el stub anónimo con un
 * `fetchHotelContent` espiable; el último bloque usa el factory, el ACL y el saneador REALES de TBO
 * con un `fetch` que responde el ejemplo de HotelDetails de p. 59.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '22222222-2222-4222-8222-222222222222';
const CONTENIDO = 'stub-hotels';
const HOTEL = '1000000';

const DESCRIPCION =
  '<p>HeadLine : Cerca del museo</p><p>Location : En el centro &amp; a 5 min</p><br><b>Aviso</b>';
const IMAGEN = 'https://img.example/hotel/1.jpg';

/** Contenido de detalle en español, tal como lo escribe el sync. */
const DETALLE_ES: FilaContenido = {
  lang: 'es',
  source: 'details',
  name: 'Hotel Catarata',
  description_html: DESCRIPCION,
  sections: [
    { label: 'HeadLine', text: 'Cerca del museo' },
    { label: 'Location', text: 'En el centro & a 5 min' },
  ],
  facilities: ['Piscina', 'WiFi gratis'],
  attractions_html: '<ul><li>Museo - 0,4 km</li></ul>',
  images: [IMAGEN],
  phone: '+20972316000',
  website_url: 'https://hotel.example/',
  check_in_time: '15:00:00',
  check_out_time: '12:00:00',
};

const DETALLE_EN: FilaContenido = {
  ...DETALLE_ES,
  lang: 'en',
  name: 'Cataract Hotel',
  sections: [{ label: 'HeadLine', text: 'Near the museum' }],
  facilities: ['Pool'],
};

/** El texto del listado de ciudad: inglés, sin imágenes ni horarios. */
const LISTADO_EN: FilaContenido = {
  lang: 'en',
  source: 'listing',
  name: 'Cataract Hotel',
  description_html: '<p>HeadLine : Near the museum</p>',
  sections: [{ label: 'HeadLine', text: 'Near the museum' }],
  facilities: ['Pool'],
  images: [],
};

/** Lo que responde el proveedor en el momento, ya neutral y saneado por su ACL. */
function delProveedor(lang: HotelContentLanguage = 'es'): HotelProviderContent {
  return {
    hotelId: HOTEL,
    lang,
    name: 'Hotel Catarata (proveedor)',
    stars: 5,
    address: 'Abtal El Tahrir Street, Aswan',
    zipcode: '81511',
    countryCode: 'EG',
    location: { lat: 24.08166, lng: 32.88985 },
    descriptionHtml: '<p>HeadLine : Cerca del museo</p>',
    sections: [{ label: 'HeadLine', text: 'Cerca del museo' }],
    facilities: ['Biblioteca'],
    attractionsHtml: null,
    images: ['https://img.example/hotel/od.jpg'],
    phone: null,
    websiteUrl: null,
    checkInTime: '15:00',
    checkOutTime: '12:00',
  };
}

type FetchContent = Mock<
  (
    hotelId: string,
    lang: HotelContentLanguage,
    ctx: SearchContext,
    options: HotelContentFetchOptions,
  ) => Promise<HotelProviderContent | null>
>;

interface Banco {
  service: HotelContentService;
  db: ReturnType<typeof fakeHotelsDb>;
  factory: StubHotelProviderFactory;
  despegar: ReturnType<typeof fakeDespegarFactory>;
  breaker: CircuitBreakerService;
  cache: MemoryCacheAdapter;
  /** El `fetchHotelContent` del adapter del proveedor de contenido, igual para todo tenant. */
  fetchContent: FetchContent;
}

interface BancoOpts {
  db?: FakeHotelsDbOptions;
  factory?: StubHotelFactoryOptions;
  /** `opt-in` encendido para el proveedor de contenido; por defecto sí. */
  flag?: boolean;
  fetchContent?: FetchContent;
}

/** Contenido de `hotel_content` del proveedor de contenido para {@link HOTEL}. */
function contenidos(...filas: FilaContenido[]): FakeHotelsDbOptions['contenidos'] {
  return { [CONTENIDO]: { [HOTEL]: filas } };
}

function banco(opts: BancoOpts = {}): Banco {
  const fetchContent: FetchContent =
    opts.fetchContent ?? vi.fn(() => Promise.resolve<HotelProviderContent | null>(delProveedor()));
  const factory = new StubHotelProviderFactory({
    code: CONTENIDO,
    callPolicy: 'opt-in',
    searchProfile: { idSpace: 'provider', contentFromCatalog: true },
    ...opts.factory,
  });
  // Un solo adapter para todos los tenants, con el puerto de contenido por presencia.
  const adapter = factory.adapterFor(TENANT);
  Object.assign(adapter, { fetchHotelContent: fetchContent });
  vi.spyOn(factory, 'adapterFor').mockReturnValue(adapter);

  const despegar = fakeDespegarFactory(new FakeDespegarHotelsAdapter());
  const registry = hotelRegistry(
    [despegar.factory, factory],
    hotelFlags((_tenant, code) => code === CONTENIDO && (opts.flag ?? true)),
  );
  // El hotel está en el catálogo del proveedor salvo que el caso diga otra cosa: sólo por un
  // hotel conocido se sale al proveedor.
  const db = fakeHotelsDb({ fichas: { [CONTENIDO]: { [HOTEL]: {} } }, ...opts.db });
  const breaker = new CircuitBreakerService();
  const cache = new MemoryCacheAdapter();
  const service = new HotelContentService(registry, db.service, breaker, cache);
  return { service, db, factory, despegar, breaker, cache, fetchContent };
}

function pedir(
  b: Banco,
  lang: HotelContentLanguage = 'es',
  providerCode = CONTENIDO,
  tenantId = TENANT,
): Promise<HotelContentView> {
  return b.service.getContent(tenantId, { providerCode, hotelId: HOTEL, lang });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('catálogo: lee `hotel_content` con respaldo en inglés', () => {
  it('con detalle en el idioma pedido sale del catálogo, en `HH:mm`, sin preguntarle al proveedor', async () => {
    const b = banco({ db: { contenidos: contenidos(DETALLE_ES, DETALLE_EN) } });

    const ficha = await pedir(b, 'es');

    expect(ficha).toEqual({
      providerCode: CONTENIDO,
      hotelId: HOTEL,
      requestedLang: 'es',
      lang: 'es',
      langFallback: false,
      origin: 'catalog',
      name: 'Hotel Catarata',
      stars: null,
      address: null,
      zipcode: null,
      countryCode: null,
      location: null,
      descriptionHtml: DESCRIPCION,
      sections: DETALLE_ES.sections,
      facilities: ['Piscina', 'WiFi gratis'],
      attractionsHtml: '<ul><li>Museo - 0,4 km</li></ul>',
      images: [IMAGEN],
      phone: '+20972316000',
      websiteUrl: 'https://hotel.example/',
      checkInTime: '15:00',
      checkOutTime: '12:00',
    });
    expect(b.fetchContent).not.toHaveBeenCalled();
    expect(b.factory.resolveCalls).toEqual([]);
  });

  it('pide el idioma y el inglés en UNA consulta, del proveedor y el hotel de la ruta', async () => {
    const b = banco({ db: { contenidos: contenidos(DETALLE_ES) } });

    await pedir(b, 'pt');

    const [consulta, ...resto] = b.db.consultasA('hotel_content');
    expect(resto).toEqual([]);
    expect(consulta?.sql).toMatch(
      /^select .* from "hotel_content" where "provider_code" = \$1 and "hotel_id" = \$2 and "lang" in \(\$3, \$4\)$/,
    );
    expect(consulta?.parameters).toEqual([CONTENIDO, HOTEL, 'pt', 'en']);
  });

  it('en inglés no hay respaldo que pedir: una sola lengua en la consulta', async () => {
    const b = banco({ db: { contenidos: contenidos(DETALLE_EN) } });

    const ficha = await pedir(b, 'en');

    expect(b.db.consultasA('hotel_content')[0]?.parameters).toEqual([CONTENIDO, HOTEL, 'en']);
    expect(ficha).toMatchObject({ lang: 'en', origin: 'catalog', name: 'Cataract Hotel' });
  });

  it('sin español y con el proveedor sin responder: sale el inglés, y `lang` lo dice', async () => {
    const b = banco({
      db: { contenidos: contenidos(DETALLE_EN) },
      fetchContent: vi.fn(() => Promise.reject(new Error('timeout'))),
    });

    const ficha = await pedir(b, 'es');

    expect(ficha).toMatchObject({
      requestedLang: 'es',
      lang: 'en',
      langFallback: true,
      origin: 'catalog',
      name: 'Cataract Hotel',
      sections: [{ label: 'HeadLine', text: 'Near the museum' }],
      images: [IMAGEN],
    });
  });

  it('el texto del listado de ciudad (inglés, sin imágenes) también sirve de respaldo', async () => {
    const b = banco({
      db: { contenidos: contenidos(LISTADO_EN) },
      fetchContent: vi.fn(() => Promise.resolve(null)),
    });

    const ficha = await pedir(b, 'pt');

    expect(ficha).toMatchObject({
      requestedLang: 'pt',
      lang: 'en',
      origin: 'catalog',
      descriptionHtml: '<p>HeadLine : Near the museum</p>',
      images: [],
    });
  });

  it('nombre, estrellas, dirección y ubicación son los de `hotel_inventory` del MISMO proveedor', async () => {
    const b = banco({
      db: {
        contenidos: contenidos(DETALLE_ES),
        fichas: {
          [CONTENIDO]: {
            [HOTEL]: {
              name: 'Sofitel Legend Old Cataract',
              stars: '4.5',
              address: 'Abtal El Tahrir Street ',
              latitude: 24.08166,
              longitude: 32.88985,
              zipcode: '81511',
              country_code: 'eg',
            },
          },
        },
      },
    });

    const ficha = await pedir(b, 'es');

    expect(ficha).toMatchObject({
      name: 'Sofitel Legend Old Cataract',
      stars: 4.5,
      address: 'Abtal El Tahrir Street',
      zipcode: '81511',
      countryCode: 'EG',
      location: { lat: 24.08166, lng: 32.88985 },
    });
    const [ficha1] = b.db.consultasDeFichas();
    expect(ficha1?.sql).toMatch(
      /from "hotel_inventory" where "provider_code" = \$1 and "hotel_id" = \$2/,
    );
    // Activo o no: un hotel dado de baja conserva su ficha para vouchers.
    expect(ficha1?.sql).not.toContain('"active"');
  });

  it('nunca escribe: todas las consultas son `select`', async () => {
    const b = banco({ db: { contenidos: contenidos(LISTADO_EN) } });

    await pedir(b, 'es');
    await pedir(b, 'pt');

    expect(b.db.consultas.length).toBeGreaterThan(0);
    expect(b.db.consultas.every((q) => /^select /.test(q.sql))).toBe(true);
  });
});

describe('sin contenido: la ficha sale sin imágenes, no es un error', () => {
  it('con la fila del catálogo: nombre y dirección, sin imágenes ni descripción', async () => {
    const b = banco({
      db: { fichas: { [CONTENIDO]: { [HOTEL]: { name: 'Hotel Sin Fotos', address: 'Calle 1' } } } },
      fetchContent: vi.fn(() => Promise.resolve(null)),
    });

    const ficha = await pedir(b, 'es');

    expect(ficha).toMatchObject({
      origin: 'none',
      lang: null,
      name: 'Hotel Sin Fotos',
      address: 'Calle 1',
      images: [],
      descriptionHtml: null,
      sections: [],
      facilities: [],
    });
  });

  it('sin nada en ninguna tabla ni en el proveedor: todo vacío, igual 200', async () => {
    const b = banco({ fetchContent: vi.fn(() => Promise.resolve(null)) });

    await expect(pedir(b, 'es')).resolves.toEqual({
      providerCode: CONTENIDO,
      hotelId: HOTEL,
      requestedLang: 'es',
      lang: null,
      langFallback: false,
      origin: 'none',
      name: null,
      stars: null,
      address: null,
      zipcode: null,
      countryCode: null,
      location: null,
      descriptionHtml: null,
      sections: [],
      facilities: [],
      attractionsHtml: null,
      images: [],
      phone: null,
      websiteUrl: null,
      checkInTime: null,
      checkOutTime: null,
    });
  });

  it('un proveedor cuya disponibilidad trae el contenido (Despegar) no tiene ficha propia: ni se le resuelve la cuenta', async () => {
    const b = banco();

    const ficha = await pedir(b, 'es', 'despegar-hotels');

    expect(ficha).toMatchObject({ providerCode: 'despegar-hotels', origin: 'none', images: [] });
    expect(b.despegar.resolveForTenant).not.toHaveBeenCalled();
  });

  it('un código que no es un proveedor de hoteles registrado → 404, sin tocar la base', async () => {
    const b = banco();

    const err: unknown = await pedir(b, 'es', 'otro-proveedor').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnknownHotelProviderError);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(b.db.consultas).toEqual([]);
  });
});

describe('RNF-16: sólo HTML de la lista blanca e imágenes `https`', () => {
  it('la gramática de salida del saneador del ACL pasa; cualquier otra etiqueta, atributo o comilla, no', () => {
    expect(isAllowlistedHtml(DESCRIPCION)).toBe(true);
    expect(
      isAllowlistedHtml('<ul><li>Uno &lt;dos&gt; &quot;tres&quot; &#39;cuatro&#39;</li></ul>'),
    ).toBe(true);
    expect(isAllowlistedHtml('texto plano')).toBe(true);
    for (const malo of [
      '<script>alert(1)</script>',
      '<p onclick="x()">hola</p>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<P>mayúscula</P>',
      '<p >espacio</p>',
      'suelto < 3',
      'comilla "cruda"',
      '&copy; entidad sin escapar',
      '<!-- comentario -->',
    ]) {
      expect({ malo, ok: isAllowlistedHtml(malo) }).toEqual({ malo, ok: false });
    }
  });

  it('un HTML fuera de la lista blanca en el catálogo NO sale; el resto de la ficha sí, y se cuenta sin volcarlo', async () => {
    const b = banco({
      db: {
        contenidos: contenidos({
          ...DETALLE_ES,
          description_html: '<p onclick="robar()">Hola</p><script>alert(1)</script>',
          attractions_html: '<ul><li>Museo</li></ul>',
        }),
      },
    });

    const ficha = await pedir(b, 'es');

    expect(ficha.descriptionHtml).toBeNull();
    expect(ficha.attractionsHtml).toBe('<ul><li>Museo</li></ul>');
    expect(ficha.sections).toEqual(DETALLE_ES.sections);
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(`hotels.content.descartado provider=${CONTENIDO}`);
    expect(logueado).toContain('html=1');
    expect(logueado).not.toContain('robar');
    expect(logueado).not.toContain('script');
  });

  it('sólo imágenes `https` absolutas, sin credenciales embebidas, sin repetir; la web sólo `http(s)`', async () => {
    const b = banco({
      db: {
        contenidos: contenidos({
          ...DETALLE_ES,
          images: [
            IMAGEN,
            'http://img.example/hotel/2.jpg',
            'javascript:alert(1)',
            '//img.example/sin-esquema.jpg',
            'https://usuario:clave@img.example/3.jpg',
            'data:image/png;base64,AAAA',
            42,
            IMAGEN,
            'https://img.example/hotel/con espacio.jpg',
            '   ',
            `https://img.example/${'a'.repeat(2_100)}.jpg`,
          ],
          website_url: 'javascript:alert(1)',
        }),
      },
    });

    const ficha = await pedir(b, 'es');

    expect(ficha.images).toEqual([IMAGEN, 'https://img.example/hotel/con%20espacio.jpg']);
    expect(ficha.websiteUrl).toBeNull();
    expect(ficha.images.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('secciones: sólo `{ label, text }` con texto, y como mucho 50', async () => {
    const muchas = Array.from({ length: 60 }, (_, i) => ({ label: `S${i}`, text: `texto ${i}` }));
    const b = banco({
      db: {
        contenidos: contenidos({
          ...DETALLE_ES,
          sections: [
            null,
            'suelta',
            { label: '', text: 'sin etiqueta' },
            { label: 'x' },
            ...muchas,
          ],
          facilities: 'Piscina, WiFi',
        }),
        fichas: { [CONTENIDO]: { [HOTEL]: { address: 'Calle 1', country_code: 'EGY' } } },
      },
    });

    const ficha = await pedir(b, 'es');

    expect(ficha.sections).toEqual(muchas.slice(0, 50));
    expect(ficha.facilities).toEqual([]);
    // Sin nombre en el catálogo, el del contenido; un país que no es ISO2, ninguno.
    expect(ficha).toMatchObject({ name: 'Hotel Catarata', address: 'Calle 1', countryCode: null });
  });

  it('JSONB con otra forma (no lista, elementos que no son texto) no rompe la ficha', async () => {
    const b = banco({
      db: {
        contenidos: contenidos({
          ...DETALLE_ES,
          sections: { label: 'x' },
          facilities: ['Piscina', 3, '  ', null],
          images: 'https://img.example/no-lista.jpg',
          check_in_time: '25:00:00',
        }),
      },
    });

    const ficha = await pedir(b, 'es');

    expect(ficha).toMatchObject({
      sections: [],
      facilities: ['Piscina'],
      images: [],
      checkInTime: null,
      checkOutTime: '12:00',
    });
  });

  it('lo que trae el proveedor en el momento se verifica igual', async () => {
    const b = banco({
      fetchContent: vi.fn(() =>
        Promise.resolve<HotelProviderContent | null>({
          ...delProveedor(),
          descriptionHtml: '<p style="color:red">x</p>',
          images: ['http://img.example/od.jpg', 'https://img.example/ok.jpg'],
        }),
      ),
    });

    const ficha = await pedir(b, 'es');

    expect(ficha.origin).toBe('provider');
    expect(ficha.descriptionHtml).toBeNull();
    expect(ficha.images).toEqual(['https://img.example/ok.jpg']);
  });
});

describe('bajo demanda: UN hotel al proveedor, con plazo corto, por su circuito y con caché', () => {
  it('sin detalle en el idioma pide ese hotel al proveedor con la cuenta de la agencia y un plazo corto', async () => {
    const b = banco({ db: { contenidos: contenidos(LISTADO_EN) } });

    const ficha = await pedir(b, 'es');

    expect(b.factory.resolveCalls).toEqual([TENANT]);
    expect(b.fetchContent).toHaveBeenCalledTimes(1);
    const [hotelId, lang, ctx, options] = b.fetchContent.mock.calls[0] ?? [];
    expect([hotelId, lang, ctx]).toEqual([HOTEL, 'es', { tenantId: TENANT }]);
    expect(options?.timeoutMs).toBe(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS).toBeLessThanOrEqual(10_000);

    expect(ficha).toMatchObject({
      origin: 'provider',
      lang: 'es',
      name: 'Hotel Catarata (proveedor)',
      stars: 5,
      countryCode: 'EG',
      images: ['https://img.example/hotel/od.jpg'],
      checkInTime: '15:00',
    });
  });

  it('el catálogo gana en nombre y dirección: lo del proveedor sólo completa lo que falta', async () => {
    const b = banco({
      db: { fichas: { [CONTENIDO]: { [HOTEL]: { name: 'Nombre del catálogo' } } } },
    });

    const ficha = await pedir(b, 'es');

    expect(ficha.name).toBe('Nombre del catálogo');
    expect(ficha.address).toBe('Abtal El Tahrir Street, Aswan');
  });

  it('lo guarda en la caché: la segunda ficha, aunque sea de otro tenant, no vuelve a salir', async () => {
    const b = banco();
    const guardar = vi.spyOn(b.cache, 'set');

    await pedir(b, 'es');
    const segunda = await pedir(b, 'es', CONTENIDO, OTRO_TENANT);

    expect(b.fetchContent).toHaveBeenCalledTimes(1);
    expect(segunda.origin).toBe('provider');
    expect(guardar).toHaveBeenCalledWith(
      `hotels:content:${CONTENIDO}:${HOTEL}:es`,
      expect.objectContaining({ kind: 'found' }),
      HOTEL_CONTENT_CACHE_TTL_S.found,
    );
    // Por idioma: el portugués es otra entrada.
    await pedir(b, 'pt');
    expect(b.fetchContent).toHaveBeenCalledTimes(2);
  });

  it('dos fichas a la vez esperan UNA llamada', async () => {
    let soltar: (v: HotelProviderContent) => void = () => undefined;
    const b = banco({
      fetchContent: vi.fn(
        () =>
          new Promise<HotelProviderContent | null>((resolve) => {
            soltar = resolve;
          }),
      ),
    });

    const una = pedir(b, 'es');
    const otra = pedir(b, 'es', CONTENIDO, OTRO_TENANT);
    await vi.waitFor(() => expect(b.fetchContent).toHaveBeenCalledTimes(1));
    soltar(delProveedor());

    const [a, c] = await Promise.all([una, otra]);
    expect(a.origin).toBe('provider');
    expect(c.origin).toBe('provider');
    expect(b.fetchContent).toHaveBeenCalledTimes(1);
  });

  it('el proveedor responde sin el hotel: se recuerda una hora y no se le vuelve a preguntar', async () => {
    const b = banco({ fetchContent: vi.fn(() => Promise.resolve(null)) });
    const guardar = vi.spyOn(b.cache, 'set');

    await pedir(b, 'es');
    await pedir(b, 'es');

    // El español y, como no vino, el respaldo en inglés: una vez cada uno.
    expect(b.fetchContent.mock.calls.map((c) => c[1])).toEqual(['es', 'en']);
    expect(guardar).toHaveBeenCalledWith(
      `hotels:content:${CONTENIDO}:${HOTEL}:es`,
      { kind: 'empty' },
      HOTEL_CONTENT_CACHE_TTL_S.empty,
    );
    expect(guardar).toHaveBeenCalledWith(
      `hotels:content:${CONTENIDO}:${HOTEL}:en`,
      { kind: 'empty' },
      HOTEL_CONTENT_CACHE_TTL_S.empty,
    );
  });

  it('sin el idioma pedido en el proveedor, el respaldo en inglés en el MISMO plazo, y lo dice', async () => {
    const b = banco({
      fetchContent: vi.fn((_hotelId, lang) =>
        Promise.resolve(lang === 'en' ? { ...delProveedor('en'), name: 'Cataract (EN)' } : null),
      ),
    });

    const ficha = await pedir(b, 'es');

    expect(b.fetchContent.mock.calls.map((c) => c[1])).toEqual(['es', 'en']);
    const [primera, segunda] = b.fetchContent.mock.calls.map((c) => c[3].timeoutMs);
    expect(primera).toBe(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS);
    expect(segunda).toBeLessThanOrEqual(HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS);
    expect(ficha).toMatchObject({
      requestedLang: 'es',
      lang: 'en',
      langFallback: true,
      origin: 'provider',
      images: ['https://img.example/hotel/od.jpg'],
    });
  });

  it('el respaldo no se pide si el español falló, si ya está el inglés de detalle o en inglés', async () => {
    const fallo = banco({ fetchContent: vi.fn(() => Promise.reject(new Error('timeout'))) });
    await pedir(fallo, 'es');
    expect(fallo.fetchContent.mock.calls.map((c) => c[1])).toEqual(['es']);

    const conIngles = banco({
      db: { contenidos: contenidos(DETALLE_EN) },
      fetchContent: vi.fn(() => Promise.resolve(null)),
    });
    await expect(pedir(conIngles, 'es')).resolves.toMatchObject({ lang: 'en', origin: 'catalog' });
    expect(conIngles.fetchContent.mock.calls.map((c) => c[1])).toEqual(['es']);

    const ingles = banco({ fetchContent: vi.fn(() => Promise.resolve(null)) });
    await pedir(ingles, 'en');
    expect(ingles.fetchContent.mock.calls.map((c) => c[1])).toEqual(['en']);
  });

  it('sin tiempo para el respaldo (menos de 1 s del plazo), no sale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const b = banco({
      fetchContent: vi.fn(() => {
        vi.setSystemTime(Date.now() + HOTEL_CONTENT_ON_DEMAND_TIMEOUT_MS - 500);
        return Promise.resolve(null);
      }),
    });
    try {
      await pedir(b, 'es');
    } finally {
      vi.useRealTimers();
    }
    expect(b.fetchContent.mock.calls.map((c) => c[1])).toEqual(['es']);
  });

  it('un hotel que la cuenta ya confirmó sin contenido (por lote) no se vuelve a pedir', async () => {
    const b = banco({
      db: { contenidos: contenidos(LISTADO_EN) },
      factory: { circuit: { accountRef: 'cuenta-a' } },
    });
    await b.cache.set(`hotels:content-none:${CONTENIDO}@cuenta-a:${HOTEL}:es`, 'none', 60);
    await b.cache.set(`hotels:content-none:${CONTENIDO}@cuenta-a:${HOTEL}:en`, 'none', 60);

    const ficha = await pedir(b, 'es');

    expect(b.fetchContent).not.toHaveBeenCalled();
    expect(ficha).toMatchObject({ origin: 'catalog', lang: 'en', langFallback: true });
  });

  it('lo que confirmó OTRA cuenta, o en otro idioma, no frena la ficha', async () => {
    const b = banco({
      db: { contenidos: contenidos(LISTADO_EN) },
      factory: { circuit: { accountRef: 'cuenta-b' } },
    });
    // La cuenta A (otro consolidador, u otro entorno) confirmó el español; la B sólo el inglés.
    await b.cache.set(`hotels:content-none:${CONTENIDO}@cuenta-a:${HOTEL}:es`, 'none', 60);
    await b.cache.set(`hotels:content-none:${CONTENIDO}@cuenta-b:${HOTEL}:en`, 'none', 60);

    const ficha = await pedir(b, 'es');

    expect(b.fetchContent.mock.calls.map((c) => c[1])).toEqual(['es']);
    expect(ficha).toMatchObject({ origin: 'provider', lang: 'es', langFallback: false });
  });

  it('un fallo del proveedor no es un error de la ficha, se recuerda poco y se loguea sin el mensaje', async () => {
    const b = banco({
      fetchContent: vi.fn(() =>
        Promise.reject(new TypeError('fetch failed https://usuario:clave@tbo.example')),
      ),
    });
    const guardar = vi.spyOn(b.cache, 'set');

    await expect(pedir(b, 'es')).resolves.toMatchObject({ origin: 'none', images: [] });
    await pedir(b, 'es');

    expect(b.fetchContent).toHaveBeenCalledTimes(1);
    expect(guardar).toHaveBeenCalledWith(
      expect.any(String),
      { kind: 'failed' },
      HOTEL_CONTENT_CACHE_TTL_S.failed,
    );
    expect(HOTEL_CONTENT_CACHE_TTL_S.failed).toBeLessThan(HOTEL_CONTENT_CACHE_TTL_S.empty);
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(
      `hotels.content.bajo_demanda_fallo provider=${CONTENIDO} lang=es error=TypeError`,
    );
    expect(logueado).not.toContain('clave');
  });

  it('sus fallos no cuentan para el circuito: un HotelDetails lento no corta las búsquedas', async () => {
    const hoteles = ['1', '2', '3', '4', '5', '6', '7'];
    const b = banco({
      db: { fichas: { [CONTENIDO]: Object.fromEntries(hoteles.map((h) => [h, {}])) } },
      fetchContent: vi.fn(() => Promise.reject(new Error('lento'))),
    });

    for (const hotelId of hoteles) {
      await b.service.getContent(TENANT, { providerCode: CONTENIDO, hotelId, lang: 'es' });
    }

    expect(b.fetchContent).toHaveBeenCalledTimes(7);
    expect(b.breaker.snapshot()[CONTENIDO]).toEqual({ state: 'closed', failures: 0 });
  });

  it('y lo que responde no borra los fallos de las búsquedas: el circuito abre igual', async () => {
    const b = banco();
    const caido = (): Promise<never> => Promise.reject(new Error('Search caído'));
    for (let i = 0; i < 4; i++) await b.breaker.execute(CONTENIDO, caido).catch(() => undefined);

    await expect(pedir(b, 'es')).resolves.toMatchObject({ origin: 'provider' });
    expect(b.breaker.snapshot()[CONTENIDO]).toEqual({ state: 'closed', failures: 4 });

    await b.breaker.execute(CONTENIDO, caido).catch(() => undefined);
    expect(b.breaker.snapshot()[CONTENIDO]?.state).toBe('open');
  });

  it('un código que el catálogo del proveedor no conoce no sale al proveedor: ficha vacía, sin error', async () => {
    const b = banco({ db: { fichas: {}, contenidos: contenidos(LISTADO_EN) } });
    const guardar = vi.spyOn(b.cache, 'set');

    const ficha = await pedir(b, 'es');

    expect(b.factory.resolveCalls).toEqual([]);
    expect(b.fetchContent).not.toHaveBeenCalled();
    expect(guardar).not.toHaveBeenCalled();
    // Lo que haya en `hotel_content` se sirve igual: es catálogo, no una llamada.
    expect(ficha).toMatchObject({ origin: 'catalog', lang: 'en', name: 'Cataract Hotel' });
  });

  it('con el proveedor apagado por el kill-switch de ventas no sale, y la ficha sale igual', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', `${CONTENIDO}:ventas`);
    const b = banco({ db: { contenidos: contenidos(DETALLE_EN) } });

    const ficha = await pedir(b, 'es');

    expect(b.fetchContent).not.toHaveBeenCalled();
    expect(ficha).toMatchObject({ origin: 'catalog', lang: 'en' });
  });

  it('`opt-in` apagado para la agencia: ni flag ni cuenta dejan salir, y el catálogo se lee igual', async () => {
    const b = banco({ flag: false, db: { contenidos: contenidos(DETALLE_EN) } });

    const ficha = await pedir(b, 'es');

    expect(b.factory.resolveCalls).toEqual([]);
    expect(b.fetchContent).not.toHaveBeenCalled();
    expect(ficha).toMatchObject({ origin: 'catalog', lang: 'en' });
  });

  it('la bóveda caída tampoco rompe la ficha: se loguea por clase, sin el mensaje, y no se recuerda', async () => {
    const b = banco({
      db: { contenidos: contenidos(DETALLE_EN) },
      factory: { failResolveWith: new Error('conexión a pg://usuario:clave@db') },
    });
    const guardar = vi.spyOn(b.cache, 'set');

    await expect(pedir(b, 'es')).resolves.toMatchObject({ origin: 'catalog', lang: 'en' });

    expect(guardar).not.toHaveBeenCalled();
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(
      `hotels.content.proveedor_no_resuelto provider=${CONTENIDO} error=Error`,
    );
    expect(logueado).not.toContain('clave');
  });

  it('un proveedor de catálogo sin el puerto de contenido no se consulta', async () => {
    const b = banco();
    const adapter = b.factory.adapterFor(TENANT) as unknown as Record<string, unknown>;
    delete adapter['fetchHotelContent'];

    const ficha = await pedir(b, 'es');

    expect(b.factory.resolveCalls).toEqual([TENANT]);
    expect(ficha.origin).toBe('none');
  });

  it('lo que se lanza sin ser un Error se nombra como desconocido, nunca con su contenido', async () => {
    const leer: FetchContent = vi.fn();
    leer.mockRejectedValue('texto del proveedor con datos');
    const b = banco({ fetchContent: leer });

    await pedir(b, 'es');

    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain('error=UnknownError');
    expect(logueado).not.toContain('texto del proveedor');
  });

  it('sin ubicación del proveedor, la ficha sale sin ubicación', async () => {
    const b = banco({
      fetchContent: vi.fn(() =>
        Promise.resolve<HotelProviderContent | null>({ ...delProveedor(), location: null }),
      ),
    });

    const ficha = await pedir(b, 'es');

    expect(ficha).toMatchObject({ origin: 'provider', location: null, stars: 5 });
  });

  it('sin cuenta para la agencia: no sale, no se recuerda (otra agencia sí puede tenerla) y no es un error', async () => {
    const b = banco({ factory: { failResolve: true } });
    const guardar = vi.spyOn(b.cache, 'set');

    await expect(pedir(b, 'es')).resolves.toMatchObject({ origin: 'none' });

    expect(b.fetchContent).not.toHaveBeenCalled();
    expect(guardar).not.toHaveBeenCalled();
  });

  it('una respuesta sin nada que mostrar no le gana al inglés del catálogo', async () => {
    const b = banco({
      db: { contenidos: contenidos(DETALLE_EN) },
      fetchContent: vi.fn(() =>
        Promise.resolve<HotelProviderContent | null>({
          ...delProveedor(),
          descriptionHtml: null,
          sections: [],
          facilities: [],
          images: [],
        }),
      ),
    });

    const ficha = await pedir(b, 'es');

    expect(ficha).toMatchObject({ origin: 'catalog', lang: 'en', images: [IMAGEN] });
  });

  it('un valor de la caché con otra forma no se usa: se vuelve a preguntar', async () => {
    const b = banco();
    await b.cache.set(`hotels:content:${CONTENIDO}:${HOTEL}:es`, { kind: 'otra-version' }, 60);

    const ficha = await pedir(b, 'es');

    expect(b.fetchContent).toHaveBeenCalledTimes(1);
    expect(ficha.origin).toBe('provider');
  });
});

// ───────────────────────── TBO de punta a punta ─────────────────────────

const RAIZ = join(__dirname, '..', '..', '..', '..');
const HOTEL_DETAILS_P59 = join(
  RAIZ,
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
  'pdf',
  'hotel-details.p59.json',
);

const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';

interface EjemploHotelDetails {
  Status: unknown;
  HotelDetails: Array<Record<string, unknown>>;
}

/** La cuenta del consolidador, heredada por la agencia (D-TBO-03 A). */
function bovedaTbo(): ProviderCredentialsService {
  const cuenta: ResolvedProviderAccount = {
    id: 'acc-consolidador',
    ownerTenantId: CONSOLIDADOR,
    providerCode: 'tbo-hotels',
    label: 'default',
    config: { environment: 'test' },
    credentials: { username: 'consolidador-demo', password: 'no-es-una-clave' },
    inherited: true,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
  return {
    resolve: vi.fn(() => Promise.resolve(cuenta)),
    ownerTenantType: vi.fn(() => Promise.resolve<TenantType>('consolidator')),
  } as unknown as ProviderCredentialsService;
}

/** El catálogo de TBO con el hotel del ejemplo, sin contenido: la ficha tiene que salir a pedirlo. */
function catalogoTbo(): ReturnType<typeof fakeHotelsDb> {
  return fakeHotelsDb({ fichas: { 'tbo-hotels': { [HOTEL]: {} } } });
}

/** El ejemplo de p. 59 con marcado hostil y una imagen `http` agregados. */
function respuestaHotelDetails(): Response {
  const ejemplo = JSON.parse(readFileSync(HOTEL_DETAILS_P59, 'utf8')) as EjemploHotelDetails;
  const [hotel] = ejemplo.HotelDetails;
  if (hotel === undefined) throw new Error('el ejemplo de p. 59 no trae HotelDetails');
  const images = hotel['Images'] as string[];
  const HotelDetails = [
    {
      ...hotel,
      Description: `<p onclick="robar()">HeadLine : Cerca del museo</p><script>alert(1)</script>${String(hotel['Description'])}`,
      Images: ['http://api.tbotechnology.in/imageresource.aspx?img=inseguro', ...images],
    },
  ];
  return new Response(JSON.stringify({ Status: ejemplo.Status, HotelDetails }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TBO de punta a punta: HotelDetails con la cuenta del consolidador y el ACL real', () => {
  function montarTbo(): { service: HotelContentService; fetch: Mock<TboFetch> } {
    const fetch = vi.fn<TboFetch>(() => Promise.resolve(respuestaHotelDetails()));
    const factories: HotelProviderFactory[] = [new TboHotelsProviderFactory(bovedaTbo(), fetch)];
    const registry = hotelRegistry(factories, hotelFlags(true));
    const service = new HotelContentService(
      registry,
      catalogoTbo().service,
      new CircuitBreakerService(),
      new MemoryCacheAdapter(),
    );
    return { service, fetch };
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('sin contenido en el catálogo pide ese solo hotel en el idioma pedido y lo muestra saneado', async () => {
    const { service, fetch } = montarTbo();

    const ficha = await service.getContent(TENANT, {
      providerCode: 'tbo-hotels',
      hotelId: HOTEL,
      lang: 'es',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TBO_BASE_URLS.test}/HotelDetails`);
    expect(JSON.parse(init.body as string)).toEqual({ Hotelcodes: HOTEL, Language: 'ES' });

    expect(ficha.origin).toBe('provider');
    expect(ficha.name).toBe('Sofitel Legend Old Cataract Aswan');
    expect(ficha.stars).toBe(5);
    expect(ficha.checkInTime).toBe('15:00');
    expect(ficha.checkOutTime).toBe('12:00');

    // RNF-16: el `<script>` y el `onclick` de TBO no llegan; lo que llega es la lista blanca.
    expect(ficha.descriptionHtml).not.toBeNull();
    expect(ficha.descriptionHtml).not.toMatch(/script|onclick|robar/i);
    expect(isAllowlistedHtml(ficha.descriptionHtml ?? '')).toBe(true);
    expect(ficha.attractionsHtml === null || isAllowlistedHtml(ficha.attractionsHtml)).toBe(true);
    // Sólo `https`: la imagen `http` agregada no sale.
    expect(ficha.images.length).toBeGreaterThan(0);
    expect(ficha.images.every((u) => u.startsWith('https://'))).toBe(true);
    expect(ficha.images.some((u) => u.includes('inseguro'))).toBe(false);
    // RF-32: un servicio negado no se muestra como disponible.
    expect(ficha.facilities.some((f) => /wheelchair accessible/i.test(f))).toBe(false);
  });

  it('ES "No Hotels Found" (2026-09-30), EN con contenido: la ficha en inglés, y lo dice', async () => {
    const fetch = vi.fn<TboFetch>((_url, init) => {
      const body = JSON.parse(init.body as string) as { Language: string };
      return Promise.resolve(
        body.Language === 'ES'
          ? new Response(
              JSON.stringify({ Status: { Code: 500, Description: 'No Hotels Found' } }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          : respuestaHotelDetails(),
      );
    });
    const breaker = new CircuitBreakerService();
    const service = new HotelContentService(
      hotelRegistry([new TboHotelsProviderFactory(bovedaTbo(), fetch)], hotelFlags(true)),
      catalogoTbo().service,
      breaker,
      new MemoryCacheAdapter(),
    );

    const ficha = await service.getContent(TENANT, {
      providerCode: 'tbo-hotels',
      hotelId: HOTEL,
      lang: 'es',
    });

    // Un intento por idioma: el "No Hotels Found" rápido no se reintenta.
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string) as unknown)).toEqual([
      { Hotelcodes: HOTEL, Language: 'ES' },
      { Hotelcodes: HOTEL, Language: 'EN' },
    ]);
    expect(ficha).toMatchObject({
      requestedLang: 'es',
      lang: 'en',
      langFallback: true,
      origin: 'provider',
      name: 'Sofitel Legend Old Cataract Aswan',
    });
    expect(ficha.images.length).toBeGreaterThan(0);
    expect(breaker.snapshot()['tbo-hotels']).toEqual({ state: 'closed', failures: 0 });
  });

  it('con el flag de `opt-in` apagado no sale a TBO: la ficha sale sin contenido', async () => {
    const fetch = vi.fn<TboFetch>(() => Promise.resolve(respuestaHotelDetails()));
    const registry = hotelRegistry(
      [new TboHotelsProviderFactory(bovedaTbo(), fetch)],
      hotelFlags(false),
    );
    const service = new HotelContentService(
      registry,
      catalogoTbo().service,
      new CircuitBreakerService(),
      new MemoryCacheAdapter(),
    );

    const ficha = await service.getContent(TENANT, {
      providerCode: 'tbo-hotels',
      hotelId: HOTEL,
      lang: 'es',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(ficha).toMatchObject({ origin: 'none', images: [] });
  });
});
