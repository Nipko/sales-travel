import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TboFetch } from '@sales-travel/tbo-hotels';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { EnvHotelProviderFlags } from '../providers/hotel-providers.module.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import type { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import type { HotelBookingService } from './hotel-booking.service.js';
import type { HotelContentService } from './hotel-content.service.js';
import { normalizeCityName } from './hotel-destination.js';
import type { HotelPrebookService } from './hotel-prebook.service.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import { HotelAvailabilityInputSchema } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Destinos desde el catálogo local contra Postgres real (docs/tbo/05 §8.5; 07 U-02).
 *
 * Lo que el test sin base (`hotels.service.catalog-destinations.test.ts`) no puede probar es el SQL
 * contra `hotel_provider_city` sembrada: que el nombre se compare sin acentos ni mayúsculas, el
 * orden (exacta, prefijo, palabra, contiene, parecida), que sólo salgan ciudades con hoteles de
 * proveedores activos, y que la ciudad elegida llegue a TBO con los códigos de SU catálogo. Por
 * eso todo termina en la respuesta del endpoint o en lo que salió por el cable de TBO.
 *
 * La agencia está configurada como el stack de certificación (`docker-compose.cert.yml`):
 * Despegar `opt-in` apagado y TBO encendido con la cuenta heredada del consolidador.
 *
 * Los nombres y códigos son sintéticos y únicos por corrida: el catálogo es de plataforma, y quien
 * corra esto contra su base local no puede tocar filas reales ni recibirlas en las sugerencias.
 *
 * Requiere las migraciones hasta 0041, con `pg_trgm`. Se SALTA sin PGHOST, como el resto de los
 * `*.integration.test.ts`.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const TBO = 'tbo-hotels';

const EJEMPLO_P15 = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
  'pdf',
  'search-single-room.p15.json',
);

