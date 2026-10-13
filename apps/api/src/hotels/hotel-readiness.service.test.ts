import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrandingService, SupportContact } from '../branding/branding.service.js';
import type { NetworkService, NetworkTenant, NetworkUser } from '../network/network.service.js';
import type { PortfoliosService } from '../portfolios/portfolios.service.js';
import type {
  ProviderEnablementRow,
  ProviderEnablementStore,
} from '../provider-enablement/provider-enablement.store.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import type { HotelProviderAccountStatus } from '../providers/hotel-provider.types.js';
import type { ProviderEnablementEntry } from '../providers/provider.types.js';
import {
  HotelReadinessService,
  READINESS_CONCURRENCY,
  READINESS_DEADLINE_MS,
  READINESS_MAX_NODES,
  type HotelReadinessNode,
} from './hotel-readiness.service.js';

/*
 * La guía del superadmin para probar una reserva de hotel: qué nodos revisa, qué dice de cada uno y
 * cómo se comporta cuando una consulta falla o tarda. Todo con dobles: nada sale a TBO ni a la base.
 */

const SUPERADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RAIZ = '00000000-0000-4000-8000-000000000000';
const NORTE = '10000000-0000-4000-8000-000000000001';
const CENTRO = '10000000-0000-4000-8000-000000000002';

