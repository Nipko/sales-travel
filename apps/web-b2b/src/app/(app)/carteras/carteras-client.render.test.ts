import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyWallets, Wallet } from '../../../lib/wallets';
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
});
