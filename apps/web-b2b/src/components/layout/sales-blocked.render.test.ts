import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SalesBlockedBanner, SalesBlockedNotice } from './sales-blocked';

describe('SalesBlockedNotice: la pantalla de venta del superadmin', () => {
  it('dice que el superadmin no vende y a dónde ir', () => {
    const html = renderToStaticMarkup(createElement(SalesBlockedNotice));
    expect(html).toContain('El superadministrador no vende: usa un usuario de una sucursal');
    expect(html).toContain('<h1');
    expect(html).toContain('Con tu usuario armas y corriges la red');
    expect(html).toContain('créala desde Gestión de Agencias y súmale sus vendedores');
    expect(html).toContain('href="/admin/tenants"');
    expect(html).toContain('href="/reservas"');
  });

  it('explica cómo probar una venta con otra cuenta y ofrece invitar al vendedor', () => {
    const html = renderToStaticMarkup(createElement(SalesBlockedNotice));
    expect(html).toContain('Para probar una venta, entra con un vendedor de una sucursal.');
    expect(html).toContain(
      'Tiene que ser otra cuenta, con otro correo: la regla mira a la persona, no al nodo.',
    );
    expect(html).toContain('tunombre+vendedor@gmail.com');
    expect(html).toContain('te llega a la misma bandeja');
    expect(html).toMatch(/<a[^>]*href="\/admin\/usuarios"[^>]*>.*Invitar un vendedor<\/a>/);
  });

  it('las tres acciones van en orden: crear la sucursal, invitar al vendedor, ver lo vendido', () => {
    const html = renderToStaticMarkup(createElement(SalesBlockedNotice));
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/admin/tenants', '/admin/usuarios', '/reservas']);
  });
});

describe('SalesBlockedBanner: dentro de Mis Reservas', () => {
  it('es una nota con el mismo texto y la aclaración', () => {
    const html = renderToStaticMarkup(
      createElement(SalesBlockedBanner, null, 'Aquí consultas y cancelas lo ya vendido.'),
    );
    expect(html).toContain('role="note"');
    expect(html).toContain('El superadministrador no vende: usa un usuario de una sucursal.');
    expect(html).toContain('Aquí consultas y cancelas lo ya vendido.');
  });
});
