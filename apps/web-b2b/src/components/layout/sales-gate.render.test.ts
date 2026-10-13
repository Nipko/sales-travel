import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERADMIN_CANNOT_SELL, viewerOf, type Viewer } from '../../lib/viewer';
import { SalesGate } from './sales-gate';
import { ViewerProvider } from './viewer-context';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const SCREEN = 'pantalla-montada';

function render(viewer: Viewer, pathname: string): string {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    createElement(ViewerProvider, {
      viewer,
      children: createElement(SalesGate, null, createElement('p', null, SCREEN)),
    }),
  );
}

const superadmin = viewerOf([{ role: 'superadmin', status: 'active' }]);
const vendedor = viewerOf([{ role: 'vendedor', status: 'active' }]);

describe('SalesGate: el superadmin no ve las pantallas de venta', () => {
  beforeEach(() => {
    nav.pathname = '/';
  });

  it.each(['/cotizaciones', '/hoteles/checkout', '/autos', '/autos/oficinas', '/paquetes'])(
    'en %s el superadmin ve el aviso y la pantalla no se monta',
    (path) => {
      const html = render(superadmin, path);
      expect(html).toContain(SUPERADMIN_CANNOT_SELL);
      expect(html).not.toContain(SCREEN);
    },
  );

  it('también si además es vendedor de una sucursal', () => {
    const both = viewerOf([
      { role: 'vendedor', status: 'active' },
      { role: 'superadmin', status: 'active' },
    ]);
    expect(render(both, '/hoteles')).not.toContain(SCREEN);
  });

  it('en Hoteles el superadmin ve además la guía para probar una reserva; en otra venta, no', () => {
    expect(render(superadmin, '/hoteles')).toContain('Probar una reserva de hotel');
    expect(render(superadmin, '/hoteles/checkout')).toContain('Probar una reserva de hotel');
    expect(render(superadmin, '/cotizaciones')).not.toContain('Probar una reserva de hotel');
  });

  it('un platform_admin ve el aviso en Hoteles, sin la guía: la revisión es del superadmin', () => {
    const platformAdmin = viewerOf([{ role: 'platform_admin', status: 'active' }]);
    const html = render(platformAdmin, '/hoteles');
    expect(html).toContain(SUPERADMIN_CANNOT_SELL);
    expect(html).not.toContain('Probar una reserva de hotel');
    expect(html).not.toContain(SCREEN);
  });

  it('quien vende ve la pantalla de venta', () => {
    const html = render(vendedor, '/hoteles');
    expect(html).toContain(SCREEN);
    expect(html).not.toContain(SUPERADMIN_CANNOT_SELL);
  });

  it.each(['/', '/reservas', '/autos/reporte', '/admin/tenants', '/red'])(
    'fuera de la venta, el superadmin ve %s tal cual',
    (path) => {
      const html = render(superadmin, path);
      expect(html).toContain(SCREEN);
      expect(html).not.toContain(SUPERADMIN_CANNOT_SELL);
    },
  );
});
