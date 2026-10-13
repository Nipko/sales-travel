import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { voseoIn } from '../../lib/voseo';

/*
 * Inicio: las ventas del mes van una línea por moneda ("{monto} {moneda}"), nunca sumadas; sin
 * ventas, un guion y "Sin ventas este mes". Los accesos rápidos van en tú.
 */

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  getActiveTenant: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock('../../lib/api', () => ({ api: mocks.api }));
vi.mock('../../lib/session', () => ({ getActiveTenant: mocks.getActiveTenant }));

import DashboardPage from './page';

const AGENCY = '00000000-0000-4000-8000-0000000000cc';

function membership(role: string) {
  return {
    id: 'm1',
    role,
    status: 'active',
    tenantId: AGENCY,
    tenantSlug: 'sur',
    tenantName: 'Agencia Sur',
    isDefault: true,
  };
}

/** Formas de usted que tenía Inicio. */
const USTED = /(?<!\p{L})(?:inicie|arme|corrija|gestione|tiene|su|sus|usted)(?!\p{L})/giu;

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function inicio(
  kpis: unknown,
  role = 'tenant_admin',
  memberships?: unknown[],
): Promise<string> {
  mocks.getActiveTenant.mockResolvedValue(AGENCY);
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/me/memberships'
        ? { ok: true, data: memberships ?? [membership(role)] }
        : path === '/reports/dashboard'
          ? kpis
          : { ok: false, error: { status: 404, message: 'No' } },
    ),
  );
  return textOf(renderToStaticMarkup(await DashboardPage()));
}

const BASE = { quotationsThisMonth: 4, confirmedThisMonth: 3, activeCustomers: 7 };

/** El texto de la tarjeta "Ventas del mes": desde su etiqueta hasta la tarjeta siguiente. */
function salesCard(text: string): string {
  const start = text.indexOf('Ventas del mes');
  const end = text.indexOf('Mis Agencias Asignadas');
  return text.slice(start, end);
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.getActiveTenant.mockReset();
});

describe('Inicio: ventas del mes', () => {
  it('una línea por moneda, sin sumarlas', async () => {
    const text = await inicio({
      ok: true,
      data: {
        ...BASE,
        salesThisMonth: [
          { currency: 'COP', amountMinor: 1_500_000_00 },
          { currency: 'USD', amountMinor: 80_50 },
        ],
      },
    });
    const card = salesCard(text);
    expect(card).toContain('1.500.000 COP');
    expect(card).toContain('80,50 USD');
    expect(card).toContain('Confirmadas y emitidas');
    expect(text).toContain('Reservas confirmadas 3');
  });

  it('sin ventas: un guion y "Sin ventas este mes", no un cero', async () => {
    const card = salesCard(await inicio({ ok: true, data: { ...BASE, salesThisMonth: [] } }));
    expect(card).toContain('—');
    expect(card).toContain('Sin ventas este mes');
    expect(card).not.toMatch(/\d/);
  });

  it('si el API no responde, o con la forma vieja, guiones y "Sin datos"', async () => {
    const down = salesCard(await inicio({ ok: false, error: { status: 503, message: 'caído' } }));
    expect(down).toContain('—');
    expect(down).toContain('Sin datos');
    const old = salesCard(
      await inicio({ ok: true, data: { ...BASE, salesThisMonthMinor: 1_000, currency: 'COP' } }),
    );
    expect(old).toContain('Sin datos');
    expect(old).not.toContain('COP');
  });
});

describe('Inicio va en tú', () => {
  const kpis = { ok: true, data: { ...BASE, salesThisMonth: [] } };

  it('para quien vende', async () => {
    const text = await inicio(kpis);
    expect(text).toContain('Inicia una nueva cotización de pasajes aéreos');
    expect(text).toContain('Gestiona PNRs de clientes y emisiones pendientes');
    expect(voseoIn(text)).toEqual([]);
    expect([...text.matchAll(USTED)].map((m) => m[0])).toEqual([]);
  });

  it('para el superadmin operando una sucursal sin vender', async () => {
    const text = await inicio(kpis, 'superadmin', [
      { ...membership('superadmin'), tenantId: '00000000-0000-4000-8000-0000000000aa' },
      membership('platform_admin'),
    ]);
    expect(text).toContain('Arma y corrige la red: sucursales, agencias y consolidadores');
    expect([...text.matchAll(USTED)].map((m) => m[0])).toEqual([]);
  });

  it('para un admin de plataforma que no es superadmin', async () => {
    const text = await inicio(kpis, 'platform_admin');
    expect(text).toContain('Nodos, credenciales y reglas de tu red');
    expect([...text.matchAll(USTED)].map((m) => m[0])).toEqual([]);
  });

  it('sin agencias asignadas', async () => {
    mocks.getActiveTenant.mockResolvedValue(null);
    const text = await inicio(kpis, 'tenant_admin', []);
    expect(text).toContain('No tienes agencias asignadas a tu perfil todavía.');
    expect([...text.matchAll(USTED)].map((m) => m[0])).toEqual([]);
  });
});
