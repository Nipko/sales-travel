import { randomBytes } from 'node:crypto';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import { OrderCreateNotSentError, type OrderCreateRequest } from '@sales-travel/domain';
import {
  REDACTED,
  SabreApiError,
  SabreFlightCheckRequestError,
  SabreGetBookingBuildError,
  SabreOrderCreateInputError,
  SabrePriceRequestError,
} from '@sales-travel/sabre';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { encryptCredentials } from '../provider-credentials/credentials-cipher.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import type { ResolvedProviderAccount } from '../provider-credentials/provider-credentials.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  supportsAuditedCancel,
  supportsAuditedCreate,
  type ProviderFlagsPort,
} from '../providers/provider.types.js';
import { ENCENDIDO } from '../providers/__fixtures__/provider-flags.js';
import { SabreOperationNotSupportedError } from './sabre-errors.js';
import {
  SABRE_PROVIDER_CODE,
  SabreOfferRevalidationRouter,
  SabreProviderFactory,
  sabreShopOptionsFromAccountConfig,
} from './sabre.factory.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/** Valores que NUNCA pueden aparecer en un mensaje de error ni en un log. */
const EPR = 'EPR-DE-LA-OFICINA';
const PASSWORD = 'p4ssw0rd-de-la-oficina';
const HOME_PCC = 'A1B2';

function resolved(overrides: Partial<ResolvedProviderAccount> = {}): ResolvedProviderAccount {
  return {
    id: 'acc-sabre-1',
    ownerTenantId: 'owner-1',
    providerCode: SABRE_PROVIDER_CODE,
    label: 'default',
    config: {},
    credentials: { epr: EPR, password: PASSWORD, homePcc: HOME_PCC },
    inherited: false,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function factoryWith(resolve: ProviderCredentialsService['resolve']): SabreProviderFactory {
  return new SabreProviderFactory({ resolve } as unknown as ProviderCredentialsService);
}

describe('SabreProviderFactory — resolución BYOC', () => {
  it('reutiliza la instancia para las mismas credenciales (cache del ATK)', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    expect(await factory.forTenant('t1')).toBe(await factory.forTenant('t1'));
  });

  it('reconstruye el adapter cuando rotan las credenciales (cambia updatedAt)', async () => {
    let updatedAt = new Date('2026-01-01T00:00:00Z');
    const factory = factoryWith(() => Promise.resolve(resolved({ updatedAt })));
    const antes = await factory.forTenant('t1');
    updatedAt = new Date('2026-02-01T00:00:00Z');
    expect(await factory.forTenant('t1')).not.toBe(antes);
  });

  it('reconstruye el adapter cuando cambia el homePcc con el mismo updatedAt', async () => {
    // El PCC entra en el `clientId` del que se deriva el ATK: dos PCC no pueden compartir token.
    let homePcc = 'A1B2';
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: { epr: EPR, password: PASSWORD, homePcc } })),
    );
    const antes = await factory.forTenant('t1');
    homePcc = 'C3D4';
    expect(await factory.forTenant('t1')).not.toBe(antes);
  });

  it('marca la credencial como propia o heredada según el ancestro que la resolvió', async () => {
    const propia = factoryWith(() => Promise.resolve(resolved({ inherited: false })));
    const heredada = factoryWith(() => Promise.resolve(resolved({ inherited: true })));
    expect((await propia.resolveForTenant('t1')).credentialSource).toBe('own');
    expect((await heredada.resolveForTenant('t1')).credentialSource).toBe('inherited');
  });

  it('propaga los errores que NO son NotFound (bóveda caída, credencial corrupta)', async () => {
    const factory = factoryWith(() => Promise.reject(new Error('db down')));
    await expect(factory.forTenant('t1')).rejects.toThrow('db down');
  });
});

describe('SabreProviderFactory — Sabre NO tiene fallback a credenciales de plataforma (D5)', () => {
  it('sin cuenta resoluble, el proveedor no se construye: lanza NotFound, no cae a env', async () => {
    const factory = factoryWith(() => Promise.reject(new NotFoundException('none')));
    await expect(factory.forTenant('t1')).rejects.toThrow(NotFoundException);
  });

  it('con la cuenta incompleta el proveedor queda AUSENTE en vez de servir fixtures', async () => {
    // Éste es el fallo caro: `SabreFlightSearchAdapter` cae a mock en cuanto falta una de las
    // tres credenciales, y sus fixtures tienen la misma forma canónica que las tarifas reales.
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: { epr: EPR, homePcc: HOME_PCC } })),
    );
    await expect(factory.forTenant('t1')).rejects.toThrow(NotFoundException);
  });

  it('el motivo nombra el CAMPO que falta y jamás el valor de ninguna credencial', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: { epr: EPR, homePcc: HOME_PCC } })),
    );

    const err = await factory.forTenant('t1').catch((e: unknown) => e);
    const texto = err instanceof Error ? err.message : String(err);
    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    warn.mockRestore();

    expect(texto).toContain('password');
    for (const secreto of [EPR, PASSWORD, HOME_PCC]) {
      expect(texto).not.toContain(secreto);
      expect(logueado).not.toContain(secreto);
    }
  });

  it('`config.mock` ya no habilita nada: sin credenciales la cuenta no resuelve', async () => {
    // El modo simulado se retiro entero (decision del founder, 2026-08-27): fabricar precios con
    // forma de tarifa real y ponerlos delante de un vendedor que los va a cotizar es el peor fallo
    // que puede tener este producto. Una cuenta sin credenciales queda AUSENTE, no simulada.
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: {}, config: { mock: true } })),
    );
    await expect(factory.forTenant('t1')).rejects.toThrow();
  });

  it('con las tres credenciales completas el adapter se construye', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    await expect(factory.forTenant('t1')).resolves.toBeDefined();
  });
});

/**
 * La contraseña se lee SÓLO del blob cifrado.
 *
 * `toConfig` lo promete en un comentario y hasta ahora nada lo sujetaba: añadirle
 * `?? str(g['password'])` —igual que ya tienen `epr` y `homePcc`— dejaba la suite entera en
 * verde. Con eso, una cuenta cargada por API podía guardar la contraseña de la oficina en un
 * JSONB en claro y encima funcionar, que es lo que convierte el atajo en permanente.
 *
 * Estos dos tests son el mutante: con la lectura desde `config` añadida, el primero deja de
 * lanzar y el segundo deja de nombrar `password`.
 */
