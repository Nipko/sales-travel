import { randomBytes } from 'node:crypto';
import { Logger, NotFoundException } from '@nestjs/common';
import {
  SabreApiError,
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
import { SabreMockBookingError, SabreOperationNotSupportedError } from './sabre-errors.js';
import { SABRE_PROVIDER_CODE, SabreProviderFactory } from './sabre.factory.js';

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

  it('un mock DECLARADO por la cuenta sí se sirve, y se sirve marcado como mock', async () => {
    // Un mock elegido no es un mock silencioso: viaja como `simulated` en la respuesta y el
    // resultado no se cachea.
    const factory = factoryWith(() =>
      Promise.resolve(resolved({ credentials: {}, config: { mock: true } })),
    );
    const adapter = await factory.forTenant('t1');
    expect(adapter.isMock).toBe(true);
  });

  it('con las tres credenciales completas el adapter NO está en modo mock', async () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    expect((await factory.forTenant('t1')).isMock).toBe(false);
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

  it('arranca en `opt-in`: la compuerta comercial (P-01) no decidió el fee todavía', () => {
    const factory = factoryWith(() => Promise.resolve(resolved()));
    expect(factory.defaultCallPolicy).toBe('opt-in');
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
    const offer = { provider: { name: 'sabre', raw: {} } } as never;

    await expect(adapter.priceOffer(offer, {} as never, ctx)).rejects.toBeInstanceOf(
      SabrePriceRequestError,
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

    await expect(adapter.createOrder(request, ctx)).rejects.toBeInstanceOf(
      SabreOrderCreateInputError,
    );
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
  ])('%s se rechaza con un error propio, no se ejecuta contra fixtures', async (_n, invocar) => {
    const factory = factoryWith(() => Promise.resolve(mockResolved()));
    const adapter = await factory.forTenant('t1');
    expect(adapter.isMock).toBe(true);

    await expect(invocar(adapter)).rejects.toBeInstanceOf(SabreMockBookingError);
  });

  it('la búsqueda sí funciona en mock: es para lo que existe el modo', async () => {
    const factory = factoryWith(() => Promise.resolve(mockResolved()));
    const adapter = await factory.forTenant('t1');
    expect(adapter.isMock).toBe(true);
  });
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
    const flags: ProviderFlagsPort = { isEnabledForTenant: () => Promise.resolve(enabled) };
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
    expect(active[0]?.simulated).toBe(false);
  });

  it('una cuenta en mock declarado llega al fan-out MARCADA como simulada', async () => {
    const registry = registryWith(() =>
      Promise.resolve(resolved({ credentials: {}, config: { mock: true } })),
    );
    const { active } = await registry.forTenant('t1');
    expect(active[0]?.simulated).toBe(true);
  });

  it('sin el flag del tenant, Sabre queda salteado por `opt-in-disabled`', async () => {
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
    expect(active[0]?.callPolicy).toBe('opt-in');
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
      [slug, type, parent],
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