function id(n: number): string {
  return `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function nodo(tenantId: string, name: string, extra: Partial<NetworkTenant> = {}): NetworkTenant {
  return {
    id: tenantId,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    tenantType: 'agency',
    isBranch: true,
    parentTenantId: RAIZ,
    status: 'active',
    depth: 2,
    ...extra,
  };
}

function ajuste(tenantId: string | null, enabled: boolean, providerCode = 'tbo-hotels') {
  return {
    id: `s-${tenantId ?? 'global'}-${providerCode}`,
    providerCode,
    tenantId,
    tenantName: null,
    tenantSlug: null,
    enabled,
    reason: null,
    updatedBy: null,
    updatedByEmail: null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  } satisfies ProviderEnablementRow;
}

function tbo(entry: Partial<ProviderEnablementEntry> = {}): ProviderEnablementEntry[] {
  return [
    { code: 'despegar-hotels', vertical: 'hotels', callPolicy: 'always', decision: undefined },
    {
      code: 'tbo-hotels',
      vertical: 'hotels',
      callPolicy: 'opt-in',
      decision: { enabled: true, origin: 'tenant', tenantId: NORTE },
      ...entry,
    },
  ];
}

function usuario(extra: Partial<NetworkUser> = {}): NetworkUser {
  return {
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'vendedor@planetour.com',
    name: 'Vendedora',
    userStatus: 'active',
    role: 'vendedor',
    membershipStatus: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    lastLoginAt: null,
    mfaEnabled: false,
    lockedUntil: null,
    activeSessions: 0,
    ...extra,
  };
}

const CONTACTO: SupportContact = { email: 'soporte@planetour.com', phone: '+57 300 123 4567' };

interface Escenario {
  readonly network?: NetworkTenant[];
  readonly settings?: ProviderEnablementRow[];
  readonly enablement?: (tenantId: string) => Promise<ProviderEnablementEntry[]>;
  readonly account?: (tenantId: string) => Promise<HotelProviderAccountStatus>;
  readonly wallets?: (tenantId: string) => Promise<{ currency: string; status: string }[]>;
  readonly contact?: (tenantId: string) => Promise<SupportContact>;
  readonly users?: (tenantId: string) => Promise<NetworkUser[]>;
}

function banco(escenario: Escenario = {}) {
  const network = {
    listNetwork: vi.fn(() => Promise.resolve(escenario.network ?? [nodo(NORTE, 'Sucursal Norte')])),
    listTenantUsers: vi.fn((_userId: string, tenantId: string) =>
      escenario.users ? escenario.users(tenantId) : Promise.resolve([usuario()]),
    ),
  };
  const enablement = {
    listRows: vi.fn(() => Promise.resolve(escenario.settings ?? [])),
  };
  const registry = {
    enablementOf: vi.fn((tenantId: string) =>
      escenario.enablement ? escenario.enablement(tenantId) : Promise.resolve(tbo()),
    ),
    accountStatusOf: vi.fn((tenantId: string, _code: string) =>
      escenario.account
        ? escenario.account(tenantId)
        : Promise.resolve<HotelProviderAccountStatus>({
            status: 'ok',
            source: 'inherited',
            environment: 'test',
          }),
    ),
  };
  const portfolios = {
    overview: vi.fn(async (tenantId: string) => ({
      portfolios: escenario.wallets
        ? await escenario.wallets(tenantId)
        : [{ currency: 'USD', status: 'active' }],
      financier: null,
      ownProviderAccounts: [],
    })),
  };
  const branding = {
    resolveSupportContact: vi.fn((tenantId: string) =>
      escenario.contact ? escenario.contact(tenantId) : Promise.resolve(CONTACTO),
    ),
  };
  const service = new HotelReadinessService(
    network as unknown as NetworkService,
    enablement as unknown as ProviderEnablementStore,
    registry as unknown as HotelProviderRegistry,
    portfolios as unknown as PortfoliosService,
    branding as unknown as BrandingService,
  );
  return { service, network, enablement, registry, portfolios, branding };
}

async function unNodo(escenario: Escenario): Promise<HotelReadinessNode> {
  const { service } = banco(escenario);
  const view = await service.readiness(SUPERADMIN);
  expect(view.nodes).toHaveLength(1);
  const [node] = view.nodes;
  if (node === undefined) throw new Error('sin nodo');
  return node;
}

/** Una promesa que nunca se resuelve: una consulta colgada. */
function colgada<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('qué nodos revisa', () => {
  it('las sucursales activas y los nodos con TBO habilitado como excepción, por nombre', async () => {
    const SUR = id(1);
    const OESTE = id(2);
    const ESTE = id(3);
    const SUSPENDIDA = id(4);
    const EXCEPCION_SUSPENDIDA = id(5);
    const { service, network, enablement } = banco({
      network: [
        nodo(RAIZ, 'Planetour', { tenantType: 'platform', isBranch: false, parentTenantId: null }),
        nodo(NORTE, 'Sucursal Norte'),
        nodo(CENTRO, 'Sucursal Centro'),
        nodo(SUSPENDIDA, 'Sucursal Cerrada', { status: 'suspended' }),
        nodo(SUR, 'Agencia Sur', { isBranch: false }),
        nodo(OESTE, 'Agencia Oeste', { isBranch: false }),
        nodo(ESTE, 'Agencia Este', { isBranch: false }),
        nodo(EXCEPCION_SUSPENDIDA, 'Agencia Dormida', { isBranch: false, status: 'suspended' }),
      ],
      settings: [
        ajuste(null, true),
        ajuste(SUR, true),
        ajuste(OESTE, false),
        ajuste(ESTE, true, 'despegar-hotels'),
        ajuste(EXCEPCION_SUSPENDIDA, true),
      ],
    });

    const view = await service.readiness(SUPERADMIN);

    expect(view.nodes.map((n) => [n.name, n.isBranch])).toEqual([
      ['Agencia Sur', false],
      ['Sucursal Centro', true],
      ['Sucursal Norte', true],
    ]);
    expect(view.omitted).toBe(0);
    expect(network.listNetwork).toHaveBeenCalledWith(SUPERADMIN);
    expect(enablement.listRows).toHaveBeenCalledTimes(1);
  });

  it('dos sucursales con el mismo nombre salen en un orden estable', async () => {
    const { service } = banco({
      network: [nodo(id(9), 'Sucursal Norte'), nodo(id(8), 'Sucursal Norte')],
    });

    const view = await service.readiness(SUPERADMIN);
    expect(view.nodes.map((n) => n.tenantId)).toEqual([id(8), id(9)]);
  });

  it(`revisa hasta ${READINESS_MAX_NODES} y dice cuántas quedaron fuera`, async () => {
    const network = Array.from({ length: READINESS_MAX_NODES + 3 }, (_, i) =>
      nodo(id(i), `Sucursal ${String(i).padStart(2, '0')}`),
    );
    const { service, registry } = banco({ network: [...network].reverse() });

    const view = await service.readiness(SUPERADMIN);

    expect(view.nodes).toHaveLength(READINESS_MAX_NODES);
    expect(view.omitted).toBe(3);
    expect(view.nodes[0]?.name).toBe('Sucursal 00');
    expect(view.nodes.at(-1)?.name).toBe(`Sucursal ${READINESS_MAX_NODES - 1}`);
    expect(registry.accountStatusOf).toHaveBeenCalledTimes(READINESS_MAX_NODES);
  });

  it('sin sucursales, la lista vacía y sin consultas por nodo', async () => {
    const { service, registry } = banco({
      network: [nodo(RAIZ, 'Planetour', { tenantType: 'platform', isBranch: false })],
    });

    expect(await service.readiness(SUPERADMIN)).toEqual({
      provider: 'tbo-hotels',
      nodes: [],
      omitted: 0,
      partial: false,
    });
    expect(registry.accountStatusOf).not.toHaveBeenCalled();
  });

  it('si no puede leer la red, falla: no hay lista que mostrar', async () => {
    const { service, network } = banco();
    network.listNetwork.mockRejectedValueOnce(new Error('base caída'));

    await expect(service.readiness(SUPERADMIN)).rejects.toThrow('base caída');
  });
});

describe('qué dice de cada nodo', () => {
  it('una sucursal con todo en orden está lista para probar', async () => {
    const { service, registry, portfolios, branding, network } = banco();

    const view = await service.readiness(SUPERADMIN);

    expect(view).toEqual({
      provider: 'tbo-hotels',
      nodes: [
        {
          tenantId: NORTE,
          name: 'Sucursal Norte',
          isBranch: true,
          ready: true,
          missing: [],
          tbo: 'enabled',
          account: { status: 'ok', source: 'inherited', environment: 'test' },
          wallets: [{ currency: 'USD', status: 'active' }],
          supportContact: 'ok',
          activeSellers: 1,
        },
      ],
      omitted: 0,
      partial: false,
    });
    expect(registry.enablementOf).toHaveBeenCalledWith(NORTE);
    expect(registry.accountStatusOf).toHaveBeenCalledWith(NORTE, 'tbo-hotels');
    expect(portfolios.overview).toHaveBeenCalledWith(NORTE);
    expect(branding.resolveSupportContact).toHaveBeenCalledWith(NORTE);
    expect(network.listTenantUsers).toHaveBeenCalledWith(SUPERADMIN, NORTE);
  });

  it('cada faltante con su código, en el orden de la lista', async () => {
    const node = await unNodo({
      enablement: () => Promise.resolve(tbo({ decision: undefined })),
      account: () => Promise.resolve({ status: 'no-credentials' }),
      wallets: () => Promise.resolve([{ currency: 'USD', status: 'suspended' }]),
      // Sin el «+» no hay país: el Book lo rechazaría igual.
      contact: () => Promise.resolve({ email: 'soporte@planetour.com', phone: '300 123 4567' }),
      users: () => Promise.resolve([]),
    });

    expect(node.ready).toBe(false);
    expect(node.missing).toEqual([
      'tbo-not-enabled',
      'tbo-account',
      'wallet',
      'support-contact',
      'no-sellers',
    ]);
    expect(node).toMatchObject({
      tbo: 'not-enabled',
      account: { status: 'no-credentials' },
      supportContact: 'missing',
      activeSellers: 0,
    });
  });

  it.each([
    [
      'apagado por la plataforma',
      tbo({ decision: { enabled: false, origin: 'global' } }),
      'platform-disabled',
    ],
    ['opt-in que nadie encendió', tbo({ decision: undefined }), 'not-enabled'],
    ['sin TBO registrado', tbo().filter((e) => e.code !== 'tbo-hotels'), 'not-enabled'],
    [
      'de llamada siempre y sin ajustes',
      tbo({ callPolicy: 'always', decision: undefined }),
      'enabled',
    ],
    [
      'encendido por la variable legado',
      tbo({ decision: { enabled: true, origin: 'legacy-env' } }),
      'enabled',
    ],
  ] as const)('TBO %s: %s', async (_caso, entries, esperado) => {
    const node = await unNodo({ enablement: () => Promise.resolve([...entries]) });

    expect(node.tbo).toBe(esperado);
    expect(node.missing.includes('tbo-not-enabled')).toBe(esperado !== 'enabled');
  });

  it.each(['tbo-hotels', 'tbo-hotels:ventas', 'despegar-hotels,tbo-hotels'])(
    'con PROVIDERS_DISABLED=%s, TBO está apagado de emergencia aunque su ajuste lo encienda',
    async (valor) => {
      vi.stubEnv('PROVIDERS_DISABLED', valor);
      try {
        const node = await unNodo({});

        expect(node.tbo).toBe('kill-switch');
        expect(node.missing).toEqual(['tbo-not-enabled']);
        expect(node.ready).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('el apagado de emergencia de otro proveedor no toca a TBO', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'despegar-hotels');
    try {
      const node = await unNodo({});

      expect(node.tbo).toBe('enabled');
      expect(node.ready).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['incomplete', 'not-allowed'] as const)(
    'una cuenta %s es un faltante de la cuenta, con su motivo',
    async (status) => {
      const node = await unNodo({ account: () => Promise.resolve({ status }) });

      expect(node.account).toEqual({ status });
      expect(node.missing).toEqual(['tbo-account']);
    },
  );

  it('una cuenta que no declara entorno sale con `environment: null`', async () => {
    const node = await unNodo({
      account: () => Promise.resolve({ status: 'ok', source: 'inherited' }),
    });

    expect(node.account).toEqual({ status: 'ok', source: 'inherited', environment: null });
    expect(node.ready).toBe(true);
  });

  it('con la cuenta propia del nodo no hace falta cartera: esa venta no retiene', async () => {
    const node = await unNodo({
      account: () => Promise.resolve({ status: 'ok', source: 'own', environment: 'live' }),
      wallets: () => Promise.resolve([]),
    });

    expect(node.missing).toEqual([]);
    expect(node.ready).toBe(true);
  });

  it('con la cuenta heredada, sin ninguna cartera activa falta la cartera', async () => {
    const node = await unNodo({ wallets: () => Promise.resolve([]) });

    expect(node.wallets).toEqual([]);
    expect(node.missing).toEqual(['wallet']);
  });

  it('una cartera activa alcanza aunque haya otras suspendidas', async () => {
    const node = await unNodo({
      wallets: () =>
        Promise.resolve([
          { currency: 'COP', status: 'suspended' },
          { currency: 'USD', status: 'active' },
        ]),
    });

    expect(node.missing).toEqual([]);
  });

  it('cuenta sólo a quien vende, activo, y no a quien consulta', async () => {
    const node = await unNodo({
      users: () =>
        Promise.resolve([
          usuario({ userId: id(1) }),
          usuario({ userId: id(2), role: 'agency_admin' }),
          // El superadmin no vende aunque tenga una membership de vendedor en la sucursal.
          usuario({ userId: SUPERADMIN }),
          usuario({ userId: id(3), userStatus: 'suspended' }),
          usuario({ userId: id(4), membershipStatus: 'suspended' }),
          usuario({ userId: id(5), membershipStatus: 'invited' }),
          usuario({ userId: id(6), role: 'cliente_final' }),
          usuario({ userId: id(7), role: 'superadmin' }),
        ]),
    });

    expect(node.activeSellers).toBe(2);
  });

  it('el log lleva conteos, sin nombres de nodos', async () => {
    const { service } = banco({
      network: [nodo(NORTE, 'Sucursal Norte'), nodo(CENTRO, 'Sucursal Centro')],
      users: (tenantId) => Promise.resolve(tenantId === NORTE ? [usuario()] : []),
    });

    await service.readiness(SUPERADMIN);

    expect(log).toHaveBeenCalledWith('hotels.readiness nodes=2 ready=1 unknown=0 omitted=0');
  });
});

describe('cuando una consulta falla o tarda', () => {
  const fallas: [string, Escenario, Partial<HotelReadinessNode>][] = [
    [
      'la habilitación',
      { enablement: () => Promise.reject(new Error('secreto')) },
      { tbo: 'unknown' },
    ],
    [
      'la cuenta',
      { account: () => Promise.reject(new Error('secreto')) },
      { account: { status: 'unknown' } },
    ],
    ['las carteras', { wallets: () => Promise.reject(new Error('secreto')) }, { wallets: null }],
    [
      'el contacto',
      { contact: () => Promise.reject(new Error('secreto')) },
      { supportContact: 'unknown' },
    ],
    [
      'los vendedores',
      { users: () => Promise.reject(new Error('secreto')) },
      { activeSellers: null },
    ],
  ];

  it.each(fallas)(
    'si falla %s, queda sin revisar: no es un faltante ni está lista',
    async (_q, escenario, esperado) => {
      const { service } = banco(escenario);

      const view = await service.readiness(SUPERADMIN);
      const [node] = view.nodes;

      expect(node).toMatchObject(esperado);
      expect(node?.ready).toBe(false);
      expect(node?.missing).toEqual([]);
      expect(view.partial).toBe(true);
      // El nombre del error, nunca su mensaje.
      expect(warn).toHaveBeenCalledTimes(1);
      const [line] = warn.mock.calls[0] as [string];
      expect(line).toMatch(/^hotels\.readiness\.check_failed check=\w+ tenant=\S+ error=Error$/);
      expect(line).not.toContain('secreto');
    },
  );

  it('lo que no es un Error se registra sin inventarle un nombre', async () => {
    const { service, branding } = banco();
    branding.resolveSupportContact.mockRejectedValue('texto suelto');

    await service.readiness(SUPERADMIN);

    expect(warn).toHaveBeenCalledWith(
      `hotels.readiness.check_failed check=support_contact tenant=${NORTE} error=UnknownError`,
    );
  });

  it(`de a ${READINESS_CONCURRENCY} nodos a la vez`, async () => {
    let enCurso = 0;
    let maximo = 0;
    const { service } = banco({
      network: Array.from({ length: 10 }, (_, i) => nodo(id(i), `Sucursal ${i}`)),
      account: async () => {
        enCurso += 1;
        maximo = Math.max(maximo, enCurso);
        await new Promise((resolve) => setTimeout(resolve, 2));
        enCurso -= 1;
        return { status: 'ok', source: 'inherited', environment: 'test' };
      },
    });

    const view = await service.readiness(SUPERADMIN);

    expect(view.nodes.every((n) => n.ready)).toBe(true);
    expect(maximo).toBe(READINESS_CONCURRENCY);
  });

  it(`pasado el plazo (${READINESS_DEADLINE_MS} ms) sale con lo que llegó y no empieza más nodos`, async () => {
    vi.useFakeTimers();
    const lenta = id(1);
    const { service, registry } = banco({
      network: Array.from({ length: 6 }, (_, i) => nodo(id(i), `Sucursal ${i}`)),
      // El primer nodo responde todo menos sus vendedores; los otros tres de la tanda se cuelgan.
      account: (tenantId) =>
        tenantId === id(0)
          ? Promise.resolve({ status: 'ok', source: 'inherited', environment: 'test' })
          : colgada(),
      users: (tenantId) => (tenantId === id(0) ? colgada() : Promise.resolve([usuario()])),
    });

    const pending = service.readiness(SUPERADMIN);
    await vi.advanceTimersByTimeAsync(READINESS_DEADLINE_MS);
    const view = await pending;

    expect(view.partial).toBe(true);
    expect(view.nodes).toHaveLength(6);
    expect(view.nodes[0]).toMatchObject({
      account: { status: 'ok' },
      tbo: 'enabled',
      activeSellers: null,
      ready: false,
    });
    expect(view.nodes.find((n) => n.tenantId === lenta)).toMatchObject({
      account: { status: 'unknown' },
      activeSellers: 1,
    });
    // Los dos últimos no se llegaron a empezar: todo sin revisar, sin consultas.
    for (const node of view.nodes.slice(4)) {
      expect(node).toMatchObject({
        tbo: 'unknown',
        account: { status: 'unknown' },
        wallets: null,
        supportContact: 'unknown',
        activeSellers: null,
        ready: false,
        missing: [],
      });
    }
    expect(registry.accountStatusOf).toHaveBeenCalledTimes(READINESS_CONCURRENCY);
    expect(log).toHaveBeenCalledWith('hotels.readiness nodes=6 ready=0 unknown=6 omitted=0');
    // El plazo no queda colgado del event loop.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('si todo llega a tiempo, el plazo se cancela', async () => {
    vi.useFakeTimers();
    const { service } = banco();

    await service.readiness(SUPERADMIN);

    expect(vi.getTimerCount()).toBe(0);
  });
});
