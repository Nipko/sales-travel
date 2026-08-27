import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { FlightSearchCriteriaSchema, type FlightSearchCriteria } from '@sales-travel/domain';
import { SABRE_AUTH_PATH, SABRE_SHOP_PATH } from '@sales-travel/sabre';
import { DatabaseService } from '../database/database.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { EnvProviderFlags } from '../providers/providers.module.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { SearchTelemetryService } from '../search/search-telemetry.service.js';
import { SearchController } from '../search/search.controller.js';
import { SearchService, type FlightSearchResponse } from '../search/search.service.js';
import { SABRE_PROVIDER_CODE, SabreProviderFactory } from './sabre.factory.js';

/**
 * BYOC de Sabre de punta a punta: `provider_accounts` cifrado → `resolve_provider_account`
 * → `SabreProviderFactory` → fan-out → `POST /search/flights`.
 *
 * Por qué existe: las cuatro piezas tenían tests propios y NINGUNO cruzaba la frontera. Que
 * `resolve_provider_account` devuelva la fila correcta no demuestra que el vendedor vea a Sabre
 * en la pantalla, y es eso —y sólo eso— lo que le importa a la agencia que acaba de pegar sus
 * credenciales en el panel. Por eso todas las afirmaciones de abajo terminan en la respuesta del
 * endpoint (`providers[]`, `offers[]`), no en el registry ni en la función SQL.
 *
 * La puerta pública es `SearchController.flights`, que es el handler de `POST /search/flights`,
 * invocado dentro del `AsyncLocalStorage` que rellena `RequestContextMiddleware`. El criterio
 * pasa por el MISMO Zod que usa el `ZodValidationPipe` del endpoint.
 *
 * Sabre no se falsea en ningún punto: se levanta un servidor HTTP local que habla el contrato
 * (`/v2/auth/token` y `/v5/offers/shop`) y la `config.host` de la cuenta apunta a él. Así el
 * `SabreFlightSearchAdapter` real autentica y mapea de verdad, y el test puede leer el `clientId`
 * que salió por el cable — que es la única prueba de QUÉ credencial se usó.
 *
 * Requiere las migraciones 0011, 0012, 0032 y 0035. Se SALTA sin PGHOST, igual que
 * `provider-credentials.integration.test.ts` y `tenant-isolation.integration.test.ts`.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

/** Segundo proveedor, anónimo y siempre disponible: hace visible la degradación PARCIAL. */
const OTRO_PROVEEDOR = 'stub-air';

const MONEDA = 'USD';

// ---------------------------------------------------------------------------
// Servidor de Sabre local
// ---------------------------------------------------------------------------

/**
 * El `clientId` que viajó en el `Authorization: Basic` de `/v2/auth/token`.
 *
 * El header es `base64( base64(clientId) + ':' + base64(password) )`. Aquí se lee **sólo la
 * primera mitad**: el `clientId` es `V1:{EPR}:{PCC}:{Domain}` y ninguno de esos campos es
 * secreto —el PCC se imprime en el billete—. La segunda mitad es la contraseña de la oficina y
 * este test no la decodifica, no la compara y no la nombra.
 */
function clientIdDelHeader(header: string | undefined): string {
  const secret = (header ?? '').replace(/^Basic\s+/i, '');
  const mitades = Buffer.from(secret, 'base64').toString('utf8').split(':');
  return Buffer.from(mitades[0] ?? '', 'base64').toString('utf8');
}

/**
 * Respuesta ATPCO mínima de Bargain Finder Max v5 que el mapper real acepta y convierte en UNA
 * oferta canónica. Construida a mano —y no copiada de los fixtures del ACL— para que este test
 * no dependa de ficheros de otro paquete: lo que se prueba acá es la cadena BYOC, y el mapeo de
 * BFM ya tiene su propia suite contra los tres ejemplos oficiales.
 */
