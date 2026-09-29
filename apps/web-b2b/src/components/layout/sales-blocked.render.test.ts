import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SalesBlockedBanner, SalesBlockedNotice } from './sales-blocked';

describe('SalesBlockedNotice: la pantalla de venta del superadmin', () => {
  it('dice que el superadmin no vende y a dónde ir', () => {
    const html = renderToStaticMarkup(createElement(SalesBlockedNotice));
    expect(html).toContain('El superadministrador no vende: usá un usuario de una sucursal');
    expect(html).toContain('<h1');
    expect(html).toContain('href="/admin/tenants"');
    expect(html).toContain('href="/reservas"');
  });
});

describe('SalesBlockedBanner: dentro de Mis Reservas', () => {
  it('es una nota con el mismo texto y la aclaración', () => {
    const html = renderToStaticMarkup(
      createElement(SalesBlockedBanner, null, 'Acá consultás y cancelás lo ya vendido.'),
    );
    expect(html).toContain('role="note"');
    expect(html).toContain('El superadministrador no vende: usá un usuario de una sucursal.');
    expect(html).toContain('Acá consultás y cancelás lo ya vendido.');
  });
});