/** El body JSON de una llamada a TBO: el cliente siempre manda texto. */
function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** El ejemplo de p. 15 con UN hotel por código pedido, cada `BookingCode` distinto. */
function respuestaSearch(init: RequestInit | undefined): Response {
  const pedido = cuerpoDe(init) as { HotelCodes: string };
  const ejemplo = JSON.parse(readFileSync(EJEMPLO_P15, 'utf8')) as {
    Status: unknown;
    HotelResult: Array<{ HotelCode: string; Rooms: Array<Record<string, unknown>> }>;
  };
  const [modelo] = ejemplo.HotelResult;
  if (modelo === undefined) throw new Error('el ejemplo de p. 15 no trae HotelResult');
  const HotelResult = pedido.HotelCodes.split(',').map((code) => ({
    ...modelo,
    HotelCode: code,
    Rooms: modelo.Rooms.map((room, i) => ({
      ...room,
      BookingCode: `${code}!TB!${i + 1}!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b`,
    })),
  }));
  return new Response(JSON.stringify({ Status: ejemplo.Status, HotelResult }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Letras al azar: un nombre de ciudad que ninguna base real tiene. */
function palabraAlAzar(largo: number): string {
  return [...randomBytes(largo)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
}

d('destinos del catálogo local en /hotels, contra Postgres sembrado', () => {
  const pool = new pg.Pool();
  const database = new DatabaseService();
  const sfx = randomBytes(4).toString('hex');

  /** `qza…`: siete letras que sólo existen en esta corrida. Con mayúscula, como un nombre. */
  const PALABRA = `qza${palabraAlAzar(4)}`;
  const Palabra = `${PALABRA.charAt(0).toUpperCase()}${PALABRA.slice(1)}`;

  /** Código de ciudad de TBO de esta corrida (alfanumérico, como los de CityList). */
  const cod = (n: number): string => `IT${sfx}${n}`;

  interface Ciudad {
    readonly code: string;
    readonly name: string;
    readonly hotels: number | null;
    readonly provider?: string;
  }
  const EXACTA: Ciudad = { code: cod(1), name: Palabra, hotels: 2 };
  const PREFIJO: Ciudad = { code: cod(2), name: `${Palabra} del Mar`, hotels: 50 };
  const PALABRA_GRANDE: Ciudad = { code: cod(3), name: `San ${Palabra}`, hotels: 10 };
  const PALABRA_CHICA: Ciudad = { code: cod(4), name: `San ${Palabra}`, hotels: 3 };
  const CONTIENE: Ciudad = { code: cod(5), name: `Alto${PALABRA}`, hotels: 1 };
  /** Le falta la última letra: no contiene lo escrito, pero se le parece. */
  const PARECIDA: Ciudad = { code: cod(6), name: Palabra.slice(0, -1), hotels: 1 };
  const SIN_HOTELES: Ciudad = { code: cod(7), name: `${Palabra} Vacío`, hotels: 0 };
  const SIN_SINCRONIZAR: Ciudad = { code: cod(8), name: `${Palabra} Pendiente`, hotels: null };
  /** De un proveedor que la plataforma no tiene registrado. */
  const OTRO_PROVEEDOR: Ciudad = {
    code: cod(9),
    name: Palabra,
    hotels: 40,
    provider: `it-${sfx}-hotels`,
  };
  const CIUDADES = [
    EXACTA,
    PREFIJO,
    PALABRA_GRANDE,
    PALABRA_CHICA,
    CONTIENE,
    PARECIDA,
    SIN_HOTELES,
    SIN_SINCRONIZAR,
    OTRO_PROVEEDOR,
  ];

  /** Hoteles de TBO de la ciudad EXACTA: T1 (4★), T2 (5★) y T3 inactivo. */
  const T1 = `IT${sfx}T1`;
  const T2 = `IT${sfx}T2`;
  const T3 = `IT${sfx}T3`;

  const envPrevio = new Map<string, string | undefined>();
  let creds: ProviderCredentialsService;
  let usuario: string;
  let consolidador: string;
  let agencia: string;

  interface Api {
    controller: HotelsController;
    fetch: Mock<TboFetch>;
    despegar: FakeDespegarHotelsAdapter;
  }

  function montar(): Api {
    const fetch = vi.fn<TboFetch>((_url, init) => Promise.resolve(respuestaSearch(init)));
    const despegar = new FakeDespegarHotelsAdapter();
    const registry = new HotelProviderRegistry(
      [fakeDespegarFactory(despegar).factory, new TboHotelsProviderFactory(creds, fetch)],
      new EnvHotelProviderFlags(),
    );
    const service = new HotelsService(
      registry,
      database,
      new PricingService(database),
      new SearchTelemetryService(database),
      new CircuitBreakerService(),
      new HotelSearchContextStore(new MemoryCacheAdapter()),
    );
    const controller = new HotelsController(
      service,
      {} as DespegarHotelReservationsService,
      new ActiveTenantService(database),
      new ProviderDisclosureService(database),
      {} as HotelPrebookService,
      {} as HotelBookingService,
      {} as HotelContentService,
    );
    return { controller, fetch, despegar };
  }

  function sugerir(api: Api, q: string): Promise<{ items: { id: unknown }[] }> {
    return requestContextStorage.run({ userId: usuario, tenantId: agencia }, () =>
      api.controller.suggestions(usuario, { q }),
    );
  }

  function buscar(api: Api, destinationId: string): Promise<HotelSearchEnvelope> {
    const body = HotelAvailabilityInputSchema.parse({
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: [{ adults: 2, childrenAges: [] }],
      destinationId,
      guestNationality: 'COL',
      currency: 'USD',
    });
    return requestContextStorage.run({ userId: usuario, tenantId: agencia }, () =>
      api.controller.availability(usuario, body),
    );
  }

  const idDe = (c: Ciudad): string => `${c.provider ?? TBO}:${c.code}`;

  function fijarEnv(clave: string, valor: string | undefined): void {
    if (!envPrevio.has(clave)) envPrevio.set(clave, process.env[clave]);
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'USD', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    fijarEnv('PROVIDER_CREDENTIALS_KEY', randomBytes(32).toString('base64'));
    // Como `docker-compose.cert.yml`: Despegar `opt-in` apagado, TBO encendido, nada de plataforma.
    fijarEnv('HOTEL_PROVIDER_CALL_POLICIES', 'despegar-hotels:opt-in');
    fijarEnv('HOTEL_PROVIDERS_OPT_IN', TBO);
    fijarEnv('PLATFORM_DEFAULT_HOTEL_PROVIDERS', '');
    fijarEnv('PROVIDERS_DISABLED', undefined);

    database.onModuleInit();
    creds = new ProviderCredentialsService(database);

    const nuevoUsuario = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`catdest-${sfx}@test.local`],
    );
    usuario = nuevoUsuario.rows[0]!.id;
    consolidador = await crearTenant(`catdest-cons-${sfx}`, 'consolidator', null);
    agencia = await crearTenant(`catdest-ag-${sfx}`, 'agency', consolidador);
    await creds.upsert({
      tenantId: consolidador,
      providerCode: TBO,
      credentials: { username: `usuario-${sfx}`, password: 'Pa55w0rd' },
      config: { environment: 'test' },
      isInheritable: true,
      status: 'active',
    });

    for (const c of CIUDADES) {
      // `name_norm` como la escribe el sync: con el mismo algoritmo que normaliza la búsqueda.
      await pool.query(
        `INSERT INTO hotel_provider_city
           (provider_code, provider_city_code, country_code, name, name_norm, hotel_count)
         VALUES ($1, $2, 'CO', $3, $4, $5)`,
        [c.provider ?? TBO, c.code, c.name, normalizeCityName(c.name), c.hotels],
      );
    }
    await pool.query(
      `INSERT INTO hotel_inventory
         (provider_code, hotel_id, provider_city_code, name, stars, latitude, longitude, active, last_seen_at)
       VALUES ($1, $2, $5, 'TBO Uno', 4.0, 4.6768, -74.0492, true, now()),
              ($1, $3, $5, 'TBO Dos', 5.0, 4.6781, -74.0455, true, now()),
              ($1, $4, $5, 'TBO Inactivo', 5.0, 4.6, -74.0, false, now())`,
      [TBO, T1, T2, T3, EXACTA.code],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM hotel_inventory WHERE provider_code = $1 AND hotel_id LIKE $2`, [
      TBO,
      `IT${sfx}%`,
    ]);
    await pool.query(`DELETE FROM hotel_provider_city WHERE provider_city_code LIKE $1`, [
      `IT${sfx}%`,
    ]);
    if (consolidador) {
      await pool.query(`DELETE FROM provider_accounts WHERE tenant_id = $1`, [consolidador]);
    }
    for (const id of [agencia, consolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
    for (const [clave, valor] of envPrevio) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
  });

  // -------------------------------------------------------------------------

  it('U-02: sin Despegar, sugiere ciudades de TBO en orden: exacta, prefijo, palabra, contiene, parecida', async () => {
    const res = await sugerir(montar(), Palabra);

    expect(res.items.map((s) => s.id)).toEqual([
      idDe(EXACTA),
      idDe(PREFIJO),
      // Mismo nombre: primero la de más hoteles.
      idDe(PALABRA_GRANDE),
      idDe(PALABRA_CHICA),
      idDe(CONTIENE),
      idDe(PARECIDA),
    ]);
  });

  it('sin acentos ni mayúsculas: lo escrito se normaliza como `name_norm`', async () => {
    const api = montar();
    const acentuada = PALABRA.toUpperCase().replace('A', 'Á');

    const conAcentos = await sugerir(api, `  ${acentuada}, `);
    const plana = await sugerir(api, PALABRA);
    expect(conAcentos.items).toEqual(plana.items);
  });

  it('no salen ciudades sin hoteles, ni sin sincronizar, ni de proveedores no activos', async () => {
    const ids = (await sugerir(montar(), Palabra)).items.map((s) => s.id);

    expect(ids).not.toContain(idDe(SIN_HOTELES));
    expect(ids).not.toContain(idDe(SIN_SINCRONIZAR));
    expect(ids).not.toContain(idDe(OTRO_PROVEEDOR));
  });

  it('lo que la app lee lo puede leer `app_user`: la tabla y la similitud trigram', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM hotel_provider_city
          WHERE provider_code = $1 AND (name_norm LIKE $2 OR similarity(name_norm, $3) >= 0.4)`,
        [TBO, `%${PALABRA}%`, PALABRA],
      );
      expect(rows[0]?.n).toBeGreaterThanOrEqual(6);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('U-02: la ciudad elegida va directo a TBO con los códigos activos de SU catálogo, por relevancia', async () => {
    const api = montar();
    const res = await buscar(api, idDe(EXACTA));

    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(cuerpoDe(api.fetch.mock.calls[0]?.[1])).toMatchObject({ HotelCodes: `${T2},${T1}` });
    expect(api.despegar.searchAvailability).not.toHaveBeenCalled();
    expect(res.providers.find((p) => p.code === TBO)).toEqual({
      code: TBO,
      status: 'ok',
      count: 2,
    });
    expect(res.hotels.map((o) => o.hotelId).sort()).toEqual([T1, T2].sort());
  });

  it('en `search_logs` queda el proveedor y su ciudad, y no un `destinationId` que el sync leería como de Despegar', async () => {
    // Sólo las filas de ESTA búsqueda: la telemetría es best-effort y, si esta escritura fallara,
    // la fila de la búsqueda del test anterior haría pasar el test igual.
    const grupos = async (): Promise<string[]> =>
      (
        await pool.query<{ g: string }>(
          `SELECT DISTINCT search_group_id::text AS g FROM search_logs
            WHERE tenant_id = $1 AND vertical = 'hotels'`,
          [agencia],
        )
      ).rows.map((r) => r.g);
    const antes = new Set(await grupos());

    await buscar(montar(), idDe(EXACTA));

    const nuevos = (await grupos()).filter((g) => !antes.has(g));
    expect(nuevos).toHaveLength(1);
    const { rows } = await pool.query<{ criteria: Record<string, unknown> | string }>(
      `SELECT criteria FROM search_logs WHERE search_group_id::text = $1`,
      nuevos,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const criteria =
        typeof row.criteria === 'string'
          ? (JSON.parse(row.criteria) as Record<string, unknown>)
          : row.criteria;
      expect(criteria).toMatchObject({
        destinationProvider: TBO,
        destinationCityCode: EXACTA.code,
      });
      expect(criteria).not.toHaveProperty('destinationId');
    }
  });
});

// ---------------------------------------------------------------------------
// Sonda sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no puede
// contar como verde. Vigila el insumo que el bloque de arriba da por supuesto.
// ---------------------------------------------------------------------------

describe('destinos del catálogo local en /hotels, sin base de datos', () => {
  it('el ejemplo de p. 15 sigue donde lo lee el test y responde por cada código pedido', async () => {
    const res = respuestaSearch({ body: JSON.stringify({ HotelCodes: 'A1,B2' }) });
    const body = (await res.json()) as { HotelResult: Array<{ HotelCode: string }> };

    expect(body.HotelResult.map((h) => h.HotelCode)).toEqual(['A1', 'B2']);
  });
});