describe('SabreProviderFactory — la contraseña no se lee de `config`', () => {
  const soloEnConfig = () =>
    factoryWith(() =>
      Promise.resolve(
        resolved({ credentials: { epr: EPR, homePcc: HOME_PCC }, config: { password: PASSWORD } }),
      ),
    );

  it('una contraseña puesta en `config` NO completa la cuenta: el proveedor sigue ausente', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(soloEnConfig().forTenant('t1')).rejects.toThrow(NotFoundException);
    warn.mockRestore();
  });

  it('y el motivo sigue siendo que falta `password`, sin hacer eco de su valor', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const err = await soloEnConfig()
      .forTenant('t1')
      .catch((e: unknown) => e);
    warn.mockRestore();

    const texto = err instanceof Error ? err.message : String(err);
    expect(texto).toContain('password');
    expect(texto).not.toContain(PASSWORD);
  });
});

describe('SabreProviderFactory — entorno', () => {
  const llamadas: string[] = [];

  beforeEach(() => {
    llamadas.length = 0;
    vi.stubGlobal('fetch', (input: unknown) => {
      llamadas.push(String(input));
      // 400 => CLIENT_BUG => NO_RETRY: una sola llamada, sin backoff, test instantáneo.
      return Promise.resolve(new Response('{"error":"invalid_request"}', { status: 400 }));
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function primeraUrl(config: Record<string, unknown>): Promise<string> {
    const factory = factoryWith(() => Promise.resolve(resolved({ config })));
    const adapter = await factory.forTenant('t1');
    await adapter
      .search(
        {
          origin: 'BOG',
          destination: 'LIM',
          departureDate: '2026-12-01',
          paxCount: { adults: 1, children: 0, infants: 0 },
          currency: 'USD',
        },
        { tenantId: 't1' },
      )
      .catch(() => undefined);
    return llamadas[0] ?? '';
  }

  it('una cuenta sin `environment` sale a CERT, nunca a producción', async () => {
    expect(await primeraUrl({})).toContain('https://api.cert.platform.sabre.com');
  });

  it('sólo `environment: "prod"` explícito sale a producción', async () => {
    expect(await primeraUrl({ environment: 'prod' })).toContain('https://api.platform.sabre.com/');
  });

  it('un `environment` desconocido cae a CERT en vez de a producción', async () => {
    expect(await primeraUrl({ environment: 'produccion' })).toContain('api.cert.platform.sabre');
  });
});

describe('SabreProviderFactory — la cuenta declara si es de pruebas', () => {
  async function entornoDe(config: Record<string, unknown>): Promise<string | undefined> {
    const factory = factoryWith(() => Promise.resolve(resolved({ config })));
    return (await factory.resolveForTenant('t1')).providerEnvironment;
  }

  it('CERT (sin `environment`) es una cuenta de pruebas: sus tarifas salen marcadas', async () => {
    expect(await entornoDe({})).toBe('test');
  });

  it('un `environment` desconocido, igual que CERT: de pruebas, nunca real', async () => {
    expect(await entornoDe({ environment: 'produccion' })).toBe('test');
    expect(await entornoDe({ environment: 'cert' })).toBe('test');
  });

  it('sólo `prod` explícito es una cuenta real', async () => {
    expect(await entornoDe({ environment: 'prod' })).toBe('live');
  });

  it('el adapter cacheado sale con el mismo entorno que el recién construido', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));

    const primera = await factory.resolveForTenant('t1');
    const segunda = await factory.resolveForTenant('t1');

    expect(segunda.adapter).toBe(primera.adapter);
    expect([primera.providerEnvironment, segunda.providerEnvironment]).toEqual(['test', 'test']);
  });

  it('el registry lo entrega a la búsqueda y a la venta', async () => {
    const registry = new FlightProviderRegistry([factoryWith(() => Promise.resolve(resolved()))], {
      decisionFor: () => Promise.resolve(ENCENDIDO),
    });

    const { active } = await registry.forTenant('t1');
    expect(active.map((p) => p.environment)).toEqual(['test']);
    expect((await registry.byCodeForOffer('t1', SABRE_PROVIDER_CODE)).environment).toBe('test');
  });
});

describe('SabreProviderFactory — shopOptions por cuenta', () => {
  it('sin configuración aplica single, cero rondas pagadas, MFPI apagado y sin NDC', () => {
    const parsed = sabreShopOptionsFromAccountConfig({});
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.options).toMatchObject({
      brandedFares: 'single',
      brandLadderRounds: 0,
      upsellLimit: 3,
      multipleFares: 'off',
      ndcContent: false,
    });
  });

  it('convierte los valores del formulario y conserva las cinco palancas', () => {
    const parsed = sabreShopOptionsFromAccountConfig({
      brandedFares: 'upsell',
      brandLadderRounds: '2',
      upsellLimit: '5',
      multipleFares: 'with-baggage',
      ndcContent: 'true',
    });
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.options).toMatchObject({
      brandedFares: 'upsell',
      brandLadderRounds: 2,
      upsellLimit: 5,
      multipleFares: 'with-baggage',
      ndcContent: true,
    });
  });

  it.each([
    ['el texto "true" del select', 'true', true],
    ['el texto "false" del select', 'false', false],
    ['el texto con espacios del borde', ' true ', true],
    ['un booleano de un POST directo', true, true],
    ['un false de un POST directo', false, false],
  ] as const)('ndcContent acepta %s', (_caso, valor, esperado) => {
    const parsed = sabreShopOptionsFromAccountConfig({ ndcContent: valor });
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.options.ndcContent).toBe(esperado);
  });

  it.each([['TRUE'], ['1'], ['on'], ['sí'], [1], ['']])(
    'ndcContent=%j no se adivina: cae al conjunto conservador, con NDC apagado',
    (valor) => {
      const parsed = sabreShopOptionsFromAccountConfig({ ndcContent: valor, brandedFares: 'off' });
      expect(parsed.invalidFields).toEqual(['ndcContent']);
      // Conservador ENTERO, no sólo NDC: también vuelve `brandedFares` a su default.
      expect(parsed.options).toMatchObject({ ndcContent: false, brandedFares: 'single' });
    },
  );

  it('una entrada manipulada cae al conjunto conservador y sólo revela nombres de campo', () => {
    const parsed = sabreShopOptionsFromAccountConfig({
      brandedFares: 'todas-siempre',
      brandLadderRounds: '2.5',
      upsellLimit: '-1',
      multipleFares: 'todo',
      ndcContent: 'encendidisimo',
    });
    expect(parsed.invalidFields).toEqual([
      'brandLadderRounds',
      'brandedFares',
      'multipleFares',
      'ndcContent',
      'upsellLimit',
    ]);
    expect(parsed.options).toMatchObject({
      brandedFares: 'single',
      brandLadderRounds: 0,
      upsellLimit: 3,
      multipleFares: 'off',
      ndcContent: false,
    });
    expect(JSON.stringify(parsed)).not.toContain('todas-siempre');
    expect(JSON.stringify(parsed)).not.toContain('encendidisimo');
  });

  /** Busca con la cuenta indicada y devuelve los cuerpos de shop que salieron por `fetch`. */
  async function shopBodiesFor(config: Record<string, unknown>): Promise<string[]> {
    const shopBodies: string[] = [];
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/v2/auth/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'ATK-DE-PRUEBA', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (typeof init?.body === 'string') shopBodies.push(init.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            groupedItineraryResponse: { version: '5', messages: [], itineraryGroups: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    try {
      const factory = factoryWith(() => Promise.resolve(resolved({ config })));
      const adapter = await factory.forTenant('t1');
      await adapter.search(
        {
          origin: 'BOG',
          destination: 'LIM',
          departureDate: '2026-12-01',
          paxCount: { adults: 1, children: 0, infants: 0 },
          currency: 'USD',
        },
        { tenantId: 't1' },
      );
    } finally {
      vi.unstubAllGlobals();
    }
    return shopBodies;
  }

  it('pasa las opciones parseadas al adapter que construye el request BFM', async () => {
    const [firstRequest = ''] = await shopBodiesFor({
      brandedFares: 'upsell',
      brandLadderRounds: '2',
      upsellLimit: '5',
      multipleFares: 'with-baggage',
      ndcContent: 'true',
    });

    expect(firstRequest).toContain('"SingleBrandedFare":true');
    expect(firstRequest).toContain('"MultipleBrandedFares":true');
    expect(firstRequest).toContain('"UpsellLimit":5');
    expect(firstRequest).toContain('"FlexibleFares"');
    expect(firstRequest).toContain(
      '"DataSources":{"NDC":"Enable","ATPCO":"Enable","LCC":"Disable"}',
    );
  });

  it('una cuenta que no dice nada de NDC no lo pide a Sabre', async () => {
    const bodies = await shopBodiesFor({});

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toContain('"DataSources":{"NDC":"Disable","ATPCO":"Enable","LCC":"Disable"}');
    }
  });

  it('el "false" del formulario apaga NDC: no lo enciende por ser una cadena no vacía', async () => {
    const bodies = await shopBodiesFor({ ndcContent: 'false' });

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).toContain('"NDC":"Disable"');
  });
});

