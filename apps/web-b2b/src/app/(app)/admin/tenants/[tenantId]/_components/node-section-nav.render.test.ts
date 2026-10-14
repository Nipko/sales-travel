import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeSectionNav, type NodeSection } from './node-section-nav';

const NODE = '10000000-0000-4000-8000-000000000001';

function tabs(current: NodeSection): string[] {
  const html = renderToStaticMarkup(createElement(NodeSectionNav, { tenantId: NODE, current }));
  return [...html.matchAll(/<a [^>]*>.*?<\/a>/g)].map((m) => m[0]);
}

function hrefOf(tab: string): string | undefined {
  return /href="([^"]*)"/.exec(tab)?.[1];
}

describe('NodeSectionNav — el orden de las pestañas', () => {
  it('Resumen primero; Proveedores sigue en la raíz del nodo; Usuarios al final', () => {
    expect(tabs('summary').map(hrefOf)).toEqual([
      `/admin/tenants/${NODE}/resumen`,
      `/admin/tenants/${NODE}`,
      `/admin/tenants/${NODE}/carteras`,
      `/admin/tenants/${NODE}/puestos`,
      `/admin/usuarios?tenant=${NODE}`,
    ]);
    expect(tabs('summary').map((a) => a.replace(/<[^>]+>/g, ''))).toEqual([
      'Resumen',
      'Proveedores',
      'Carteras',
      'Puestos y sesión',
      'Usuarios',
    ]);
  });

  it('marca como actual sólo la pestaña abierta', () => {
    const cases: readonly (readonly [NodeSection, string])[] = [
      ['summary', `/admin/tenants/${NODE}/resumen`],
      ['providers', `/admin/tenants/${NODE}`],
      ['wallets', `/admin/tenants/${NODE}/carteras`],
      ['seats', `/admin/tenants/${NODE}/puestos`],
    ];
    for (const [current, href] of cases) {
      const active = tabs(current).filter((a) => a.includes('aria-current="page"'));
      expect(active).toHaveLength(1);
      expect(hrefOf(active[0] ?? '')).toBe(href);
    }
  });
});

describe('NodeSectionNav — Usuarios', () => {
  it('lleva a Equipo abierto en el nodo, como última pestaña', () => {
    const all = tabs('providers');
    const users = all.at(-1) ?? '';
    expect(users).toContain(`href="/admin/usuarios?tenant=${NODE}"`);
    expect(users).toContain('Usuarios');
    expect(users).not.toContain('aria-current');
    expect(all).toHaveLength(5);
  });

  it('nunca es la sección actual de Gestión de Agencias', () => {
    for (const current of ['summary', 'providers', 'wallets', 'seats'] as const) {
      const active = tabs(current).filter((a) => a.includes('aria-current="page"'));
      expect(active).toHaveLength(1);
      expect(active[0]).not.toContain('/admin/usuarios');
    }
  });
});
