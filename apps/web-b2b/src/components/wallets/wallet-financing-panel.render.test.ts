import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeSectionNav } from '../../app/(app)/admin/tenants/[tenantId]/_components/node-section-nav';
import type { NetworkHolds } from '../../lib/wallets';
import {
  FinancedNetworkHolds,
  WalletFinancingPanel,
  showsNetworkHolds,
} from './wallet-financing-panel';

describe('WalletFinancingPanel en su primer pintado', () => {
  it('vuelve a donde se abrió y anuncia que está cargando', () => {
    const html = renderToStaticMarkup(
      createElement(WalletFinancingPanel, {
        tenantId: '10000000-0000-4000-8000-000000000001',
        back: { href: '/red', label: 'Mi Red' },
      }),
    );
    expect(html).toContain('href="/red"');
    expect(html).toContain('Mi Red');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Cargando las carteras…');
  });
});

describe('NodeSectionNav — las secciones de un nodo en Gestión de Agencias', () => {
  it('marca la sección actual con aria-current y enlaza la otra', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const html = renderToStaticMarkup(
      createElement(NodeSectionNav, { tenantId: id, current: 'wallets' }),
    );
    expect(html).toContain('aria-label="Secciones del nodo"');
    const current = /<a[^>]*aria-current="page"[^>]*>/.exec(html)?.[0] ?? '';
    expect(current).toContain(`href="/admin/tenants/${id}/carteras"`);
    expect(html).toContain(`href="/admin/tenants/${id}"`);
    expect([...html.matchAll(/aria-current/g)]).toHaveLength(1);
  });
});

const HOLDS: NetworkHolds = {
  items: [
    {
      levelId: '60000000-0000-4000-8000-000000000001',
      currency: 'USD',
      exponent: 2,
      amountMinor: 105_000,
      status: 'captured',
      originTenantId: '10000000-0000-4000-8000-00000000000a',
      originTenantName: 'Sub-agencia Norte',
      orderNumber: 77,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:10:00.000Z',
    },
    {
      levelId: '60000000-0000-4000-8000-000000000002',
      currency: 'COP',
      exponent: 2,
      amountMinor: 50_000_000,
      status: 'held',
      originTenantId: '10000000-0000-4000-8000-00000000000b',
      originTenantName: 'Agencia Sur',
      orderNumber: 78,
      createdAt: '2026-09-29T13:00:00.000Z',
      updatedAt: '2026-09-29T13:00:00.000Z',
    },
  ],
  totals: [
    { currency: 'COP', exponent: 2, heldMinor: 50_000_000, chargedMinor: 0 },
    { currency: 'USD', exponent: 2, heldMinor: 0, chargedMinor: 105_000 },
  ],
};

function network(holds: Parameters<typeof FinancedNetworkHolds>[0]['holds']): string {
  return renderToStaticMarkup(
    createElement(FinancedNetworkHolds, { nodeName: 'Consolidador Andino', holds }),
  );
}

describe('FinancedNetworkHolds — las reservas de la red del hijo gestionado (0060)', () => {
  it('una sección con título, qué es y a qué costo, los totales y cada reserva con su estado', () => {
    const html = network({ status: 'ready', data: HOLDS });
    expect(html).toMatch(/<section aria-labelledby="network-holds-title"/);
    expect(html).toMatch(/<h2 id="network-holds-title"[^>]*>Reservas de su red<\/h2>/);
    expect(html).toContain(
      'Lo que la red de Consolidador Andino tiene retenido o cobrado en sus carteras, al costo de su',
    );
    expect(html).toContain('aria-label="Totales por moneda"');
    expect(html).toContain('Sub-agencia Norte');
    expect(html).toContain('Reserva #77');
    expect(html).toContain('Cobrada');
    expect(html).toContain('Retenida');
  });

  it('con varias monedas, el filtro y la moneda en cada reserva', () => {
    const html = network({ status: 'ready', data: HOLDS });
    expect(html).toContain('<legend class="sr-only">Moneda de las reservas de su red</legend>');
    expect(html).toMatch(/Reserva #77 · [^<]* · USD/);
  });

  it('cargando, un esqueleto; con error, el mensaje como alerta', () => {
    expect(network({ status: 'loading' })).toContain('animate-pulse');
    const error = network({ status: 'error', message: 'No se pudieron cargar las carteras.' });
    expect(error).toContain('role="alert"');
    expect(error).toContain('No se pudieron cargar las carteras.');
  });

  it('la sección sale si el nodo financia y hay algo de su red en sus carteras, o si no se leyó', () => {
    const ready = (data: NetworkHolds) => ({ status: 'ready', data }) as const;
    expect(showsNetworkHolds(true, ready(HOLDS))).toBe(true);
    // Una agencia sin sub-agencias, o una red que reserva con la cuenta propia del nodo.
    expect(showsNetworkHolds(true, ready({ items: [], totals: [] }))).toBe(false);
    expect(showsNetworkHolds(false, ready(HOLDS))).toBe(false);
    expect(showsNetworkHolds(true, { status: 'loading' })).toBe(false);
    expect(showsNetworkHolds(true, { status: 'error', message: 'x' })).toBe(true);
  });

  it('con la lista cortada por el API, lo dice', () => {
    const html = network({ status: 'ready', data: { ...HOLDS, truncated: true } });
    expect(html).toContain('La lista muestra las 200 reservas más recientes');
    expect(network({ status: 'ready', data: HOLDS })).not.toContain('más recientes');
  });

  it('sin reservas de su red, el estado vacío con el nombre del nodo', () => {
    const html = network({ status: 'ready', data: { items: [], totals: [] } });
    expect(html).toContain('Todavía no hay reservas de su red en sus carteras.');
    expect(html).toContain('Cuando una reserva de la red de Consolidador Andino retenga saldo');
  });
});