describe('SabreProviderFactory — alcance real de Sabre', () => {
  it('declara `retrieve` y `cancel`, que son las que sabe hacer', () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    expect(factory.capabilities).toEqual({
      retrieve: true,
      cancel: true,
      // `pay`, `services` y `reshop` NO son operaciones de este contrato: no es un cableado
      // pendiente. `OrdersController.assertSupports` las rechaza con un mensaje claro.
      pay: false,
      services: false,
      reshop: false,
    });
  });

  it('`retrieve` en true no es cosmético: es lo que permite CERRAR una creación verificándola', () => {
    // El saga de creación consulta esta capacidad antes de gastar la lectura de cierre. Con
    // `retrieve: false`, `planVerification` escala TODA creación de Sabre en vez de cerrarla.
    const factory = factoryWith(() => Promise.resolve(resolved()));
    expect(factory.capabilities.retrieve).toBe(true);
  });

  it('arranca en `always`: cotiza por defecto cuando la cuenta está activa', () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    expect(factory.defaultCallPolicy).toBe('always');
  });

  it.each([
    [
      'cancelBnplOrder',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.cancelBnplOrder('X', { tenantId: 't1' }),
    ],
    [
      'payOrder',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.payOrder({} as never, { tenantId: 't1' }),
    ],
    [
      'listServices',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.listServices({} as never, { tenantId: 't1' }),
    ],
    [
      'reshopWithTickets',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.reshopWithTickets({} as never, { tenantId: 't1' }),
    ],
  ])(
    '%s sigue fallando ruidosamente: no es una operación de este contrato',
    async (_nombre, invocar) => {
      const factory = factoryWith(() => Promise.resolve(resolved()));
      const adapter = await factory.forTenant('t1');
      await expect(invocar(adapter)).rejects.toThrow(SabreOperationNotSupportedError);
    },
  );
});

/**
 * El CABLEADO de price/create/get/cancel, probado por la puerta pública del factory.
 *
 * Ninguno de estos tests toca la red, y no por comodidad: cada operación del ACL VALIDA su
 * entrada antes de armar la petición, así que una entrada inválida produce el error tipado del
 * módulo correspondiente **antes** de que exista una llamada HTTP. Eso es justo lo que hace de
 * estos tests una sonda del cableado y no una tautología: un adapter que siguiera rechazando con
 * `SabreOperationNotSupportedError` —el estado anterior a esta tanda— no podría producir un
 * `SabrePriceRequestError` ni un `SabreGetBookingBuildError` ni de casualidad.
 *
 * Es la sonda de comportamiento que exige la regla 2: si alguien revierte el cableado, estos
 * cuatro se ponen rojos; si no lo revierte, ninguno lo hace.
 */