function respuestaBfm(): unknown {
  return {
    groupedItineraryResponse: {
      version: '5',
      messages: [],
      statistics: { itineraryCount: 1 },
      scheduleDescs: [
        {
          id: 1,
          stopCount: 0,
          elapsedTime: 195,
          departure: { airport: 'BOG', city: 'BOG', country: 'CO', time: '08:15:00-05:00' },
          arrival: { airport: 'LIM', city: 'LIM', country: 'PE', time: '11:30:00-05:00' },
          carrier: {
            marketing: 'AV',
            marketingFlightNumber: 960,
            operating: 'AV',
            operatingFlightNumber: 960,
            equipment: { code: '320' },
          },
        },
      ],
      legDescs: [{ id: 1, elapsedTime: 195, schedules: [{ ref: 1 }] }],
      itineraryGroups: [
        {
          groupDescription: {
            legDescriptions: [
              { departureDate: '2026-11-10', departureLocation: 'BOG', arrivalLocation: 'LIM' },
            ],
          },
          itineraries: [
            {
              id: 1,
              pricingSource: 'ADVJR1',
              legs: [{ ref: 1 }],
              pricingInformation: [
                {
                  pricingSubsource: 'HPIS',
                  fare: {
                    validatingCarrierCode: 'AV',
                    eTicketable: true,
                    lastTicketDate: '2026-11-01',
                    governingCarriers: 'AV',
                    passengerInfoList: [
                      {
                        passengerInfo: {
                          passengerType: 'ADT',
                          passengerNumber: 1,
                          nonRefundable: false,
                          fareComponents: [
                            {
                              ref: 1,
                              beginAirport: 'BOG',
                              endAirport: 'LIM',
                              segments: [
                                {
                                  segment: { bookingCode: 'Y', cabinCode: 'Y', seatsAvailable: 9 },
                                },
                              ],
                            },
                          ],
                          passengerTotalFare: {
                            totalFare: 250,
                            totalTaxAmount: 50,
                            currency: MONEDA,
                            baseFareAmount: 200,
                            baseFareCurrency: MONEDA,
                          },
                        },
                      },
                    ],
                    totalFare: {
                      totalPrice: 250,
                      totalTaxAmount: 50,
                      currency: MONEDA,
                      baseFareAmount: 200,
                      baseFareCurrency: MONEDA,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** Sabre local. Registra QUÉ identidad autenticó, que es lo que distingue una cuenta de otra. */
class SabreLocal {
  private server: Server | undefined;
  /** `clientId` de cada `/v2/auth/token`, en orden. Nunca la contraseña. */
  readonly clientIds: string[] = [];
  /** Cuántas búsquedas llegaron a `/v5/offers/shop`. */
  shops = 0;
  baseUrl = '';

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  reset(): void {
    this.clientIds.length = 0;
    this.shops = 0;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // El cuerpo se drena aunque no se lea: sin esto la conexión keep-alive queda a medias.
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.startsWith(SABRE_AUTH_PATH)) {
        this.clientIds.push(clientIdDelHeader(req.headers.authorization));
        this.json(res, {
          access_token: `atk-${randomUUID()}`,
          token_type: 'bearer',
          expires_in: 600,
        });
        return;
      }
      if (url.startsWith(SABRE_SHOP_PATH)) {
        this.shops += 1;
        this.json(res, respuestaBfm());
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  }

  private json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

// ---------------------------------------------------------------------------

d('BYOC de Sabre: de la credencial cargada a la búsqueda del vendedor', () => {
  const pool = new pg.Pool();
  const database = new DatabaseService();
  const sabreLocal = new SabreLocal();
  const sfx = randomBytes(4).toString('hex');

  let creds: ProviderCredentialsService;
  /**
   * El vendedor que busca. Es una fila REAL de `users`: `search_logs.actor_user_id` tiene FK
   * contra ella y la telemetría se traga sus propios errores (`record` captura y avisa). Con un
   * uuid inventado, cada búsqueda de este test escribiría cero filas sin que nada se pusiera
   * rojo — y la mitad "se registró la búsqueda" de la cadena quedaría sin probar.
   */
  let usuario: string;
  let consolidador: string;
  let agencia: string;
  let subagencia: string;
  /** Agencia de OTRA red, sin ancestro común: para el aislamiento cross-tenant. */
  let ajena: string;

  const envPrevio = new Map<string, string | undefined>();

  /** Una API montada con las piezas REALES. Se monta por test para no compartir cachés. */
  interface Api {
    controller: SearchController;
    registry: FlightProviderRegistry;
  }

  /**
   * `optIn` es el valor de `FLIGHT_PROVIDERS_OPT_IN`, que es hoy el interruptor por tenant de
   * un proveedor `opt-in` como Sabre. Se lee al construir `EnvProviderFlags`, así que tiene que
   * estar puesto ANTES de montar: por eso es un parámetro y no un `beforeAll`.
   */
  function montar(optIn: string): Api {
    process.env['FLIGHT_PROVIDERS_OPT_IN'] = optIn;

    const registry = new FlightProviderRegistry(
      [
        new SabreProviderFactory(creds),
        new StubProviderFactory({ code: OTRO_PROVEEDOR, callPolicy: 'always' }),
      ],
      new EnvProviderFlags(),
    );
    const service = new SearchService(
      registry,
      new PricingService(database),
      new SearchTelemetryService(database),
      new CircuitBreakerService(),
      // Caché propia de esta API: cada `montar` arranca sin resultados de un test anterior.
      new MemoryCacheAdapter(),
    );
    // El controlador resuelve además si los resultados nombran al proveedor (0036). Acá va
    // el servicio real contra la misma base: lo que se prueba es la búsqueda, y el ajuste
    // sólo añade un booleano al sobre.
    const controller = new SearchController(
      service,
      database,
      new ActiveTenantService(database),
      new ProviderDisclosureService(database),
    );
    return { controller, registry };
  }

  /** El criterio pasa por el mismo Zod que el `ZodValidationPipe` del endpoint. */
  function criterio(departureDate = '2026-11-10'): FlightSearchCriteria {
    return FlightSearchCriteriaSchema.parse({
      origin: 'BOG',
      destination: 'LIM',
      departureDate,
      paxCount: { adults: 1, children: 0, infants: 0 },
      currency: MONEDA,
    });
  }

  /** `POST /search/flights` tal como lo entrega el middleware de contexto de request. */
  function buscar(
    api: Api,
    tenantId: string,
    departureDate?: string,
  ): Promise<FlightSearchResponse> {
    return requestContextStorage.run({ userId: usuario, tenantId }, () =>
      api.controller.flights(usuario, criterio(departureDate)),
    );
  }

  function parteDe(res: FlightSearchResponse, code: string) {
    return res.providers.find((p) => p.code === code);
  }

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', $2, $3, $4) RETURNING id`,
      [slug, MONEDA, tipo, padre],
    );
    return rows[0]!.id;
  }

  /**
   * Carga credenciales de Sabre por la MISMA puerta que el panel: `ProviderCredentialsService`,
   * que cifra el blob y escribe en `provider_accounts`.
   *
   * `status` se pide siempre explícito a propósito: el default del servicio es `'sandbox'` y ése
   * es justo el desenlace que uno de los tests de abajo fija.
   */
  async function cargarCuentaSabre(opts: {
    tenantId: string;
    epr: string;
    homePcc: string;
    status: 'active' | 'sandbox' | 'disabled';
    isInheritable: boolean;
    /** Omitir un campo simula una carga incompleta desde el panel. */
    sinPassword?: boolean;
  }): Promise<void> {
    await creds.upsert({
      tenantId: opts.tenantId,
      providerCode: SABRE_PROVIDER_CODE,
      credentials: {
        epr: opts.epr,
        homePcc: opts.homePcc,
        ...(opts.sinPassword === true ? {} : { password: `pw-${opts.epr}` }),
      },
      config: {
        environment: 'cert',
        // La cuenta apunta al Sabre local. Es un campo de `config` que el ACL ya soporta,
        // no un gancho de test: `toConfig` lee `config.host` antes que el host del entorno.
        host: sabreLocal.baseUrl,
        soapHost: sabreLocal.baseUrl,
      },
      isInheritable: opts.isInheritable,
      status: opts.status,
    });
  }

  async function limpiarCuentas(): Promise<void> {
    await pool.query(`DELETE FROM provider_accounts WHERE tenant_id = ANY($1::uuid[])`, [
      [consolidador, agencia, subagencia, ajena],
    ]);
  }

  function fijarEnv(clave: string, valor: string | undefined): void {
    if (!envPrevio.has(clave)) envPrevio.set(clave, process.env[clave]);
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }

  beforeAll(async () => {
    // Clave de cifrado del blob BYOC. Es de usar y tirar: sólo vive en este proceso de test.
    fijarEnv('PROVIDER_CREDENTIALS_KEY', randomBytes(32).toString('base64'));
    // Overrides globales que cambiarían el desenlace sin que el test lo diga.
    fijarEnv('FLIGHT_PROVIDER_CALL_POLICIES', undefined);
    fijarEnv('PROVIDERS_DISABLED', undefined);
    fijarEnv('PLATFORM_DEFAULT_FLIGHT_PROVIDERS', undefined);
    fijarEnv('FLIGHT_PROVIDERS_OPT_IN', undefined);

    await sabreLocal.start();
    database.onModuleInit();
    creds = new ProviderCredentialsService(database);

    const nuevoUsuario = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`sb-${sfx}@test.local`],
    );
    usuario = nuevoUsuario.rows[0]!.id;

    consolidador = await crearTenant(`sb-cons-${sfx}`, 'consolidator', null);
    agencia = await crearTenant(`sb-ag-${sfx}`, 'agency', consolidador);
    subagencia = await crearTenant(`sb-sub-${sfx}`, 'subagency', agencia);
    ajena = await crearTenant(`sb-otra-${sfx}`, 'agency', null);
  });

  afterEach(async () => {
    await limpiarCuentas();
    sabreLocal.reset();
  });

  afterAll(async () => {
    // `parent_tenant_id` es ON DELETE RESTRICT: de hoja a raíz.
    for (const id of [subagencia, agencia, consolidador, ajena]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
    await sabreLocal.stop();
    for (const [clave, valor] of envPrevio) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
  });

  // -------------------------------------------------------------------------
  // 1. Cuenta PROPIA activa
  // -------------------------------------------------------------------------

  describe('cuenta propia y activa', () => {
    it('aparece en providers[] de POST /search/flights y sus ofertas llegan al vendedor', async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-PROPIO',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const res = await buscar(api, agencia);

      const sabre = parteDe(res, SABRE_PROVIDER_CODE);
      expect(sabre).toBeDefined();
      expect(sabre?.status).toBe('ok');
      expect(sabre?.simulated).toBe(false);
      expect(sabre?.count).toBe(1);
      expect(res.offers.some((o) => o.provider.name === SABRE_PROVIDER_CODE)).toBe(true);
    });

    it('sale al proveedor con la credencial del tenant, no con otra', async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-PROPIO',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      await buscar(api, agencia);

      // Lo único que demuestra QUÉ credencial se usó: el `clientId` que salió por el cable.
      // `V1:{EPR}:{PCC}:{Domain}`, con el default `AA` del ACL.
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-PROPIO:AG01:AA']);
      expect(sabreLocal.shops).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2 y 3. Herencia — el caso Planetour
  // -------------------------------------------------------------------------

  describe('herencia desde el consolidador', () => {
    it('el hijo sin cuenta propia busca con la credencial heredada del padre', async () => {
      await cargarCuentaSabre({
        tenantId: consolidador,
        epr: 'EPR-CONSOLIDADOR',
        homePcc: 'CN01',
        status: 'active',
        isInheritable: true,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const res = await buscar(api, subagencia);

      expect(parteDe(res, SABRE_PROVIDER_CODE)?.status).toBe('ok');
      // Dos saltos hacia arriba (subagencia → agencia → consolidador) y sale el PCC del padre.
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-CONSOLIDADOR:CN01:AA']);

      const { credentialSource } = await api.registry.byCode(subagencia, SABRE_PROVIDER_CODE);
      expect(credentialSource).toBe('inherited');
    });

    it('la cuenta PROPIA gana sobre la heredada', async () => {
      await cargarCuentaSabre({
        tenantId: consolidador,
        epr: 'EPR-CONSOLIDADOR',
        homePcc: 'CN01',
        status: 'active',
        isInheritable: true,
      });
      await cargarCuentaSabre({
        tenantId: subagencia,
        epr: 'EPR-SUB',
        homePcc: 'SB01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const res = await buscar(api, subagencia);

      expect(parteDe(res, SABRE_PROVIDER_CODE)?.status).toBe('ok');
      // El PCC del consolidador NO puede haber salido: la sub-agencia vende con su contrato.
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-SUB:SB01:AA']);

      const { credentialSource } = await api.registry.byCode(subagencia, SABRE_PROVIDER_CODE);
      expect(credentialSource).toBe('own');
    });

    it('is_inheritable = false en el padre corta la herencia: el hijo no resuelve', async () => {
      await cargarCuentaSabre({
        tenantId: consolidador,
        epr: 'EPR-CONSOLIDADOR',
        homePcc: 'CN01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const propio = await buscar(api, consolidador);
      const heredero = await buscar(api, subagencia);

      // El dueño sí busca con ella; el descendiente no la ve.
      expect(parteDe(propio, SABRE_PROVIDER_CODE)?.status).toBe('ok');
      expect(parteDe(heredero, SABRE_PROVIDER_CODE)).toBeUndefined();
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-CONSOLIDADOR:CN01:AA']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. La trampa del sandbox
  // -------------------------------------------------------------------------

  describe('la cuenta cargada que no habilita nada', () => {
    it("status 'sandbox' no resuelve: la credencial existe, el panel la lista y Sabre no aparece", async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-SANDBOX',
        homePcc: 'AG01',
        status: 'sandbox',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const cuentas = await creds.listSafe(agencia);
      const res = await buscar(api, agencia);

      // Las dos mitades de la avería, juntas: el operador VE su cuenta cargada…
      expect(cuentas.map((c) => [c.providerCode, c.status])).toEqual([
        [SABRE_PROVIDER_CODE, 'sandbox'],
      ]);
      // …y la búsqueda no la menciona de ninguna forma. Ni activa, ni saltada, ni con error.
      expect(parteDe(res, SABRE_PROVIDER_CODE)).toBeUndefined();
      expect(sabreLocal.clientIds).toEqual([]);
    });

    it("promover la MISMA cuenta a 'active' la habilita, sin tocar nada más", async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-SANDBOX',
        homePcc: 'AG01',
        status: 'sandbox',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);
      expect(parteDe(await buscar(api, agencia), SABRE_PROVIDER_CODE)).toBeUndefined();

      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-SANDBOX',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });

      // Criterio distinto: la respuesta anterior sigue en la caché de búsqueda y la promoción
      // de la cuenta no la invalida (ver el test de rotación, más abajo).
      const despues = await buscar(api, agencia, '2026-11-11');
      expect(parteDe(despues, SABRE_PROVIDER_CODE)?.status).toBe('ok');
    });

    it("el flag 'opt-in' apagado deja a Sabre SALTADO, que no es lo mismo que ausente", async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-PROPIO',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      // Sin `FLIGHT_PROVIDERS_OPT_IN`: credenciales correctas y activas, proveedor apagado.
      const api = montar('');

      const res = await buscar(api, agencia);

      const sabre = parteDe(res, SABRE_PROVIDER_CODE);
      expect(sabre?.status).toBe('skipped');
      expect(sabre?.skipReason).toBe('opt-in-disabled');
      // El flag se consulta ANTES de la bóveda: la credencial no llega ni a descifrarse.
      expect(sabreLocal.clientIds).toEqual([]);
    });

    it('el flag por tenant activa a uno y deja al otro fuera', async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-AG',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      await cargarCuentaSabre({
        tenantId: ajena,
        epr: 'EPR-AJENA',
        homePcc: 'OT01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(`${SABRE_PROVIDER_CODE}@${agencia}`);

      const conFlag = await buscar(api, agencia);
      const sinFlag = await buscar(api, ajena);

      expect(parteDe(conFlag, SABRE_PROVIDER_CODE)?.status).toBe('ok');
      expect(parteDe(sinFlag, SABRE_PROVIDER_CODE)?.status).toBe('skipped');
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-AG:AG01:AA']);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Sin cuenta: AUSENTE, nunca en mock
  // -------------------------------------------------------------------------

  describe('sin credencial resoluble', () => {
    it('Sabre queda ausente del fan-out y no se cuela ni una oferta suya', async () => {
      const api = montar(SABRE_PROVIDER_CODE);

      const res = await buscar(api, ajena);

      expect(res.offers).not.toHaveLength(0); // el otro proveedor sí respondió
      expect(res.offers.some((o) => o.provider.name === SABRE_PROVIDER_CODE)).toBe(false);
      // Ausente NO es invisible: Sabre sale en el parte con el motivo, para que la pantalla
      // pueda explicar por qué hay menos ofertas en vez de dejar al vendedor leyéndolo como
      // "no hay vuelos por esa ruta".
      const parte = parteDe(res, SABRE_PROVIDER_CODE);
      expect(parte?.status).toBe('unavailable');
      expect(parte?.count).toBe(0);
      expect(parte?.unavailableReason).toBe('no-credentials');
      // `simulated` es la señal vieja de "todo esto es inventado". Es residuo y ya no se
      // enciende nunca: ningún adapter puede fabricar una tarifa.
      expect(res.simulated).toBe(false);
      expect(res.providers.every((p) => p.simulated === false)).toBe(true);
      expect(sabreLocal.clientIds).toEqual([]);
      expect(sabreLocal.shops).toBe(0);
    });

    it('una cuenta activa pero INCOMPLETA tampoco cae en mock silencioso', async () => {
      // Sin `password` el ACL arrancaba en modo fixtures: mismas ofertas canónicas, precios
      // inventados. Ese modo ya no existe; el factory rechaza la cuenta y el proveedor queda
      // fuera, nombrado.
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-INCOMPLETO',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
        sinPassword: true,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const res = await buscar(api, agencia);

      const parte = parteDe(res, SABRE_PROVIDER_CODE);
      expect(parte?.status).toBe('unavailable');
      // Cuenta cargada a medias: el motivo dice COMPLETAR, no cargar. Son dos pantallas.
      expect(parte?.unavailableReason).toBe('incomplete-account');
      expect(parte?.reason).toContain('password');
      expect(res.offers.some((o) => o.provider.name === SABRE_PROVIDER_CODE)).toBe(false);
      expect(res.simulated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Aislamiento cross-tenant (exigido por CLAUDE.md)
  // -------------------------------------------------------------------------

  describe('aislamiento entre tenants', () => {
    it('el adapter de un tenant no se le entrega a otro, y cada uno sale con su PCC', async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-AG',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      await cargarCuentaSabre({
        tenantId: ajena,
        epr: 'EPR-AJENA',
        homePcc: 'OT01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const unoA = await api.registry.byCode(agencia, SABRE_PROVIDER_CODE);
      const unoB = await api.registry.byCode(ajena, SABRE_PROVIDER_CODE);
      // Compartir instancia es compartir el caché de token: una agencia saldría al GDS con el
      // ATK de la otra y cotizaría con un PCC que no es el suyo.
      expect(unoA.adapter).not.toBe(unoB.adapter);

      sabreLocal.reset();
      await buscar(api, agencia);
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-AG:AG01:AA']);

      sabreLocal.reset();
      await buscar(api, ajena);
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-AJENA:OT01:AA']);
    });

    it('dos tenants que HEREDAN la misma cuenta comparten instancia, y eso es correcto', async () => {
      await cargarCuentaSabre({
        tenantId: consolidador,
        epr: 'EPR-CONSOLIDADOR',
        homePcc: 'CN01',
        status: 'active',
        isInheritable: true,
      });
      const api = montar(SABRE_PROVIDER_CODE);

      const desdeAgencia = await api.registry.byCode(agencia, SABRE_PROVIDER_CODE);
      const desdeSub = await api.registry.byCode(subagencia, SABRE_PROVIDER_CODE);

      // Son las MISMAS credenciales del consolidador: el caché de token es por credencial, no
      // por tenant. No filtra nada y evita pedir un ATK por cada agencia de la red — el TAM
      // Pool de Sabre es un límite por contrato de agencia.
      expect(desdeAgencia.adapter).toBe(desdeSub.adapter);
    });

    it('rotar las credenciales descarta la instancia cacheada', async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-VIEJO',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);
      const antes = await api.registry.byCode(agencia, SABRE_PROVIDER_CODE);
      await buscar(api, agencia);

      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-NUEVO',
        homePcc: 'AG02',
        status: 'active',
        isInheritable: false,
      });
      const despues = await api.registry.byCode(agencia, SABRE_PROVIDER_CODE);

      expect(despues.adapter).not.toBe(antes.adapter);

      // Y la credencial revocada ya no sale por el cable. Criterio distinto a propósito: la
      // rotación NO invalida la caché de resultados, así que repetir la búsqueda anterior
      // devolvería la respuesta calculada con el EPR viejo.
      sabreLocal.reset();
      await buscar(api, agencia, '2026-11-12');
      expect(sabreLocal.clientIds).toEqual(['V1:EPR-NUEVO:AG02:AA']);
    });

    it('la caché de resultados NO se invalida al rotar credenciales (comportamiento actual)', async () => {
      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-VIEJO',
        homePcc: 'AG01',
        status: 'active',
        isInheritable: false,
      });
      const api = montar(SABRE_PROVIDER_CODE);
      await buscar(api, agencia);

      await cargarCuentaSabre({
        tenantId: agencia,
        epr: 'EPR-NUEVO',
        homePcc: 'AG02',
        status: 'active',
        isInheritable: false,
      });
      sabreLocal.reset();
      await buscar(api, agencia); // MISMO criterio que la primera

      // Nadie llama a `MemoryCacheAdapter.invalidatePattern` desde el flujo de credenciales,
      // así que durante la ventana de 90 s el vendedor sigue viendo el resultado calculado con
      // la credencial revocada. Este test FIJA el comportamiento de hoy; no lo bendice.
      expect(sabreLocal.clientIds).toEqual([]);
      expect(sabreLocal.shops).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Degradación parcial: la ausencia de Sabre no puede tumbar la búsqueda
  // -------------------------------------------------------------------------

  it('con Sabre ausente el resto del fan-out sigue vendiendo', async () => {
    const api = montar(SABRE_PROVIDER_CODE);

    const res = await buscar(api, ajena);

    const otro = parteDe(res, OTRO_PROVEEDOR);
    expect(otro?.status).toBe('ok');
    expect(otro?.count).toBeGreaterThan(0);
  });

  it('con Sabre resuelto la respuesta suma ofertas de los dos proveedores', async () => {
    await cargarCuentaSabre({
      tenantId: agencia,
      epr: 'EPR-PROPIO',
      homePcc: 'AG01',
      status: 'active',
      isInheritable: false,
    });
    const api = montar(SABRE_PROVIDER_CODE);

    const res = await buscar(api, agencia);

    expect(res.providers.map((p) => p.code)).toEqual([SABRE_PROVIDER_CODE, OTRO_PROVEEDOR]);
    expect(new Set(res.offers.map((o) => o.provider.name))).toEqual(
      new Set([SABRE_PROVIDER_CODE, OTRO_PROVEEDOR]),
    );
  });
});

// ---------------------------------------------------------------------------
// Sonda de mutación: sin Postgres estos tests se SALTAN enteros, así que la única
// afirmación que puede correr siempre es la del lector del header de autenticación —
// que es lo que convierte «Sabre respondió» en «Sabre respondió A ESTA cuenta».
// ---------------------------------------------------------------------------

describe('lectura del clientId de Sabre', () => {
  it('extrae el clientId y no toca la mitad secreta del header', () => {
    const clientId = 'V1:EPR-X:AG01:AA';
    const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
    const header = `Basic ${b64(`${b64(clientId)}:${b64('password-de-la-oficina')}`)}`;

    expect(clientIdDelHeader(header)).toBe(clientId);
  });

  it('no explota con un header ausente o basura', () => {
    expect(clientIdDelHeader(undefined)).toBe('');
    expect(() => clientIdDelHeader('Basic ???')).not.toThrow();
  });
});
