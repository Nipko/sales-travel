import { Logger, NotFoundException } from '@nestjs/common';
import type {
  HotelRatesQuery,
  HotelRoomOccupancy,
  HotelSearchCriteria,
} from '@sales-travel/canonical';
import {
  TBO_BASE_URLS,
  TBO_HOTELS_PROVIDER_CODE,
  TboApiError,
  TboRequestBuildError,
  checkTboSearchEligibility,
  type TboFetch,
} from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TenantType } from '../database/database.types.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelFlags,
  hotelRegistry,
} from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import { searchEligibilitySkip } from '../hotels/hotel-search.aggregate.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { providerSpecFor } from '../provider-credentials/provider-specs.js';
import {
  DespegarHotelInputError,
  DespegarHotelProviderAdapter,
} from '../providers-despegar/despegar-hotel-provider.adapter.js';
import {
  supportsHotelContent,
  type HotelProviderFactory,
} from '../providers/hotel-provider.types.js';
import {
  ProviderAccountIncompleteError,
  ProviderAccountNotAllowedError,
  type ProviderFlagsPort,
} from '../providers/provider.types.js';
import { TboHotelProviderAdapter } from './tbo-hotel-provider.adapter.js';
import { tboCircuitEffect } from './tbo-hotels-errors.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';

/**
 * El factory de TBO por su puerta pública (docs/tbo/09 PR-2.1; 08 RF-36, RNF-06).
 *
 * La bóveda es un doble con la MISMA regla que `resolve_provider_account`
 * (`db/migrations/0012_provider_accounts.sql`): la cuenta propia gana, si no la del ancestro
 * heredable más cercano, y sólo las `active`. Con eso los casos de herencia y de `sandbox` se
 * prueban como los vería la base, no con un `resolve` a medida de cada test.
 */

const PLATAFORMA = '00000000-0000-4000-8000-000000000001';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const OTRO_CONSOLIDADOR = '44444444-4444-4444-8444-444444444444';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const SUBAGENCIA = '55555555-5555-4555-8555-555555555555';

const TIPOS: Readonly<Record<string, TenantType>> = {
  [PLATAFORMA]: 'platform',
  [CONSOLIDADOR]: 'consolidator',
  [OTRO_CONSOLIDADOR]: 'consolidator',
  [AGENCIA]: 'agency',
  [OTRA_AGENCIA]: 'agency',
  [SUBAGENCIA]: 'subagency',
};

/** Padre de cada nodo; los consolidadores y la plataforma son raíces. */
const PADRES: Readonly<Record<string, string>> = {
  [AGENCIA]: CONSOLIDADOR,
  [OTRA_AGENCIA]: CONSOLIDADOR,
  [SUBAGENCIA]: AGENCIA,
};

// Valores con forma reconocible para buscarlos en cualquier salida. No son credenciales.
const USUARIO = 'consolidador-demo';
const CONTRASENA = ' Pa55 w0rd-tbo ';

interface CuentaSembrada {
  readonly tenantId: string;
  readonly status?: 'active' | 'sandbox' | 'disabled';
  readonly inheritable?: boolean;
  readonly credentials?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly updatedAt?: Date;
}

interface Boveda {
  readonly service: ProviderCredentialsService;
  readonly resolve: ReturnType<typeof vi.fn>;
  readonly ownerTenantType: ReturnType<typeof vi.fn>;
}

function ancestros(tenantId: string): string[] {
  const out: string[] = [];
  for (let t = PADRES[tenantId]; t !== undefined; t = PADRES[t]) out.push(t);
  return out;
}