describe('SabreProviderFactory — price/create/get/cancel están CABLEADOS al ACL', () => {
  const ctx = { tenantId: 't1' };

  async function adapterReal(): Promise<Awaited<ReturnType<SabreProviderFactory['forTenant']>>> {
    return factoryWith(() => Promise.resolve(resolved())).forTenant('t1');
  }

  it('priceOffer llega al builder de price: una oferta sin ids de offerItem lo dice', async () => {
    const adapter = await adapterReal();
    const offer = { provider: { name: 'sabre', source: 'NDC', raw: {} } } as never;

    await expect(adapter.priceOffer(offer, {} as never, ctx)).rejects.toBeInstanceOf(
      SabrePriceRequestError,
    );
  });

  it('ATPCO llega a Flight Check: una oferta sin itinerario falla en su builder local', async () => {
    const adapter = await adapterReal();
    const offer = {
      tenantId: 't1',
      provider: { name: 'sabre', source: 'ATPCO', raw: {} },
    } as never;

    await expect(adapter.priceOffer(offer, {} as never, ctx)).rejects.toBeInstanceOf(
      SabreFlightCheckRequestError,
    );
  });

  it('createOrder llega al builder de createBooking: una oferta sin nada reservable lo dice', async () => {
    const adapter = await adapterReal();
    const request = {
      offer: { provider: { name: 'sabre', raw: {} }, itineraries: [] },
      criteria: {},
      passengers: [],
      contactInfo: { email: 'a@b.test', phone: '+573000000000' },
    } as never;

    // «No salió a la red» es un contrato del PUERTO, no de Sabre: el saga lo lee para liberar la
    // cotización en vez de bloquearla como resultado incierto. La causa de Sabre viaja dentro.
    const thrown = await adapter.createOrder(request, ctx).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(OrderCreateNotSentError);
    expect((thrown as Error).cause).toBeInstanceOf(SabreOrderCreateInputError);
  });

  it('retrieveForDisplay llega al builder de getBooking: un localizador inválido lo dice', async () => {
    const adapter = await adapterReal();
    // `X` no cumple `^[A-Z0-9]{6,}$`: el builder lo rechaza sin salir a la red.
    await expect(adapter.retrieveForDisplay('X', ctx)).rejects.toBeInstanceOf(
      SabreGetBookingBuildError,
    );
  });

  it('cancelOrder empieza por la LECTURA, y por eso rechaza igual el localizador inválido', async () => {
    const adapter = await adapterReal();
    await expect(adapter.cancelOrder('X', ctx)).rejects.toBeInstanceOf(SabreGetBookingBuildError);
  });

  it('expone los puertos auditados que el saga necesita para el `domain_event`', async () => {
    const adapter = await adapterReal();
    expect(supportsAuditedCreate(adapter)).toBe(true);
    expect(supportsAuditedCancel(adapter)).toBe(true);
  });
});

describe('SabreOfferRevalidationRouter — carril por fuente', () => {
  const result = { offer: {} as never, priceChanged: false, warnings: [] };
  const criteria = {} as never;
  const ctx = { tenantId: 't1' };

  it('NDC conserva Offer Price', async () => {
    const ndc = { priceOffer: vi.fn(() => Promise.resolve(result)) };
    const atpco = { priceOffer: vi.fn(() => Promise.resolve(result)) };
    const router = new SabreOfferRevalidationRouter(ndc, atpco);
    const offer = { provider: { source: 'NDC' } } as never;

    await router.priceOffer(offer, criteria, ctx);

    expect(ndc.priceOffer).toHaveBeenCalledOnce();
    expect(atpco.priceOffer).not.toHaveBeenCalled();
  });

  it.each(['ATPCO', undefined])('%s usa Flight Check payload-based', async (source) => {
    const ndc = { priceOffer: vi.fn(() => Promise.resolve(result)) };
    const atpco = { priceOffer: vi.fn(() => Promise.resolve(result)) };
    const router = new SabreOfferRevalidationRouter(ndc, atpco);
    const offer = { provider: { source } } as never;

    await router.priceOffer(offer, criteria, ctx);

    expect(atpco.priceOffer).toHaveBeenCalledOnce();
    expect(ndc.priceOffer).not.toHaveBeenCalled();
  });

  it('LCC falla de forma soportada y nunca se envía al contrato ATPCO de Flight Check', async () => {
    const ndc = { priceOffer: vi.fn(() => Promise.resolve(result)) };
    const atpco = { priceOffer: vi.fn(() => Promise.resolve(result)) };
    const router = new SabreOfferRevalidationRouter(ndc, atpco);
    const offer = { provider: { source: 'LCC' } } as never;

    await expect(router.priceOffer(offer, criteria, ctx)).rejects.toMatchObject({
      name: 'SabreOperationNotSupportedError',
      operation: 'revalidar una oferta LCC con Flight Check',
    });
    expect(ndc.priceOffer).not.toHaveBeenCalled();
    expect(atpco.priceOffer).not.toHaveBeenCalled();
  });
});

/**
 * Una cuenta en mock DECLARADO busca, pero NO reserva.
 *
 * Las fixtures tienen la misma forma canónica que las tarifas reales —ése es el punto— así que
 * nada en la pantalla del vendedor distingue un precio inventado de uno de verdad. Reservar
 * contra uno de esos precios produce un PNR que no existe.
 */
describe('SabreProviderFactory — mock declarado no reserva', () => {
  const ctx = { tenantId: 't1' };

  /** Cuenta con `mock: true` y SIN credenciales: es la única forma declarada de correr en mock. */
  function mockResolved(): ResolvedProviderAccount {
    return resolved({ credentials: {}, config: { mock: true } });
  }

  it.each([
    [
      'priceOffer',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.priceOffer({} as never, {} as never, ctx),
    ],
    [
      'createOrder',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.createOrder({} as never, ctx),
    ],
    [
      'retrieveForDisplay',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) =>
        a.retrieveForDisplay('ABC123', ctx),
    ],
    [
      'cancelOrder',
      (a: Awaited<ReturnType<SabreProviderFactory['forTenant']>>) => a.cancelOrder('ABC123', ctx),
    ],
  ])(
    '%s ya no puede ejecutarse contra fixtures: la cuenta sin credenciales no resuelve',
    async (_n, invocar) => {
      void invocar;
      const factory = factoryWith(() => Promise.resolve(mockResolved()));
      await expect(factory.forTenant('t1')).rejects.toThrow();
    },
  );
});

