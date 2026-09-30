import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyWallets, NetworkHolds, Wallet } from '../../../lib/wallets';
import { CarterasClient } from './CarterasClient';

/*
 * Cartera B2B desde la agencia (decisión del founder del 2026-09-29, opción A): ve sus carteras y
 * sus movimientos, informa depósitos, y nunca se carga saldo ni se fija el cupo (la brecha crítica
 * de la auditoría del 2026-09-28).
 */

const USD: Wallet = {
  id: '20000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
  currency: 'USD',
  exponent: 2,
  creditLimitMinor: 100_000,
  balanceMinor: 20_000,
  availableMinor: 120_000,
  status: 'active',
  updatedAt: '',
};

const WALLETS: AgencyWallets = {
  portfolios: [USD],
  financier: { tenantId: '10000000-0000-4000-8000-000000000009', name: 'Consolidador Andino' },
};

/** Una sub-agencia retenida y otra en revisión, en la cartera USD de quien las financia. */
const NETWORK: NetworkHolds = {
  items: [
    {
      levelId: '60000000-0000-4000-8000-000000000001',
      currency: 'USD',
      exponent: 2,
      amountMinor: 113_400,
      status: 'held',
      originTenantId: '10000000-0000-4000-8000-00000000000a',
      originTenantName: 'Agencia Sur',
      orderNumber: 1042,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
    },
    {
      levelId: '60000000-0000-4000-8000-000000000002',
      currency: 'USD',
      exponent: 2,
      amountMinor: 105_000,
      status: 'conflict',
      originTenantId: '10000000-0000-4000-8000-00000000000b',
      originTenantName: 'Sub-agencia Norte',
      orderNumber: 1043,
      createdAt: '2026-09-29T11:00:00.000Z',
      updatedAt: '2026-09-29T11:30:00.000Z',
    },
  ],
  totals: [{ currency: 'USD', exponent: 2, heldMinor: 218_400, chargedMinor: 0 }],
};

function html(props: Partial<Parameters<typeof CarterasClient>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CarterasClient, {
      initialWallets: WALLETS,
      walletsError: null,
      initialMovements: [],
      initialReports: [],
      initialHeldOrders: [],
      role: 'tenant_admin',
      ...props,
    }),
  );
}

describe('CarterasClient', () => {
  it('el admin de la agencia informa depósitos; no hay recarga, retiro ni cupo', () => {
    const out = html();
    expect(out).toContain('Informar depósito');
    expect(out).not.toMatch(/Recargar|Acreditar|Retirar|Configurar Crédito|Actualizar Cupo/);
    expect(out).toContain('Pedíselo a Consolidador Andino');
  });

  it('el vendedor sólo mira', () => {
    expect(html({ role: 'vendedor' })).not.toContain('Informar depósito');
  });

  it('sin carteras: no se puede reservar, y a quién pedírsela', () => {
    const out = html({ initialWallets: { portfolios: [], financier: null } });
    expect(out).toContain('Tu agencia todavía no tiene carteras.');
    expect(out).toContain('Pedile a Planetour');
    expect(out).not.toContain('Informar depósito');
  });

  it('si no se pudieron leer, lo dice: nunca una cartera en cero inventada', () => {
    const out = html({ initialWallets: null, walletsError: 'No pudimos leer las carteras.' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('No pudimos leer las carteras.');
    expect(out).not.toContain('Disponible para reservar');
  });

  it('pestañas accesibles: tablist, la activa en el orden de tabulación y su panel', () => {
    const out = html();
    expect(out).toContain('role="tablist"');
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    expect([...out.matchAll(/role="tabpanel"/g)]).toHaveLength(3);
    // El panel entra en el orden de tabulación: su foco se ve (WCAG 2.4.7).
    const panel = /<div role="tabpanel"[^>]*>/.exec(out)?.[0] ?? '';
    expect(panel).toContain('tabindex="0"');
    expect(panel).toContain('focus-visible:ring-2');
  });

  it('una agencia sin red no ve la pestaña de su red', () => {
    const out = html({ initialNetworkHolds: NETWORK });
    expect(out).not.toContain('Reservas de tu red');
    expect(out).not.toContain('al costo de tu nivel');
  });
});

describe('CarterasClient — reservas de tu red (0060)', () => {
  it('quien financia a una red tiene su pestaña, con las abiertas contadas y dichas en voz', () => {
    const out = html({ financesNetwork: true, initialNetworkHolds: NETWORK });
    expect(out).toMatch(/role="tab"[^>]*>.*Reservas de tu red/);
    expect(out).toContain('reservas de tu red retenidas o en revisión');
    expect([...out.matchAll(/role="tabpanel"/g)]).toHaveLength(4);
    expect(out).toContain('Las reservas de tu red también pueden retener en tus carteras');
  });

  it('la pestaña: el subtítulo, los totales por moneda y cada reserva con su agencia y su estado', () => {
    const out = html({
      financesNetwork: true,
      initialNetworkHolds: NETWORK,
      initialTab: 'network',
    });
    expect(out).toContain(
      'Lo que tu red tiene retenido o cobrado en tus carteras, al costo de tu nivel.',
    );
    expect(out).toContain('aria-label="Totales por moneda"');
    expect(out).toMatch(/US\$\s?2\.184/);
    expect(out).toContain('Agencia Sur');
    expect(out).toContain('Reserva #1042');
    expect(out).toContain('Retenida');
    expect(out).toContain('En revisión');
  });

  it('nunca muestra quién vendió ni el precio de venta de la red', () => {
    const out = html({
      financesNetwork: true,
      initialNetworkHolds: NETWORK,
      initialTab: 'network',
    });
    expect(out).not.toMatch(/Vendedor|Pasajeros|Precio de venta/);
  });

  it('sin reservas de la red, el estado vacío', () => {
    const out = html({
      financesNetwork: true,
      initialNetworkHolds: { items: [], totals: [] },
      initialTab: 'network',
    });
    expect(out).toContain('Todavía no hay reservas de tu red en tus carteras.');
    expect(out).not.toContain('Totales por moneda');
  });

  it('si no se pudieron leer, lo dice en vez de mostrar una red vacía', () => {
    const out = html({ financesNetwork: true, initialNetworkHolds: null, initialTab: 'network' });
    expect(out).toContain('No pudimos cargar las reservas de tu red. Recargá la página.');
    expect(out).not.toContain('Todavía no hay reservas de tu red');
  });

  it('con la lista cortada por el API, lo dice y una moneda sin filas no se dice red vacía', () => {
    const out = html({
      financesNetwork: true,
      initialNetworkHolds: { ...NETWORK, truncated: true },
      initialTab: 'network',
    });
    expect(out).toContain('La lista muestra las 200 reservas más recientes');
    const empty = html({
      financesNetwork: true,
      initialNetworkHolds: { items: [], totals: NETWORK.totals, truncated: true },
      initialTab: 'network',
    });
    expect(empty).toContain('No hay reservas recientes en esta moneda.');
    expect(empty).not.toContain('Todavía no hay reservas de tu red');
  });

  it('sin red, pedir la pestaña de la red abre los movimientos', () => {
    const out = html({ initialTab: 'network' });
    expect(out).toContain('Sin movimientos todavía.');
  });
});