/** `resolve_provider_account` en memoria. `cuentas` se lee en cada llamada: se puede rotar. */
function boveda(cuentas: () => readonly CuentaSembrada[]): Boveda {
  const resolve = vi.fn((tenantId: string, providerCode: string) => {
    const activas = cuentas().filter((c) => (c.status ?? 'active') === 'active');
    const propia = activas.find((c) => c.tenantId === tenantId);
    const heredada = ancestros(tenantId)
      .map((a) => activas.find((c) => c.tenantId === a && (c.inheritable ?? true)))
      .find((c) => c !== undefined);
    const elegida = propia ?? heredada;
    if (elegida === undefined) {
      return Promise.reject(
        new NotFoundException(`no active provider account for '${providerCode}'`),
      );
    }
    return Promise.resolve<ResolvedProviderAccount>({
      id: `acc-${elegida.tenantId}`,
      ownerTenantId: elegida.tenantId,
      providerCode,
      label: 'default',
      config: elegida.config ?? { environment: 'test' },
      credentials: elegida.credentials ?? { username: USUARIO, password: CONTRASENA },
      inherited: elegida.tenantId !== tenantId,
      updatedAt: elegida.updatedAt ?? new Date('2026-09-01T00:00:00Z'),
    });
  });
  const ownerTenantType = vi.fn((ownerTenantId: string) => Promise.resolve(TIPOS[ownerTenantId]));
  return {
    service: { resolve, ownerTenantType } as unknown as ProviderCredentialsService,
    resolve,
    ownerTenantType,
  };
}