describe('SabreProviderFactory — humanizeError no hace eco del proveedor', () => {
  it('un cuerpo con datos del pasajero no aparece en el mensaje del vendedor', () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    const err = new SabreApiError(
      403,
      JSON.stringify({ message: 'passport AB1234567 rejected for CARDOSO/MARIA' }),
      '/v5/offers/shop',
    );
    const mensaje = factory.humanizeError(err);
    expect(mensaje).not.toContain('AB1234567');
    expect(mensaje).not.toContain('CARDOSO');
    expect(mensaje).toContain('PCC');
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Lo que el factory INYECTA: logger, cliente compartido y las dos mitades de la cuenta
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Por el adapter que devuelve el factory y con `fetch` global interceptado: es exactamente lo que
 * corre en producción. Sabre no se llama — cada ruta tiene su respuesta escrita en el test, con la
 * forma del contrato.
 */

const PNR = 'QWERTY';
const PII = {
  givenName: 'MARIA',
  surname: 'QUISPE',
  birthdate: '1990-05-14',
  document: 'AB1234567',
  email: 'maria.quispe@example.com',
  phone: '+51 (1) 555-0142',
} as const;

const RUTA_TOKEN = '/v2/auth/token';
const RUTA_SHOP = '/v5/offers/shop';
const RUTA_CREATE = '/v1/trip/orders/createBooking';
const RUTA_GET = '/v1/trip/orders/getBooking';
const RUTA_CANCEL = '/v1/trip/orders/cancelBooking';

function respuesta(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function tokenOk(): Promise<Response> {
  return respuesta({ access_token: 'ATK-DE-PRUEBA', expires_in: 3600 });
}

/** Oferta ATPCO con itinerario: el carril que `createBooking` reconstruye como `flightDetails`. */
function ofertaAtpco(): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: 't1',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'shop-ref', source: 'ATPCO', raw: {} },
    total: { amountMinor: 23780, currency: 'USD' },
    baseFare: { amountMinor: 19348, currency: 'USD' },
    taxes: { amountMinor: 4432, currency: 'USD' },
    itineraries: [
      {
        segments: [
          {
            carrier: 'AA',
            flightNumber: '76',
            origin: 'JFK',
            destination: 'SFO',
            departureAt: '2026-12-11T06:00:00-05:00',
            arrivalAt: '2026-12-11T09:43:00-08:00',
            durationMinutes: 403,
            cabin: 'economy',
            bookingClass: 'B',
          },
        ],
        totalDurationMinutes: 403,
        stops: 0,
      },
    ],
    fetchedAt: '2026-10-11T11:30:00.000Z',
    expiresAt: '2026-10-11T11:31:30.000Z',
    expiresAtSource: 'platform-policy',
  };
}

function pedidoDeReserva(): OrderCreateRequest {
  return {
    offer: ofertaAtpco(),
    criteria: {
      origin: 'JFK',
      destination: 'SFO',
      departureDate: '2026-12-11',
      paxCount: { adults: 1, children: 0, infants: 0 },
      currency: 'USD',
    },
    passengers: [
      {
        paxId: 'PAX-1',
        requestedTravelerIndex: 0,
        paxType: 'ADT',
        title: 'Mrs',
        givenName: PII.givenName,
        surname: PII.surname,
        birthdate: PII.birthdate,
        gender: 'F',
        citizenshipCountryCode: 'PE',
        identityDoc: {
          type: 'P',
          number: PII.document,
          issuingCountryCode: 'PE',
          expiryDate: '2030-01-31',
        },
      },
    ],
    contactInfo: { email: PII.email, phone: PII.phone },
  };
}

/**
 * Las líneas que llegan al `Logger` de Nest, en el formato `mensaje {meta}` de `loggerPort`, en los
 * niveles que PRODUCCIÓN conserva: `main.ts` arranca Nest con `['log', 'warn', 'error']`. `debug`
 * se silencia sin capturarse, porque contarlo daba por emitida una traza que en producción se
 * descarta (así pasó con el éxito de createBooking, getBooking y cancelBooking).
 */
function capturarLog(): string[] {
  const lineas: string[] = [];
  const capturar = (...args: unknown[]): void => {
    lineas.push(String(args[0]));
  };
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(capturar);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(capturar);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(capturar);
  return lineas;
}

function metaDe(lineas: readonly string[], mensaje: string): Record<string, unknown> {
  const linea = lineas.find((l) => l.startsWith(`${mensaje} `));
  if (linea === undefined) throw new Error(`no se emitió ${mensaje}: [${lineas.join(' | ')}]`);
  return JSON.parse(linea.slice(mensaje.length + 1)) as Record<string, unknown>;
}

/**
 * «Sólo códigos y conteos», como propiedad y no como lista de claves: números, booleanos y
 * cadenas de vocabulario cerrado (sin espacios, sin `@`, sin `+`), a cualquier profundidad. Un
 * nombre, un correo o un teléfono no caben en esa forma. La marca de redacción se admite: es lo que
 * `redactMeta` deja donde una clave lo manda tapar (`withTargetPcc` cae por el fragmento `pcc`).
 */
function soloCodigosYConteos(valor: unknown, ruta = 'meta'): string[] {
  if (valor === null || valor === undefined) return [];
  if (typeof valor === 'number' || typeof valor === 'boolean') return [];
  if (typeof valor === 'string') {
    return valor === REDACTED || /^[A-Za-z0-9_.:/-]{0,80}$/.test(valor) ? [] : [`${ruta}=${valor}`];
  }
  if (Array.isArray(valor)) return valor.flatMap((v, i) => soloCodigosYConteos(v, `${ruta}.${i}`));
  if (typeof valor === 'object') {
    return Object.entries(valor as Record<string, unknown>).flatMap(([k, v]) =>
      soloCodigosYConteos(v, `${ruta}.${k}`),
    );
  }
  return [`${ruta}: tipo ${typeof valor}`];
}

describe('SabreProviderFactory — las trazas de una reserva llegan al log de producción', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function rutasDeReserva(): void {
    vi.stubGlobal('fetch', (input: unknown) => {
      const ruta = new URL(String(input)).pathname;
      switch (ruta) {
        case RUTA_TOKEN:
          return tokenOk();
        case RUTA_CREATE:
          return respuesta({
            timestamp: '2026-10-11T12:00:00',
            confirmationId: PNR,
            booking: {
              bookingId: PNR,
              flights: [{ itemId: '1', flightStatusCode: 'HK', flightStatusName: 'Confirmed' }],
            },
          });
        case RUTA_GET:
          return respuesta({
            bookingId: PNR,
            isCancelable: true,
            isTicketed: false,
            flights: [
              {
                itemId: '1',
                confirmationId: 'AB123',
                airlineCode: 'AA',
                sourceType: 'ATPCO',
                flightStatusCode: 'HK',
                flightStatusName: 'Confirmed',
              },
            ],
            travelers: [{ givenName: PII.givenName, surname: PII.surname }],
          });
        case RUTA_CANCEL:
          return respuesta({ timestamp: '2026-10-11T12:00:02' });
        default:
          throw new Error(`el ACL llamó a ${ruta}, que este test no preparó`);
      }
    });
  }

  it('createBooking, getBooking y cancelBooking se emiten, y sólo con códigos y conteos', async () => {
    rutasDeReserva();
    const lineas = capturarLog();
    const adapter = await factoryWith(() => Promise.resolve(resolved())).forTenant('t1');
    if (!supportsAuditedCreate(adapter) || !supportsAuditedCancel(adapter)) {
      throw new Error('el adapter de Sabre perdió los puertos auditados');
    }
    const ctx = { tenantId: 't1', requestId: 'req-traza' };

    await adapter.createOrderAudited(pedidoDeReserva(), ctx);
    await adapter.cancelOrderAudited(PNR, ctx);

    const creacion = metaDe(lineas, 'sabre.createBooking');
    expect(creacion).toMatchObject({
      provider: 'sabre',
      outcome: 'CONFIRMED',
      items: 1,
      issues: 0,
    });
    const lectura = metaDe(lineas, 'sabre.getBooking');
    expect(lectura).toMatchObject({ provider: 'sabre', withSurnameCheck: false, items: 1 });
    const cancelacion = metaDe(lineas, 'sabre.cancelBooking');
    expect(cancelacion).toMatchObject({
      provider: 'sabre',
      cancelAll: true,
      ticketCheckPerformed: false,
      outcome: expect.any(String) as unknown,
    });

    for (const meta of [creacion, lectura, cancelacion]) {
      expect(soloCodigosYConteos(meta)).toEqual([]);
    }
    // Y barrido sobre TODO lo que llegó al log, no sólo esas tres líneas.
    const volcado = lineas.join('\n');
    for (const prohibido of [
      PNR,
      ...Object.values(PII),
      EPR,
      PASSWORD,
      HOME_PCC,
      'ATK-DE-PRUEBA',
    ]) {
      expect(volcado, `el log publicó ${prohibido}`).not.toContain(prohibido);
    }
  });
});

