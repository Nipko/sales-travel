import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeSectionNav } from '../../app/(app)/admin/tenants/[tenantId]/_components/node-section-nav';
import { WalletFinancingPanel } from './wallet-financing-panel';

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
