import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlatformProvider } from '../../../../../../lib/provider-enablement';
import { AddExceptionDialog } from './add-exception-dialog';

/*
 * "Agregar excepción" en su primer pintado: qué ofrece antes de elegir un tenant.
 */

function provider(over: Partial<PlatformProvider> = {}): PlatformProvider {
  return {
    code: 'tbo-hotels',
    vertical: 'hotels',
    callPolicy: 'opt-in',
    defaultEnabled: false,
    killSwitch: null,
    legacyEnv: { allTenants: false, tenantIds: [] },
    global: null,
    overrides: [],
    baseline: { enabled: false, origin: 'default' },
    ...over,
  };
}

function render(p: PlatformProvider, tenants: Parameters<typeof AddExceptionDialog>[0]['tenants']) {
  return renderToStaticMarkup(
    createElement(AddExceptionDialog, {
      provider: p,
      tenants,
      onConfirm: () => Promise.resolve(undefined),
      onClose: () => undefined,
    }),
  );
}

const TENANTS = {
  ok: true as const,
  data: [{ id: '10000000-0000-4000-8000-000000000002', name: 'Agencia Norte', slug: 'norte' }],
};

describe('AddExceptionDialog', () => {
  it('nombra el proveedor y pide buscar el tenant antes de guardar', () => {
    const html = render(provider(), TENANTS);
    expect(html).toContain('Agregar excepción de TBO Holidays');
    expect(html).toContain('type="search"');
    expect(html).toContain('Escribí parte del nombre o del slug.');
    expect(html).toMatch(/type="submit" disabled="">Agregar</);
  });

  it('sólo ofrece Habilitado y Deshabilitado: una excepción no es "Heredar"', () => {
    const html = render(provider(), TENANTS);
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(2);
    expect(html).not.toContain('value="inherit"');
  });

  it('arranca en lo contrario de lo que ven hoy los tenants sin excepción', () => {
    expect(render(provider(), TENANTS)).toMatch(/checked="" value="enabled"/);
    expect(
      render(
        provider({ defaultEnabled: true, baseline: { enabled: true, origin: 'default' } }),
        TENANTS,
      ),
    ).toMatch(/checked="" value="disabled"/);
  });

  it('si la lista de tenants no cargó, lo dice y no deja buscar', () => {
    const html = render(provider(), { ok: false, message: 'No pudimos conectar.' });
    expect(html).toContain('No se pudo cargar la lista de tenants: No pudimos conectar.');
    expect(html).toMatch(/type="search"[^>]*disabled=""|disabled=""[^>]*type="search"/);
  });
});