describe('SabreProviderFactory — el cupo de concurrencia es de la CUENTA, búsqueda incluida', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `fetch` global que deja colgadas shop y createBooking hasta que el test las suelta. */
  function colgarRutas(): {
    abiertas: (pcc?: string) => string[];
    soltar: (ruta: string) => void;
    soltarTodo: () => void;
  } {
    const pendientes: Array<{ ruta: string; pcc: string; soltar: () => void }> = [];
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      const ruta = new URL(String(input)).pathname;
      if (ruta === RUTA_TOKEN) return tokenOk();
      const pcc = (init?.body as string | undefined)?.includes('"B2C3"') ? 'B2C3' : HOME_PCC;
      return new Promise<Response>((resolve) => {
        pendientes.push({
          ruta,
          pcc,
          // Un 400 cierra la llamada sin reintentos ni segunda búsqueda: lo único que se mide
          // aquí es cuántas hay abiertas a la vez.
          soltar: () => resolve(new Response('{"error":"invalid_request"}', { status: 400 })),
        });
      });
    });
    return {
      abiertas: (pcc) =>
        pendientes.filter((p) => pcc === undefined || p.pcc === pcc).map((p) => p.ruta),
      soltar: (ruta) => {
        const i = pendientes.findIndex((p) => p.ruta === ruta);
        const [p] = pendientes.splice(i, 1);
        p?.soltar();
      },
      soltarTodo: () => {
        for (const p of pendientes.splice(0)) p.soltar();
      },
    };
  }

  async function asentar(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  }

  const criterios = {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-12-01',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  };

  it('cuatro búsquedas salen a la vez, la reserva espera su hueco y otra cuenta no espera', async () => {
    capturarLog();
    const cable = colgarRutas();
    const factory = factoryWith((tenantId) =>
      Promise.resolve(
        tenantId === 't2'
          ? resolved({
              id: 'acc-sabre-2',
              ownerTenantId: 'owner-2',
              credentials: { epr: EPR, password: PASSWORD, homePcc: 'B2C3' },
            })
          : resolved(),
      ),
    );
    const cuenta = await factory.forTenant('t1');
    const otraCuenta = await factory.forTenant('t2');
    const ctx = { tenantId: 't1' };

    const busquedas = [1, 2, 3, 4].map(() => cuenta.search(criterios, ctx).catch(() => undefined));
    await asentar();
    // El fan-out no se serializa: las cuatro del cupo por defecto están en el cable.
    expect(cable.abiertas(HOME_PCC)).toEqual([RUTA_SHOP, RUTA_SHOP, RUTA_SHOP, RUTA_SHOP]);

    // La reserva usa el MISMO cliente: con un cliente propio de la búsqueda saldría ya.
    const reserva = cuenta.createOrder(pedidoDeReserva(), ctx).catch(() => undefined);
    await asentar();
    expect(cable.abiertas(HOME_PCC)).not.toContain(RUTA_CREATE);

    // Otra cuenta tiene su propio cupo.
    const ajena = otraCuenta.search(criterios, { tenantId: 't2' }).catch(() => undefined);
    await asentar();
    expect(cable.abiertas('B2C3')).toEqual([RUTA_SHOP]);

    cable.soltar(RUTA_SHOP);
    await asentar();
    expect(cable.abiertas(HOME_PCC)).toContain(RUTA_CREATE);
    expect(cable.abiertas(HOME_PCC)).toHaveLength(4);

    cable.soltarTodo();
    await Promise.all([...busquedas, reserva, ajena]);
  });

  it('el cupo CONTRACTUAL de la cuenta sale de `config.maxConcurrentRequests`, también como texto', async () => {
    capturarLog();
    const cable = colgarRutas();
    const cuenta = await factoryWith(() =>
      Promise.resolve(resolved({ config: { maxConcurrentRequests: '2' } })),
    ).forTenant('t1');

    const busquedas = [1, 2, 3].map(() =>
      cuenta.search(criterios, { tenantId: 't1' }).catch(() => undefined),
    );
    await asentar();
    // Dos, no el default de cuatro: el número del contrato manda.
    expect(cable.abiertas()).toEqual([RUTA_SHOP, RUTA_SHOP]);

    cable.soltar(RUTA_SHOP);
    await asentar();
    expect(cable.abiertas()).toHaveLength(2);

    cable.soltarTodo();
    await asentar();
    cable.soltarTodo();
    await Promise.all(busquedas);
  });

  it('un `maxConcurrentRequests` inválido se avisa y deja el default, sin tumbar la cuenta', async () => {
    const lineas = capturarLog();
    const cable = colgarRutas();
    const cuenta = await factoryWith(() =>
      Promise.resolve(resolved({ config: { maxConcurrentRequests: 0 } })),
    ).forTenant('t1');

    const busquedas = [1, 2, 3, 4, 5].map(() =>
      cuenta.search(criterios, { tenantId: 't1' }).catch(() => undefined),
    );
    await asentar();
    expect(cable.abiertas()).toHaveLength(4);
    expect(lineas.some((l) => l.includes('config.maxConcurrentRequests inválida'))).toBe(true);

    cable.soltarTodo();
    await asentar();
    cable.soltarTodo();
    await Promise.all(busquedas);
  });
});

