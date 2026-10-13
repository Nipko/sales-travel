import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeSectionNav } from './node-section-nav';

const NODE = '10000000-0000-4000-8000-000000000001';

function tabs(current: 'providers' | 'wallets' | 'seats'): string[] {
  const html = renderToStaticMarkup(createElement(NodeSectionNav, { tenantId: NODE, current }));
  return [...html.matchAll(/<a [^>]*>.*?<\/a>/g)].map((m) => m[0]);
}

describe('NodeSectionNav — Usuarios', () => {
  it('lleva a Equipo abierto en el nodo, como última pestaña', () => {
    const all = tabs('providers');
    const users = all.at(-1) ?? '';
    expect(users).toContain(`href="/admin/usuarios?tenant=${NODE}"`);
    expect(users).toContain('Usuarios');
    expect(users).not.toContain('aria-current');
    expect(all).toHaveLength(4);
  });

  it('nunca es la sección actual de Gestión de Agencias', () => {
    for (const current of ['providers', 'wallets', 'seats'] as const) {
      const active = tabs(current).filter((a) => a.includes('aria-current="page"'));
      expect(active).toHaveLength(1);
      expect(active[0]).not.toContain('/admin/usuarios');
    }
  });
});