/** `201 NO_AVAILABILITY`: la respuesta más corta que TBO da a una búsqueda que sí salió. */
function sinDisponibilidad(): Response {
  return new Response(
    JSON.stringify({ Status: { Code: 201, Description: 'No Available rooms' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Un `fetch` que responde siempre lo mismo y anota lo que salió. */
function cable(responder: () => Response = sinDisponibilidad): { fetch: Mock<TboFetch> } {
  const fetch = vi.fn<TboFetch>(() => Promise.resolve(responder()));
  return { fetch };
}

function factoryCon(b: Boveda, fetch?: TboFetch): TboHotelsProviderFactory {
  return new TboHotelsProviderFactory(b.service, fetch);
}

/** El registry REAL con TBO encendido por el flag de `opt-in`. */
function registryCon(
  factories: HotelProviderFactory[],
  flags: ProviderFlagsPort = hotelFlags(true),
) {
  return hotelRegistry(factories, flags);
}

const DETALLE: HotelRatesQuery = {
  hotelId: '1120548',
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  currency: 'USD',
  guestNationality: 'CO',
};

const CRITERIO: HotelSearchCriteria = {
  hotelIds: ['1120548', '1120549'],
  checkinDate: DETALLE.checkinDate,
  checkoutDate: DETALLE.checkoutDate,
  rooms: DETALLE.rooms,
  currency: 'USD',
  guestNationality: 'CO',
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('TboHotelsProviderFactory — contrato del registry de hoteles', () => {
  const factory = factoryCon(boveda(() => []));

  it('es el proveedor `tbo-hotels`, el mismo código con que el ACL marca cada tarifa (RF-40)', () => {
    expect(factory.code).toBe('tbo-hotels');
    expect(factory.code).toBe(TBO_HOTELS_PROVIDER_CODE);
    expect(factory.vertical).toBe('hotels');
  });

  it('se consulta sólo con el flag encendido: `opt-in` hasta conocer el costo por búsqueda (D-TBO-18 A)', () => {
    expect(factory.defaultCallPolicy).toBe('opt-in');
  });

  it('PR-2.6: busca en su propio espacio de ids, hasta 100 códigos elegidos por relevancia (D-TBO-17 A)', () => {
    expect(factory.searchProfile).toMatchObject({
      idSpace: 'provider',
      maxHotelsPerSearch: 100,
      catalogOrder: 'relevance',
    });
  });

  it('PR-2.4: exige la nacionalidad y declara los topes del contrato: hasta 4 niños por habitación (p. 11)', () => {
    expect(factory.searchProfile).toEqual({
      idSpace: 'provider',
      maxHotelsPerSearch: 100,
      catalogOrder: 'relevance',
      occupancy: { maxRooms: 8, maxAdultsPerRoom: 8, maxChildrenPerRoom: 4, maxChildAge: 18 },
      requiresGuestNationality: true,
      contentFromCatalog: true,
    });
  });

  it('PR-2.6: nombre, estrellas, dirección y coordenadas salen del catálogo: Search no los trae (pp. 13-15)', () => {
    expect(factory.searchProfile.contentFromCatalog).toBe(true);
  });

  it('anuncia la lectura de reservas (PR-4.2) y no la post-venta que el ACL todavía no hace', () => {
    expect(factory.capabilities).toEqual({
      retrieve: true,
      cancel: false,
      retrieveByClientReference: true,
      reconcileByDate: false,
    });
  });
});

describe('BYOC puro: sin cuenta resoluble TBO queda AUSENTE (D-TBO-03 A)', () => {
  it('un tenant sin cuenta propia ni heredada: ausente con motivo, sin red, aunque la plataforma tenga variables de TBO', async () => {
    // Si existiera un escalón de plataforma, estas variables lo encenderían.
    vi.stubEnv('TBO_USERNAME', 'plataforma');
    vi.stubEnv('TBO_PASSWORD', 'plataforma-secreta');
    vi.stubEnv('TBO_BASE_URL', TBO_BASE_URLS.test);
    const { fetch } = cable();
    const r = registryCon([
      factoryCon(
        boveda(() => []),
        fetch,
      ),
    ]);

    const res = await r.forTenant(AGENCIA);

    expect(res.active).toEqual([]);
    expect(res.unavailable).toEqual([
      expect.objectContaining({ code: 'tbo-hotels', reason: 'no-credentials' }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('una cuenta en `sandbox` no resuelve: TBO sigue ausente hasta promoverla', async () => {
    const b = boveda(() => [{ tenantId: CONSOLIDADOR, status: 'sandbox' }]);
    const r = registryCon([factoryCon(b)]);

    const res = await r.forTenant(AGENCIA);

    expect(res.active).toEqual([]);
    expect(res.unavailable.map((u) => [u.code, u.reason])).toEqual([
      ['tbo-hotels', 'no-credentials'],
    ]);
    // La ausencia viene de la bóveda: ni se preguntó de quién es la cuenta.
    expect(b.ownerTenantType).not.toHaveBeenCalled();
  });

  it('la `NotFoundException` de la bóveda se propaga tal cual: nadie la convierte en otra cuenta', async () => {
    const factory = factoryCon(boveda(() => []));
    await expect(factory.resolveForTenant(AGENCIA)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un fallo que no es "sin cuenta" (bóveda caída) se propaga', async () => {
    const b = boveda(() => []);
    b.resolve.mockRejectedValueOnce(new Error('db down'));
    await expect(factoryCon(b).resolveForTenant(AGENCIA)).rejects.toThrow('db down');
  });
});

describe('dueño de la cuenta: sólo plataforma o consolidador mientras Q-77 siga abierta', () => {
  it('la cuenta del consolidador, heredada por su agencia: TBO activo como `inherited`', async () => {
    const factory = factoryCon(boveda(() => [{ tenantId: CONSOLIDADOR }]));

    const agencia = await factory.resolveForTenant(AGENCIA);
    const consolidador = await factory.resolveForTenant(CONSOLIDADOR);

    expect(agencia.credentialSource).toBe('inherited');
    expect(consolidador.credentialSource).toBe('own');
    expect(agencia.adapter).toBeInstanceOf(TboHotelProviderAdapter);
    // RF-23: un `300` de la cuenta heredada se avisa al consolidador, que es quien la resolvió.
    expect(agencia.accountOwnerTenantId).toBe(CONSOLIDADOR);
    expect(consolidador.accountOwnerTenantId).toBe(CONSOLIDADOR);
  });

  it('la cuenta de la plataforma es admitida', async () => {
    const factory = factoryCon(boveda(() => [{ tenantId: PLATAFORMA }]));
    await expect(factory.resolveForTenant(PLATAFORMA)).resolves.toMatchObject({
      credentialSource: 'own',
    });
  });

  it('la cuenta PROPIA de una agencia: ausente, con la acción que le toca, sin construir nada', async () => {
    const { fetch } = cable();
    const b = boveda(() => [{ tenantId: CONSOLIDADOR }, { tenantId: AGENCIA }]);
    const r = registryCon([factoryCon(b, fetch)]);

    const res = await r.forTenant(AGENCIA);

    expect(res.active).toEqual([]);
    const [ausente] = res.unavailable;
    expect(ausente?.code).toBe('tbo-hotels');
    expect(ausente?.reason).toBe('no-credentials');
    expect(ausente?.detail).toContain('cuenta del consolidador');
    expect(ausente?.detail).toContain('Quitá la cuenta de TBO de esta agencia');
    // Se mira el DUEÑO de la cuenta resuelta, que aquí es la propia agencia.
    expect(b.ownerTenantType).toHaveBeenCalledWith(AGENCIA);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('una sub-agencia que hereda la cuenta de su agencia madre tampoco opera con ella', async () => {
    const b = boveda(() => [{ tenantId: CONSOLIDADOR }, { tenantId: AGENCIA }]);

    const err = await factoryCon(b)
      .resolveForTenant(SUBAGENCIA)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderAccountNotAllowedError);
    expect((err as ProviderAccountNotAllowedError).detail).toContain(
      'es de otra agencia de la red',
    );
    expect(b.ownerTenantType).toHaveBeenCalledWith(AGENCIA);
  });

  it('un dueño que no aparece en `tenants` no se admite: la puerta falla cerrada', async () => {
    const b = boveda(() => [{ tenantId: CONSOLIDADOR }]);
    b.ownerTenantType.mockResolvedValueOnce(undefined);

    await expect(factoryCon(b).resolveForTenant(CONSOLIDADOR)).rejects.toBeInstanceOf(
      ProviderAccountNotAllowedError,
    );
  });

  it('la puerta del dueño va primero: una cuenta de agencia incompleta no se ofrece "completar"', async () => {
    const b = boveda(() => [{ tenantId: AGENCIA, credentials: { username: USUARIO } }]);

    await expect(factoryCon(b).resolveForTenant(AGENCIA)).rejects.toBeInstanceOf(
      ProviderAccountNotAllowedError,
    );
  });
});

describe('puerta de credenciales, fuera de todo `try` (RF-36 CA-1)', () => {
  /*
   * MUTACIÓN: si se quita la llamada a `missingTboCredentials` del factory, el constructor del ACL
   * lanza `TboCredentialsMissingError`, que no es `NotFoundException`: el registry la propaga y la
   * búsqueda entera se cae en vez de dejar a TBO ausente. Este caso se pone en rojo.
   */
  it('una cuenta sin contraseña deja a TBO ausente con el campo que falta, nunca en otra cuenta', async () => {
    const { fetch } = cable();
    vi.stubEnv('TBO_PASSWORD', 'plataforma-secreta');
    const b = boveda(() => [{ tenantId: CONSOLIDADOR, credentials: { username: USUARIO } }]);
    const r = registryCon([factoryCon(b, fetch)]);

    const res = await r.forTenant(AGENCIA);

    expect(res.active).toEqual([]);
    expect(res.unavailable).toEqual([
      expect.objectContaining({ code: 'tbo-hotels', reason: 'incomplete-account' }),
    ]);
    expect(res.unavailable[0]?.detail).toContain('password');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('el error lleva NOMBRES de campo: usuario, contraseña y, en live, la URL', async () => {
    const b = boveda(() => [
      { tenantId: CONSOLIDADOR, credentials: {}, config: { environment: 'live' } },
    ]);

    const err = await factoryCon(b)
      .resolveForTenant(CONSOLIDADOR)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderAccountIncompleteError);
    expect((err as ProviderAccountIncompleteError).missingFields).toEqual([
      'username',
      'password',
      'baseUrl',
    ]);
  });

  it('usuario y contraseña se leen SÓLO del blob cifrado: en `config` no cuentan', async () => {
    const b = boveda(() => [
      {
        tenantId: CONSOLIDADOR,
        credentials: {},
        config: { environment: 'test', username: USUARIO, password: CONTRASENA },
      },
    ]);

    const err = await factoryCon(b)
      .resolveForTenant(CONSOLIDADOR)
      .catch((e: unknown) => e);

    expect((err as ProviderAccountIncompleteError).missingFields).toEqual(['username', 'password']);
  });

  it.each([
    ['sin entorno', {}, ['environment']],
    [
      'live por http',
      { environment: 'live', baseUrl: 'http://tbo.example.com/HotelAPI' },
      ['baseUrl'],
    ],
    [
      'http fuera del host de test',
      { environment: 'test', baseUrl: 'http://otro.example.com/x' },
      ['baseUrl'],
    ],
  ])(
    'configuración inválida (%s): cuenta a corregir, no un 500 que tumbe la búsqueda',
    async (_caso, config, campos) => {
      const b = boveda(() => [{ tenantId: CONSOLIDADOR, config }]);
      const r = registryCon([factoryCon(b)]);

      const res = await r.forTenant(CONSOLIDADOR);

      expect(res.unavailable.map((u) => u.reason)).toEqual(['incomplete-account']);
      const err = await factoryCon(b)
        .resolveForTenant(CONSOLIDADOR)
        .catch((e: unknown) => e);
      expect((err as ProviderAccountIncompleteError).missingFields).toEqual(campos);
    },
  );

  it('ni el aviso de cuenta incompleta ni el de inválida llevan valores de la credencial', async () => {
    const b = boveda(() => [
      {
        tenantId: CONSOLIDADOR,
        credentials: { username: 'usuario:con-dos-puntos', password: CONTRASENA },
      },
    ]);

    await factoryCon(b)
      .resolveForTenant(CONSOLIDADOR)
      .catch(() => undefined);

    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain('username:colon_in_username');
    expect(logueado).not.toContain('usuario:con-dos-puntos');
    expect(logueado).not.toContain(CONTRASENA.trim());
  });
});

describe('la cuenta llega intacta al cable', () => {
  it('Basic con el usuario y la contraseña SIN recortar, contra la URL de la cuenta', async () => {
    const { fetch } = cable();
    const baseUrl = 'https://api.tbotechnology.in/TBOHolidays_HotelAPI/';
    const b = boveda(() => [{ tenantId: CONSOLIDADOR, config: { environment: 'test', baseUrl } }]);

    const { adapter } = await factoryCon(b, fetch).resolveForTenant(AGENCIA);
    const offer = await (adapter as TboHotelProviderAdapter).getHotelRates(DETALLE, {
      tenantId: AGENCIA,
    });

    expect(offer).toEqual({ hotelId: DETALLE.hotelId, roompacks: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tbotechnology.in/TBOHolidays_HotelAPI/Search');
    const esperado = `Basic ${Buffer.from(`${USUARIO}:${CONTRASENA}`, 'utf8').toString('base64')}`;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(esperado);
  });

  it('`test` sin URL en la cuenta usa la de test publicada', async () => {
    const { fetch } = cable();
    const { adapter } = await factoryCon(
      boveda(() => [{ tenantId: CONSOLIDADOR }]),
      fetch,
    ).resolveForTenant(CONSOLIDADOR);

    await adapter.searchAvailability(CRITERIO, { tenantId: CONSOLIDADOR });

    expect(fetch.mock.calls[0]?.[0]).toBe(`${TBO_BASE_URLS.test}/Search`);
  });
});

describe('caché de adapters por dueño de la cuenta (RNF-06, RF-36 CA-3)', () => {
  it('dos agencias que heredan la cuenta del consolidador comparten adapter y circuito de cuenta', async () => {
    const factory = factoryCon(boveda(() => [{ tenantId: CONSOLIDADOR }]));

    const a = await factory.resolveForTenant(AGENCIA);
    const b = await factory.resolveForTenant(OTRA_AGENCIA);

    expect(a.adapter).toBe(b.adapter);
    expect(a.circuit?.accountRef).toBe(b.circuit?.accountRef);
  });

  it('dos dueños distintos NUNCA comparten adapter, ni con el mismo usuario de TBO', async () => {
    const factory = factoryCon(
      boveda(() => [{ tenantId: CONSOLIDADOR }, { tenantId: OTRO_CONSOLIDADOR }]),
    );

    const uno = await factory.resolveForTenant(CONSOLIDADOR);
    const otro = await factory.resolveForTenant(OTRO_CONSOLIDADOR);

    expect(uno.adapter).not.toBe(otro.adapter);
    // Un `401` de uno no puede suspender al otro: la huella incluye al dueño.
    expect(uno.circuit?.accountRef).not.toBe(otro.circuit?.accountRef);
  });

  it('al rotar la credencial se construye otro adapter y la entrada vieja se descarta, sin tocar a otros dueños', async () => {
    let rotada = new Date('2026-09-01T00:00:00Z');
    const factory = factoryCon(
      boveda(() => [
        { tenantId: CONSOLIDADOR, updatedAt: rotada },
        { tenantId: OTRO_CONSOLIDADOR },
      ]),
    );
    const cache = (): string[] => [
      ...(factory as unknown as { cache: Map<string, unknown> }).cache.keys(),
    ];

    const vieja = await factory.resolveForTenant(CONSOLIDADOR);
    await factory.resolveForTenant(OTRO_CONSOLIDADOR);
    rotada = new Date('2026-09-20T00:00:00Z');
    const nueva = await factory.resolveForTenant(CONSOLIDADOR);

    expect(nueva.adapter).not.toBe(vieja.adapter);
    expect(cache()).toEqual([
      `byoc:${OTRO_CONSOLIDADOR}:${new Date('2026-09-01T00:00:00Z').getTime()}`,
      `byoc:${CONSOLIDADOR}:${rotada.getTime()}`,
    ]);
  });

  it('el circuito de cada llamada lleva la huella del adapter y el efecto de los errores de TBO', async () => {
    const { adapter, circuit } = await factoryCon(
      boveda(() => [{ tenantId: CONSOLIDADOR }]),
    ).resolveForTenant(AGENCIA);

    expect(circuit?.accountRef).toBe((adapter as TboHotelProviderAdapter).accountRef);
    expect(circuit?.accountRef).toMatch(/^[0-9a-f]{16}$/);
    expect(circuit?.effectOf).toBe(tboCircuitEffect);
  });

  it('el adapter volcado a un log no arrastra la cuenta', async () => {
    const { adapter } = await factoryCon(
      boveda(() => [{ tenantId: CONSOLIDADOR }]),
    ).resolveForTenant(CONSOLIDADOR);

    expect(JSON.stringify(adapter)).not.toContain(USUARIO);
    expect(JSON.stringify(adapter)).not.toContain(CONTRASENA.trim());
  });
});

describe('RF-36 CA-2: una tarifa de TBO nunca llega al adapter de Despegar', () => {
  it('el registry enruta cada código a SU adapter', async () => {
    const tbo = factoryCon(boveda(() => [{ tenantId: CONSOLIDADOR }]));
    const r = registryCon([fakeDespegarFactory().factory, tbo]);

    const deTbo = await r.byCode(AGENCIA, 'tbo-hotels');
    const deDespegar = await r.byCode(AGENCIA, 'despegar-hotels');

    expect(deTbo.adapter).toBeInstanceOf(TboHotelProviderAdapter);
    expect(deDespegar.adapter).toBeInstanceOf(DespegarHotelProviderAdapter);
  });

  it('y si una tarifa de TBO llegara a Despegar, se rechaza antes de su ACL', async () => {
    const acl = new FakeDespegarHotelsAdapter();
    const despegar = new DespegarHotelProviderAdapter(acl);

    const err = await despegar
      .prebook(
        { offer: { name: 'tbo-hotels', offerRef: '1160804!TB!10!TB!6110a41c' } },
        { tenantId: AGENCIA },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DespegarHotelInputError);
    expect((err as DespegarHotelInputError).reason).toBe('foreign-offer');
    expect(acl.prebook).not.toHaveBeenCalled();
  });
});

describe('RF-06 y topes de ocupación: TBO fuera con motivo, nunca un error ni un valor fijo (PR-2.4)', () => {
  const factory = factoryCon(boveda(() => []));
  const conNinos = (n: number): HotelRoomOccupancy[] => [
    { adults: 2, childrenAges: Array.from({ length: n }, (_, i) => i + 1) },
  ];

  it('RF-06 CA 1, con el perfil REAL: sin nacionalidad, TBO queda `skipped` con el motivo', () => {
    const excluido = searchEligibilitySkip(
      'tbo-hotels',
      { rooms: DETALLE.rooms },
      factory.searchProfile,
    );
    expect(excluido).toMatchObject({
      code: 'tbo-hotels',
      status: 'skipped',
      skipReason: 'guest-nationality-missing',
    });
    expect(excluido?.reason).toContain('nacionalidad del pasajero principal');
  });

  it('habitación con 5 niños → `skipped` "hasta 4 niños"; con 4, TBO busca', () => {
    const conCinco = { rooms: conNinos(5), guestNationality: 'CO' };
    expect(searchEligibilitySkip('tbo-hotels', conCinco, factory.searchProfile)).toMatchObject({
      skipReason: 'occupancy-limits',
      reason: 'Admite hasta 4 niños por habitación.',
    });
    expect(
      searchEligibilitySkip(
        'tbo-hotels',
        { rooms: conNinos(4), guestNationality: 'CO' },
        factory.searchProfile,
      ),
    ).toBeUndefined();
  });

  /*
   * MUTACIÓN: si el perfil declarara un tope distinto del que aplica el builder del ACL (por
   * ejemplo 6 niños), el servicio llamaría a TBO con una ocupación que el ACL rechaza y el vendedor
   * vería un error en vez del motivo. Este caso se pone en rojo.
   */
  it.each<[string, HotelRoomOccupancy[], string | undefined]>([
    ['sólo adultos', [{ adults: 2, childrenAges: [] }], 'CO'],
    ['4 niños', conNinos(4), 'CO'],
    ['5 niños', conNinos(5), 'CO'],
    ['6 niños', [{ adults: 1, childrenAges: [0, 2, 4, 6, 8, 17] }], 'CO'],
    ['8 adultos', [{ adults: 8, childrenAges: [] }], 'AR'],
    ['8 habitaciones', Array.from({ length: 8 }, () => ({ adults: 1, childrenAges: [] })), 'PE'],
    [
      'caso 6 de certificación',
      [
        { adults: 1, childrenAges: [5, 9] },
        { adults: 2, childrenAges: [] },
      ],
      'BR',
    ],
    ['sin nacionalidad', [{ adults: 2, childrenAges: [3] }], undefined],
    ['nacionalidad en blanco', [{ adults: 2, childrenAges: [3] }], '  '],
    ['5 niños y sin nacionalidad', conNinos(5), undefined],
  ])(
    'el servicio y el ACL coinciden en si TBO puede buscar: %s',
    (_caso, rooms, guestNationality) => {
      const search = guestNationality === undefined ? { rooms } : { rooms, guestNationality };
      const excluido = searchEligibilitySkip('tbo-hotels', search, factory.searchProfile);
      expect(excluido === undefined).toBe(checkTboSearchEligibility(search).eligible);
    },
  );

  it('RF-06 CA 3: la especificación de credenciales de TBO no tiene la clave `guestNationality`', () => {
    const spec = providerSpecFor('tbo-hotels');
    const claves = [...(spec?.fields ?? []).map((f) => f.key), ...(spec?.safeConfigKeys ?? [])].map(
      (k) => k.toLowerCase(),
    );

    expect(spec).toBeDefined();
    expect(claves).toEqual(['username', 'password', 'environment', 'baseurl']);
    expect(claves.some((k) => k.includes('nationality'))).toBe(false);
  });

  it('RF-06: una nacionalidad guardada en la cuenta no completa la búsqueda: no sale nada hacia TBO', async () => {
    const { fetch } = cable();
    const b = boveda(() => [
      { tenantId: CONSOLIDADOR, config: { environment: 'test', guestNationality: 'CO' } },
    ]);
    const { adapter } = await factoryCon(b, fetch).resolveForTenant(AGENCIA);
    const { guestNationality: _sinNacionalidad, ...sinNacionalidad } = CRITERIO;

    const err = await adapter
      .searchAvailability(sinNacionalidad, { tenantId: AGENCIA })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TboRequestBuildError);
    expect((err as TboRequestBuildError).reason).toBe('NOT_ELIGIBLE');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('humanizeError', () => {
  it('le habla a quien puede arreglar la cuenta: heredada → al consolidador', () => {
    const factory = factoryCon(boveda(() => []));
    const err = new TboApiError({
      status: 401,
      path: '/Search',
      kind: 'CREDENTIALS_INVALID',
      requestId: 'req-1',
    });

    expect(factory.humanizeError(err, { credentialSource: 'inherited' })).toContain(
      'Avisale al consolidador',
    );
    expect(factory.humanizeError(err, { credentialSource: 'own' })).toContain(
      'Mi Red → Credenciales → TBO Hoteles',
    );
  });

  it('el registry le pasa el contexto al factory', () => {
    const factory = factoryCon(boveda(() => []));
    const r = registryCon([factory]);
    const err = new TboApiError({
      status: 200,
      tboCode: 402,
      path: '/Search',
      kind: 'ACCOUNT_BLOCKED',
      requestId: 'req-2',
    });

    expect(r.humanizeError('tbo-hotels', err, { credentialSource: 'inherited' })).toBe(
      factory.humanizeError(err, { credentialSource: 'inherited' }),
    );
  });
});

describe('PR-3.6: contenido de un hotel con la MISMA cuenta y el mismo limitador', () => {
  /** HotelDetails de un hotel, la forma más corta que el ACL acepta. */
  function detalleDeHotel(): Response {
    return new Response(
      JSON.stringify({
        Status: { Code: 200, Description: 'Successful' },
        HotelDetails: [
          {
            HotelCode: '1000000',
            HotelName: 'Sofitel Legend Old Cataract Aswan',
            Images: ['https://api.tbotechnology.in/imageresource.aspx?img=abc'],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('el adapter del factory lee HotelDetails por el mismo `fetch` y con la cuenta de la bóveda', async () => {
    const { fetch } = cable(detalleDeHotel);
    const { adapter } = await factoryCon(
      boveda(() => [{ tenantId: CONSOLIDADOR }]),
      fetch,
    ).resolveForTenant(AGENCIA);

    expect(supportsHotelContent(adapter)).toBe(true);
    if (!supportsHotelContent(adapter)) return;
    const ficha = await adapter.fetchHotelContent(
      '1000000',
      'es',
      { tenantId: AGENCIA },
      {
        timeoutMs: 6_000,
      },
    );

    expect(ficha).toMatchObject({
      hotelId: '1000000',
      name: 'Sofitel Legend Old Cataract Aswan',
      images: ['https://api.tbotechnology.in/imageresource.aspx?img=abc'],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TBO_BASE_URLS.test}/HotelDetails`);
    expect(JSON.parse(init.body as string)).toEqual({ Hotelcodes: '1000000', Language: 'ES' });
    const esperado = `Basic ${Buffer.from(`${USUARIO}:${CONTRASENA}`, 'utf8').toString('base64')}`;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(esperado);
  });

  it('volcado a un log, el adapter con su cliente de contenido sigue sin arrastrar la cuenta', async () => {
    const { adapter } = await factoryCon(
      boveda(() => [{ tenantId: CONSOLIDADOR }]),
    ).resolveForTenant(CONSOLIDADOR);

    expect(JSON.stringify(adapter)).toBe('{}');
  });
});