describe('SabreProviderFactory — cabeceras de grupo desde las dos mitades de la cuenta', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function cabecerasDeShop(
    credentials: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    let cabeceras: Record<string, string> = {};
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      if (new URL(String(input)).pathname === RUTA_TOKEN) return tokenOk();
      cabeceras = (init?.headers ?? {}) as Record<string, string>;
      return respuesta({ error: 'invalid_request' }, 400);
    });
    const adapter = await factoryWith(() =>
      Promise.resolve(resolved({ credentials, config })),
    ).forTenant('t1');
    await adapter
      .search(
        {
          origin: 'BOG',
          destination: 'LIM',
          departureDate: '2026-12-01',
          paxCount: { adults: 1, children: 0, infants: 0 },
          currency: 'USD',
        },
        { tenantId: 't1' },
      )
      .catch(() => undefined);
    return cabeceras;
  }

  it('guardadas en el blob CIFRADO también salen: la spec las declara `encrypted-or-config`', async () => {
    const cabeceras = await cabecerasDeShop(
      {
        epr: EPR,
        password: PASSWORD,
        homePcc: HOME_PCC,
        sabreGroup: 'W0H3',
        sabreCurrentCity: 'BOG',
      },
      {},
    );
    expect(cabeceras['X-Sabre-Group']).toBe('W0H3');
    expect(cabeceras['X-Sabre-Current-City']).toBe('BOG');
  });

  it('desde `config` siguen saliendo como hasta hoy', async () => {
    const cabeceras = await cabecerasDeShop(
      { epr: EPR, password: PASSWORD, homePcc: HOME_PCC },
      { sabreGroup: 'W0H3', sabreCurrentCity: 'LIM' },
    );
    expect(cabeceras['X-Sabre-Group']).toBe('W0H3');
    expect(cabeceras['X-Sabre-Current-City']).toBe('LIM');
  });
});

/**
 * Puerta pública: el registry es quien decide si Sabre entra en una búsqueda. Probar el factory
 * aislado no demuestra que un tenant sin cuenta no vea ofertas de Sabre.
 */
describe('FlightProviderRegistry + Sabre', () => {
  const envPrevio = {
    defaults: process.env['PLATFORM_DEFAULT_FLIGHT_PROVIDERS'],
    policies: process.env['FLIGHT_PROVIDER_CALL_POLICIES'],
  };

  beforeEach(() => {
    delete process.env['PLATFORM_DEFAULT_FLIGHT_PROVIDERS'];
    delete process.env['FLIGHT_PROVIDER_CALL_POLICIES'];
  });

  afterEach(() => {
    if (envPrevio.defaults === undefined) delete process.env['PLATFORM_DEFAULT_FLIGHT_PROVIDERS'];
    else process.env['PLATFORM_DEFAULT_FLIGHT_PROVIDERS'] = envPrevio.defaults;
    if (envPrevio.policies === undefined) delete process.env['FLIGHT_PROVIDER_CALL_POLICIES'];
    else process.env['FLIGHT_PROVIDER_CALL_POLICIES'] = envPrevio.policies;
  });

  function registryWith(
    resolve: ProviderCredentialsService['resolve'],
    enabled = true,
  ): FlightProviderRegistry {
    const flags: ProviderFlagsPort = {
      decisionFor: () => Promise.resolve(enabled ? ENCENDIDO : undefined),
    };
    return new FlightProviderRegistry([factoryWith(resolve)], flags);
  }

  it('un tenant SIN cuenta de Sabre no ve a Sabre entre los proveedores activos', async () => {
    const registry = registryWith(() => Promise.reject(new NotFoundException('none')));
    const { active } = await registry.forTenant('t1');
    expect(active.map((p) => p.code)).not.toContain(SABRE_PROVIDER_CODE);
  });

  it('un tenant con cuenta de Sabre lo ve activo y sin simular', async () => {
    const registry = registryWith(() => Promise.resolve(resolved()));
    const { active } = await registry.forTenant('t1');
    expect(active.map((p) => p.code)).toEqual([SABRE_PROVIDER_CODE]);
  });

  it('una cuenta sin credenciales NO llega al fan-out — antes llegaba simulada', async () => {
    const registry = registryWith(() =>
      Promise.resolve(resolved({ credentials: {}, config: { mock: true } })),
    );
    const { active } = await registry.forTenant('t1');
    expect(active.map((p) => p.code)).not.toContain(SABRE_PROVIDER_CODE);
  });

  it('con callPolicy opt-in y sin el flag del tenant, Sabre queda salteado por `opt-in-disabled`', async () => {
    process.env['FLIGHT_PROVIDER_CALL_POLICIES'] = `${SABRE_PROVIDER_CODE}:opt-in`;
    const registry = registryWith(() => Promise.resolve(resolved()), false);
    const { active, skipped } = await registry.forTenant('t1');
    expect(active).toHaveLength(0);
    expect(skipped).toEqual([{ code: SABRE_PROVIDER_CODE, reason: 'opt-in-disabled' }]);
  });

  it('la cuenta del tenant puede declarar su propia callPolicy', async () => {
    const registry = registryWith(() =>
      Promise.resolve(resolved({ config: { callPolicy: 'fallback' } })),
    );
    const { active } = await registry.forTenant('t1');
    expect(active[0]?.callPolicy).toBe('fallback');
  });

  it('una callPolicy inválida en la cuenta se ignora y manda el default del factory', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = registryWith(() =>
      Promise.resolve(resolved({ config: { callPolicy: 'siempre-todo' } })),
    );
    const { active } = await registry.forTenant('t1');
    warn.mockRestore();
    expect(active[0]?.callPolicy).toBe('always');
  });

  it('el override de entorno gana sobre lo que declare la cuenta (kill-switch de ops)', async () => {
    process.env['FLIGHT_PROVIDER_CALL_POLICIES'] = `${SABRE_PROVIDER_CODE}:fallback`;
    const registry = registryWith(() =>
      Promise.resolve(resolved({ config: { callPolicy: 'always' } })),
    );
    const { active } = await registry.forTenant('t1');
    expect(active[0]?.callPolicy).toBe('fallback');
  });

  it('Sabre no está en los proveedores a los que la plataforma presta sus credenciales', async () => {
    // `PLATFORM_DEFAULT_FLIGHT_PROVIDERS` sin valor => sólo el proveedor legacy. Aunque el
    // factory devolviera un adapter de plataforma, el registry lo dejaría fuera.
    const registry = registryWith(() => Promise.reject(new NotFoundException('none')));
    expect(await registry.codesForTenant('t1')).toEqual([]);
  });
});

