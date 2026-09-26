import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelOffer } from '@sales-travel/canonical';
import type { AvailabilityQuery } from '@sales-travel/despegar-hotels';
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
  HOTELES_CON_CUPO,
  fakeDespegarFactory,
  ofertasDespegar,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import type { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import type { HotelProviderOutcome } from './hotel-search.aggregate.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import { HotelsController, type HotelSearchEnvelope } from './hotels.controller.js';
import { HotelAvailabilityInputSchema, HotelDetailInputSchema } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * TBO en `POST /hotels/availability` contra Postgres real (docs/tbo/09 PR-2.6; 08 RF-14, RF-33,
 * RF-34, RF-40, RNF-09).
 *
 * Lo que los tests sin base no pueden probar es el SQL contra las tablas de 0041 sembradas: que el
 * mapa de destinos sólo use filas `accepted`, que el catálogo de TBO se lea por SUS ciudades, sólo
 * activos y por relevancia, que las equivalencias `review` no agrupen, y que la búsqueda deje una
 * sola búsqueda en la cuota. Por eso todo termina en la respuesta del endpoint o en lo que salió
 * por el cable de TBO, no en el servicio.
 *
 * Piezas REALES: bóveda cifrada (`provider_accounts` + `resolve_provider_account`), factory, ACL,
 * cliente y mapper de TBO, registry, flags de entorno, servicio, pricing, telemetría, divulgación
 * y controlador. Dobles: el `fetch` de TBO, inyectado en el factory con el token del módulo
 * (`TBO_HOTELS_FETCH`), que responde con el ejemplo de p. 15 de PR-1.4 para los códigos que se le
 * pidieron; y el ACL de Despegar, el mismo de la red de seguridad de PR-0.1.
 *
 * Los ids de hotel, ciudad y equivalencia son sintéticos y únicos por corrida: el catálogo es de
 * plataforma y quien corra esto contra su base local no puede tocar filas reales.
 *
 * Requiere las migraciones hasta 0041. Se SALTA sin PGHOST, como el resto de los
 * `*.integration.test.ts`.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const DESPEGAR = 'despegar-hotels';
const TBO = 'tbo-hotels';
const MONEDA = 'USD';

const RAIZ = join(__dirname, '..', '..', '..', '..');
const EJEMPLO_P15 = join(
  RAIZ,
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
  'pdf',
  'search-single-room.p15.json',
);

interface EjemploSearch {
  Status: unknown;
  HotelResult: Array<{ HotelCode: string; Rooms: Array<Record<string, unknown>> }>;
}

/** El body JSON de una llamada a TBO: el cliente siempre manda texto. */
function cuerpoDe(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('la llamada a TBO no llevó un body de texto');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/**
 * El ejemplo de una habitación del PDF (p. 15) con UN hotel por código pedido, en el orden
 * pedido. Cada `BookingCode` se reescribe con el código del hotel para que no se repitan.
 */
function respuestaSearch(init: RequestInit): Response {
  const pedido = cuerpoDe(init) as { HotelCodes: string };
  const ejemplo = JSON.parse(readFileSync(EJEMPLO_P15, 'utf8')) as EjemploSearch;
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

d('TBO en la búsqueda de /hotels, contra Postgres sembrado', () => {
  const pool = new pg.Pool();
  const database = new DatabaseService();
  const sfx = randomBytes(4).toString('hex');

  // Un espacio de ids por corrida: nada de esto puede coincidir con un catálogo real.
  const CIUDAD = 970_000_000 + randomBytes(3).readUIntBE(0, 3);
  const CIUDAD_SIN_MAPA = CIUDAD + 1;
  const CIUDAD_AMBIGUA = CIUDAD + 2;
  const CIUDAD_TBO = `IT${sfx}C1`;
  const CIUDAD_TBO_VECINA = `IT${sfx}C2`;

  /** Hoteles de Despegar, cada uno servido por un hotel con cupo de la respuesta grabada. */
  const D1 = `it-${sfx}-d1`;
  const D2 = `it-${sfx}-d2`;
  const D3 = `it-${sfx}-d3`;
  const DESPEGAR_CON_CUPO: Readonly<Record<string, string>> = {
    [D1]: HOTELES_CON_CUPO[0],
    [D2]: HOTELES_CON_CUPO[1],
    [D3]: HOTELES_CON_CUPO[2],
  };

  /** T1 = D1 (equivalencia aceptada); T2 sólo de TBO; T3 inactivo; T4 de la ciudad ambigua. */
  const T1 = `IT${sfx}T1`;
  const T2 = `IT${sfx}T2`;
  const T3 = `IT${sfx}T3`;
  const T4 = `IT${sfx}T4`;
  const CANON = `canon-${sfx}`;
  const CANON_EN_REVISION = `canon-rev-${sfx}`;

  const envPrevio = new Map<string, string | undefined>();
  let creds: ProviderCredentialsService;
  let usuario: string;
  let consolidador: string;
  let agencia: string;
  /** Agencia de OTRA red, sin cuenta TBO propia ni heredada. */
  let ajena: string;

  interface Api {
    controller: HotelsController;
    fetch: Mock<TboFetch>;
    despegar: FakeDespegarHotelsAdapter;
  }

  /** Una API montada con las piezas reales. Por test, para no compartir cachés ni circuitos. */
  function montar(): Api {
    const fetch = vi.fn<TboFetch>((url, init) =>
      Promise.resolve(
        url.endsWith('/Search')
          ? respuestaSearch(init)
          : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const despegar = new FakeDespegarHotelsAdapter();
    despegar.searchAvailability.mockImplementation((q: AvailabilityQuery) =>
      Promise.resolve(
        q.hotelIds.flatMap((id) => {
          const grabado = DESPEGAR_CON_CUPO[id];
          return grabado === undefined
            ? []
            : ofertasDespegar([grabado]).map((o) => ({ ...o, hotelId: id }));
        }),
      ),
    );
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
    );
    return { controller, fetch, despegar };
  }

  /** `POST /hotels/availability` tal como lo entrega el middleware, con el Zod del endpoint. */
  function buscar(
    api: Api,
    tenantId: string,
    destinationId: number = CIUDAD,
  ): Promise<HotelSearchEnvelope> {
    const body = HotelAvailabilityInputSchema.parse({
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: [{ adults: 2, childrenAges: [] }],
      destinationId,
      guestNationality: 'COL',
      currency: MONEDA,
    });
    return requestContextStorage.run({ userId: usuario, tenantId }, () =>
      api.controller.availability(usuario, body),
    );
  }

  function parteDe(res: HotelSearchEnvelope, code: string): HotelProviderOutcome | undefined {
    return res.providers.find((p) => p.code === code);
  }

  function hotelDe(res: HotelSearchEnvelope, hotelId: string): HotelOffer | undefined {
    return res.hotels.find((o) => o.hotelId === hotelId);
  }

  /** Los `HotelCodes` que salieron hacia TBO en cada llamada. */
  function codigosEnviados(api: Api): string[] {
    return api.fetch.mock.calls.map(([, init]) => String(cuerpoDe(init)['HotelCodes']));
  }

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', $2, $3, $4) RETURNING id`,
      [slug, MONEDA, tipo, padre],
    );
    return rows[0]!.id;
  }

  function fijarEnv(clave: string, valor: string | undefined): void {
    if (!envPrevio.has(clave)) envPrevio.set(clave, process.env[clave]);
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }

  async function sembrarCatalogo(): Promise<void> {
    // Despegar: su espacio de ids (`city_id`), como lo deja su sync nocturno.
    await pool.query(
      `INSERT INTO hotel_inventory (provider_code, hotel_id, city_id, name, stars, latitude, longitude)
       VALUES ($1, $2, $7, 'Despegar Uno', 4, 4.6768, -74.0492),
              ($1, $3, $7, 'Despegar Dos', 3, 4.6100, -74.0700),
              ($1, $4, $7, 'Despegar Tres', 3, 4.6200, -74.0800),
              ($1, $5, $8, 'Despegar Sin Mapa', 3, 4.7000, -74.1000),
              ($1, $6, $9, 'Despegar Ambigua', 3, 4.8000, -74.2000)`,
      [
        DESPEGAR,
        D1,
        D2,
        D3,
        `it-${sfx}-sin-mapa`,
        `it-${sfx}-ambigua`,
        CIUDAD,
        CIUDAD_SIN_MAPA,
        CIUDAD_AMBIGUA,
      ],
    );
    // TBO: sus ciudades (`provider_city_code`), con upsert por ciudad y baja lógica.
    await pool.query(
      `INSERT INTO hotel_inventory
         (provider_code, hotel_id, provider_city_code, name, stars, address, latitude, longitude, active, last_seen_at)
       VALUES ($1, $2, $6, 'TBO Uno', 4.0, 'Carrera 12 # 93-45 ', 4.6768, -74.0492, true, now()),
              ($1, $3, $6, 'TBO Dos', 5.0, 'Calle 94 # 11-20', 4.6781, -74.0455, true, now()),
              ($1, $4, $6, 'TBO Inactivo', 5.0, 'Calle 1', 4.6, -74.0, false, now()),
              ($1, $5, $7, 'TBO Vecino', 5.0, 'Calle 2', 4.9, -74.3, true, now())`,
      [TBO, T1, T2, T3, T4, CIUDAD_TBO, CIUDAD_TBO_VECINA],
    );
    await pool.query(
      `INSERT INTO hotel_destination_map
         (source_provider_code, source_city_id, target_provider_code, target_city_code, method, score, status)
       VALUES ($1, $3, $2, $5, 'overlap', 0.9, 'accepted'),
              ($1, $3, $2, $6, 'centroid', 0.4, 'rejected'),
              ($1, $4, $2, $6, 'centroid', 0.5, 'ambiguous')`,
      [DESPEGAR, TBO, String(CIUDAD), String(CIUDAD_AMBIGUA), CIUDAD_TBO, CIUDAD_TBO_VECINA],
    );
    await pool.query(
      `INSERT INTO hotel_match (canonical_hotel_id, provider_code, hotel_id, method, score, status)
       VALUES ($1, $3, $5, 'heuristic', 0.95, 'accepted'),
              ($1, $4, $6, 'heuristic', 0.95, 'accepted'),
              ($2, $3, $7, 'heuristic', 0.55, 'review'),
              ($2, $4, $8, 'heuristic', 0.55, 'review')`,
      [CANON, CANON_EN_REVISION, DESPEGAR, TBO, D1, T1, D2, T2],
    );
  }

  async function limpiarCatalogo(): Promise<void> {
    await pool.query(`DELETE FROM hotel_match WHERE canonical_hotel_id = ANY($1)`, [
      [CANON, CANON_EN_REVISION],
    ]);
    await pool.query(`DELETE FROM hotel_destination_map WHERE source_city_id = ANY($1)`, [
      [String(CIUDAD), String(CIUDAD_SIN_MAPA), String(CIUDAD_AMBIGUA)],
    ]);
    await pool.query(
      `DELETE FROM hotel_inventory
        WHERE (provider_code = $1 AND hotel_id LIKE $3)
           OR (provider_code = $2 AND hotel_id LIKE $4)`,
      [DESPEGAR, TBO, `it-${sfx}-%`, `IT${sfx}%`],
    );
  }

  beforeAll(async () => {
    // Clave de cifrado del blob BYOC: de usar y tirar, sólo vive en este proceso de test.
    fijarEnv('PROVIDER_CREDENTIALS_KEY', randomBytes(32).toString('base64'));
    // TBO es `opt-in` (D-TBO-18 A): encendido para todos los tenants de esta prueba.
    fijarEnv('HOTEL_PROVIDERS_OPT_IN', TBO);
    fijarEnv('HOTEL_PROVIDER_CALL_POLICIES', undefined);
    fijarEnv('PLATFORM_DEFAULT_HOTEL_PROVIDERS', undefined);
    fijarEnv('PROVIDERS_DISABLED', undefined);

    database.onModuleInit();
    creds = new ProviderCredentialsService(database);

    const nuevoUsuario = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`tbo-${sfx}@test.local`],
    );
    usuario = nuevoUsuario.rows[0]!.id;
    consolidador = await crearTenant(`tbo-cons-${sfx}`, 'consolidator', null);
    agencia = await crearTenant(`tbo-ag-${sfx}`, 'agency', consolidador);
    ajena = await crearTenant(`tbo-otra-${sfx}`, 'agency', null);

    // La cuenta TBO del consolidador, heredable por su red (D-TBO-03 A), cargada por la misma
    // puerta que el panel. `active`: una cuenta nueva nace `sandbox` y no habilita nada.
    await creds.upsert({
      tenantId: consolidador,
      providerCode: TBO,
      credentials: { username: `usuario-${sfx}`, password: 'Pa55w0rd' },
      config: { environment: 'test' },
      isInheritable: true,
      status: 'active',
    });

    await sembrarCatalogo();
  });

  afterAll(async () => {
    await limpiarCatalogo();
    await pool.query(`DELETE FROM provider_accounts WHERE tenant_id = ANY($1::uuid[])`, [
      [consolidador, agencia, ajena].filter(Boolean),
    ]);
    // `parent_tenant_id` es ON DELETE RESTRICT: de hoja a raíz. `search_logs` cae en cascada.
    for (const id of [agencia, consolidador, ajena]) {
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

  it('RF-14 CA 1 y RF-33: a TBO le salen SUS códigos de SUS ciudades aceptadas, sólo activos y por relevancia', async () => {
    const api = montar();
    await buscar(api, agencia);

    // T2 (5 estrellas) antes que T1 (4); T3 está inactivo y T4 es de una ciudad que el mapa no
    // acepta para este destino.
    expect(codigosEnviados(api)).toEqual([`${T2},${T1}`]);
    // Despegar, con su ciudad y su orden por id.
    expect(api.despegar.searchAvailability.mock.calls[0]?.[0].hotelIds).toEqual([D1, D2, D3]);
  });

  it('RF-40 CA 1 y 5: la tarjeta agrupada trae las dos tarifas, cada una con su proveedor, con la divulgación apagada', async () => {
    const res = await buscar(montar(), agencia);

    expect(res.showProviderInResults).toBe(false);
    const tarjeta = hotelDe(res, D1);
    expect(tarjeta?.name).toBe('Hotel Andino Plaza');
    expect(new Set(tarjeta?.roompacks.map((rp) => rp.provider.name))).toEqual(
      new Set([DESPEGAR, TBO]),
    );
    expect(tarjeta?.providerHotels).toEqual([
      { provider: DESPEGAR, hotelId: D1 },
      { provider: TBO, hotelId: T1 },
    ]);
    expect(hotelDe(res, T1)).toBeUndefined();
  });

  it('RF-34: una equivalencia en `review` no agrupa, y el hotel sólo de TBO trae los datos de SU catálogo', async () => {
    const res = await buscar(montar(), agencia);

    expect(hotelDe(res, D2)?.roompacks.every((rp) => rp.provider.name === DESPEGAR)).toBe(true);
    expect(hotelDe(res, T2)).toMatchObject({
      name: 'TBO Dos',
      stars: 5,
      address: 'Calle 94 # 11-20',
      location: { lat: 4.6781, lng: -74.0455 },
    });
    expect(hotelDe(res, T2)?.providerHotels).toBeUndefined();
    expect(parteDe(res, TBO)).toEqual({ code: TBO, status: 'ok', count: 2 });
    expect(parteDe(res, DESPEGAR)).toEqual({ code: DESPEGAR, status: 'ok', count: 3 });
  });

  it('RNF-09: una búsqueda con los dos proveedores cuenta UNA vez en la cuota, con una fila por proveedor', async () => {
    const antes = await pool.query<{ n: number }>(
      `SELECT count_recent_searches($1::uuid, 60) AS n`,
      [agencia],
    );
    await buscar(montar(), agencia);
    const despues = await pool.query<{ n: number }>(
      `SELECT count_recent_searches($1::uuid, 60) AS n`,
      [agencia],
    );
    expect(Number(despues.rows[0]?.n) - Number(antes.rows[0]?.n)).toBe(1);

    const { rows } = await pool.query<{ search_group_id: string; provider_code: string }>(
      `SELECT search_group_id, provider_code FROM search_logs
        WHERE tenant_id = $1 AND vertical = 'hotels'
          AND search_group_id = (
            SELECT search_group_id FROM search_logs
             WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1)
        ORDER BY provider_code`,
      [agencia],
    );
    expect(rows.map((r) => r.provider_code)).toEqual([DESPEGAR, TBO]);

    // La nacionalidad del pasajero no entra en el criterio registrado (RF-06, RNF-07).
    const criterios = await pool.query<{ criteria: unknown }>(
      `SELECT criteria FROM search_logs WHERE tenant_id = $1`,
      [agencia],
    );
    expect(JSON.stringify(criterios.rows)).not.toMatch(/Nationality|"CO"/);
  });

  it('RF-33 CA: un destino sin mapeo no consulta TBO, lo deja `skipped` y Despegar responde', async () => {
    const api = montar();
    const res = await buscar(api, agencia, CIUDAD_SIN_MAPA);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(parteDe(res, TBO)).toMatchObject({
      status: 'skipped',
      skipReason: 'no-destination-map',
    });
    expect(parteDe(res, DESPEGAR)?.status).toBe('empty');
  });

  it('RF-33 CA: una fila `ambiguous` del mapa no se usa', async () => {
    const api = montar();
    const res = await buscar(api, agencia, CIUDAD_AMBIGUA);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(parteDe(res, TBO)?.skipReason).toBe('no-destination-map');
  });

  it('sin cuenta TBO propia ni heredada: TBO ausente con motivo, ninguna llamada, y Despegar igual', async () => {
    const api = montar();
    const res = await buscar(api, ajena);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(parteDe(res, TBO)).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'no-credentials',
    });
    expect(res.hotels.map((o) => o.hotelId)).toEqual([D1, D2, D3]);
  });

  it('/hotels/detail de un hotel TBO: Search de un solo código, detallado, con los datos de SU catálogo', async () => {
    const api = montar();
    const body = HotelDetailInputSchema.parse({
      provider: TBO,
      hotelId: T1,
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: [{ adults: 2, childrenAges: [] }],
      guestNationality: 'CO',
      currency: MONEDA,
    });

    const oferta = await requestContextStorage.run({ userId: usuario, tenantId: agencia }, () =>
      api.controller.detail(usuario, body),
    );

    expect(codigosEnviados(api)).toEqual([T1]);
    expect(cuerpoDe(api.fetch.mock.calls[0]?.[1])).toMatchObject({ IsDetailedResponse: true });
    // El nombre de TBO, no el de la tarjeta agrupada con Despegar (RF-34).
    expect(oferta).toMatchObject({ hotelId: T1, name: 'TBO Uno', address: 'Carrera 12 # 93-45' });
    expect(oferta.roompacks.every((rp) => rp.provider.name === TBO)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sonda sin base de datos: sin Postgres lo de arriba se SALTA, y un salto silencioso no puede
// contar como verde. Vigila el insumo que el bloque de arriba da por supuesto.
// ---------------------------------------------------------------------------

describe('TBO en la búsqueda de /hotels, sin base de datos', () => {
  it('el ejemplo de p. 15 sigue donde lo lee el test y responde por cada código pedido', async () => {
    const res = respuestaSearch({ body: JSON.stringify({ HotelCodes: 'A1,B2' }) });
    const body = (await res.json()) as EjemploSearch;

    expect(body.HotelResult.map((h) => h.HotelCode)).toEqual(['A1', 'B2']);
    const codigos = body.HotelResult.flatMap((h) => h.Rooms.map((r) => r['BookingCode']));
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});
