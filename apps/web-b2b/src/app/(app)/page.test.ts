import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * La entrada al panel: el superadmin operando como plataforma va a su Resumen; cualquier otro (o el
 * mismo superadmin operando como vendedor de una sucursal) ve Inicio, como siempre.
 */

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  getActiveTenant: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('../../lib/api', () => ({ api: mocks.api }));
vi.mock('../../lib/session', () => ({ getActiveTenant: mocks.getActiveTenant }));

import DashboardPage from './page';
import PlatformIndexPage from './admin/plataforma/page';

const PLATFORM = '00000000-0000-4000-8000-0000000000aa';
const BRANCH = '00000000-0000-4000-8000-0000000000bb';

const SUPERADMIN_EVERYWHERE = [
  {
    id: 'm1',
    role: 'superadmin',
    status: 'active',
    tenantId: PLATFORM,
    tenantSlug: 'planetour',
    tenantName: 'Planetour',
    isDefault: true,
  },
  {
    id: 'm2',
    role: 'vendedor',
    status: 'active',
    tenantId: BRANCH,
    tenantSlug: 'planetour-bogota',
    tenantName: 'Planetour Bogotá',
    isDefault: false,
  },
];

function withMemberships(memberships: unknown[], activeTenant: string | null) {
  mocks.getActiveTenant.mockResolvedValue(activeTenant);
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/me/memberships'
        ? { ok: true, data: memberships }
        : { ok: false, error: { status: 404, message: 'No' } },
    ),
  );
}

/** A dónde redirige la página, o `null` si dibuja Inicio. */
async function landing(): Promise<string | null> {
  try {
    await DashboardPage();
    return null;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.getActiveTenant.mockReset();
});

describe('la entrada al panel', () => {
  it('el superadmin operando como plataforma entra al Resumen', async () => {
    withMemberships(SUPERADMIN_EVERYWHERE, PLATFORM);
    expect(await landing()).toBe('/admin/plataforma/resumen');
  });

  it('sin agencia activa elegida, la por defecto decide (la de la plataforma)', async () => {
    withMemberships(SUPERADMIN_EVERYWHERE, null);
    expect(await landing()).toBe('/admin/plataforma/resumen');
  });

  it('el mismo superadmin operando como vendedor de su sucursal ve Inicio', async () => {
    withMemberships(SUPERADMIN_EVERYWHERE, BRANCH);
    expect(await landing()).toBeNull();
  });

  it('un admin de agencia ve Inicio', async () => {
    withMemberships(
      [
        {
          id: 'm3',
          role: 'tenant_admin',
          status: 'active',
          tenantId: BRANCH,
          tenantSlug: 'sur',
          tenantName: 'Agencia Sur',
          isDefault: true,
        },
      ],
      BRANCH,
    );
    expect(await landing()).toBeNull();
  });

  it('si no se pudieron leer las memberships, Inicio: nunca un ida y vuelta', async () => {
    mocks.getActiveTenant.mockResolvedValue(PLATFORM);
    mocks.api.mockResolvedValue({ ok: false, error: { status: 503, message: 'caído' } });
    expect(await landing()).toBeNull();
  });
});

describe('/admin/plataforma', () => {
  it('a secas, es el Resumen', () => {
    expect(() => PlatformIndexPage()).toThrow(RedirectSignal);
    try {
      PlatformIndexPage();
    } catch (err) {
      expect((err as RedirectSignal).url).toBe('/admin/plataforma/resumen');
    }
  });
});