/**
 * Resolución BYOC contra Postgres real (patrón `hasDb` del repo). Se SALTA sin PGHOST.
 * Requiere las migraciones 0011 y 0012.
 */
const hasDb = Boolean(
  process.env['PGHOST'] &&
    process.env['PGUSER'] &&
    process.env['PGPASSWORD'] &&
    process.env['PROVIDER_CREDENTIALS_KEY'],
);
const d = hasDb ? describe : describe.skip;

d('SabreProviderFactory — jerarquía consolidador → agencia → sub-agencia', () => {
  const pool = new pg.Pool();
  const db = new DatabaseService();
  const sfx = randomBytes(4).toString('hex');
  let creds: ProviderCredentialsService;
  let consolidador: string;
  let agencia: string;
  let subagencia: string;

  async function tenant(slug: string, type: string, parent: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text,$1::text,'CO','COP',$2,$3) RETURNING id`,
      [slug, type, parent ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  async function cuenta(
    tenantId: string,
    providerCode: string,
    opts: { inheritable: boolean; status: string; label?: string },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, config, is_inheritable, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenantId,
        providerCode,
        opts.label ?? 'default',
        encryptCredentials(JSON.stringify({ epr: EPR, password: PASSWORD, homePcc: HOME_PCC })),
        JSON.stringify({}),
        opts.inheritable,
        opts.status,
      ],
    );
  }

  /** El owner de la cuenta que resolvería Sabre, o `null` si no resuelve ninguna. */
  async function ownerDeSabre(tenantId: string): Promise<string | null> {
    try {
      return (await creds.resolve(tenantId, SABRE_PROVIDER_CODE)).ownerTenantId;
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  it('monta la jerarquía y resuelve por herencia', async () => {
    db.onModuleInit();
    creds = new ProviderCredentialsService(db);

    consolidador = await tenant(`sb-cons-${sfx}`, 'consolidator', null);
    agencia = await tenant(`sb-ag-${sfx}`, 'agency', consolidador);
    subagencia = await tenant(`sb-sub-${sfx}`, 'subagency', agencia);

    // La sub-agencia sólo tiene LATAM: no puede resolver Sabre por tener OTRO proveedor.
    await cuenta(subagencia, 'latam-ndc', { inheritable: false, status: 'active' });
    expect(await ownerDeSabre(subagencia)).toBeNull();

    // Una cuenta de Sabre recién creada nace en `sandbox` y NO habilita nada.
    await cuenta(consolidador, SABRE_PROVIDER_CODE, { inheritable: true, status: 'sandbox' });
    expect(await ownerDeSabre(subagencia)).toBeNull();

    // Promoverla a `active` es lo que la enciende, y la hereda toda la red.
    await pool.query(
      `UPDATE provider_accounts SET status='active' WHERE tenant_id=$1 AND provider_code=$2`,
      [consolidador, SABRE_PROVIDER_CODE],
    );
    expect(await ownerDeSabre(subagencia)).toBe(consolidador);

    // Un ancestro con `is_inheritable=false` se SALTA: la sub-agencia sigue heredando del
    // consolidador, no de la agencia intermedia.
    await cuenta(agencia, SABRE_PROVIDER_CODE, { inheritable: false, status: 'active' });
    expect(await ownerDeSabre(subagencia)).toBe(consolidador);
    expect(await ownerDeSabre(agencia)).toBe(agencia);

    // Y la cuenta PROPIA gana sobre cualquier heredada.
    await cuenta(subagencia, SABRE_PROVIDER_CODE, { inheritable: false, status: 'active' });
    expect(await ownerDeSabre(subagencia)).toBe(subagencia);

    // Cierre: de hoja a raíz por el ON DELETE RESTRICT de parent_tenant_id.
    for (const id of [subagencia, agencia, consolidador]) {
      await pool.query('DELETE FROM provider_accounts WHERE tenant_id = $1', [id]);
      await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    await db.onModuleDestroy();
    await pool.end();
  });
});
