import { describe, expect, it } from 'vitest';
import { operationsNav } from './nav';
import {
  ANONYMOUS_VIEWER,
  SUPERADMIN_CANNOT_SELL,
  canSell,
  isSalesPath,
  navForViewer,
  salesAreaOf,
  viewerOf,
} from './viewer';

const m = (role: string, status = 'active') => ({ role, status });

describe('viewerOf: el superadmin es una identidad del usuario', () => {
  it('el superadmin de Planetour no vende y arma la red', () => {
    const viewer = viewerOf([m('superadmin')]);
    expect(viewer).toEqual({ platformUser: true, superadmin: true });
    expect(canSell(viewer)).toBe(false);
  });

  it('tampoco vende desde una sucursal donde además es vendedor', () => {
    expect(canSell(viewerOf([m('vendedor'), m('superadmin')]))).toBe(false);
  });

  it('platform_admin (retirado) tampoco vende, pero no arma la red', () => {
    expect(viewerOf([m('platform_admin')])).toEqual({ platformUser: true, superadmin: false });
  });

  it('una membership de plataforma suspendida no cuenta, como en la API', () => {
    expect(viewerOf([m('superadmin', 'suspended'), m('vendedor')])).toEqual(ANONYMOUS_VIEWER);
  });

  it('admins y vendedores de la red venden', () => {
    for (const role of [
      'consolidator_admin',
      'tenant_admin',
      'agency_admin',
      'admin',
      'vendedor',
    ]) {
      expect(canSell(viewerOf([m(role)]))).toBe(true);
    }
    expect(canSell(viewerOf([]))).toBe(true);
  });

  it('el aviso dice lo mismo que el 403 del API', () => {
    expect(SUPERADMIN_CANNOT_SELL).toBe(
      'El superadministrador no vende: usá un usuario de una sucursal',
    );
  });
});

describe('salesAreaOf: qué pantallas son de venta', () => {
  it.each([
    ['/cotizaciones', 'flights'],
    ['/cotizaciones/guardadas', 'flights'],
    ['/cotizaciones/0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f', 'flights'],
    ['/hoteles', 'hotels'],
    ['/hoteles/checkout', 'hotels'],
    ['/hoteles/tbo-hotels~123', 'hotels'],
    ['/autos', 'cars'],
    ['/autos/', 'cars'],
    ['/autos/oficinas', 'cars'],
    ['/paquetes', 'packages'],
    ['/paquetes/nuevo', 'packages'],
  ] as const)('%s es venta (%s)', (path, area) => {
    expect(salesAreaOf(path)).toBe(area);
  });

  it.each([
    '/',
    '/reservas',
    '/autos/reporte',
    '/red',
    '/admin/tenants',
    '/carteras',
    '/clientes',
    '/configuracion/seguridad',
    '/cotizacionesx',
    '/hotelesque',
  ])('%s no es venta', (path) => {
    expect(isSalesPath(path)).toBe(false);
  });

  it('ignora query y fragmento', () => {
    expect(salesAreaOf('/hoteles?destino=CTG')).toBe('hotels');
    expect(salesAreaOf('/reservas?orden=1')).toBeUndefined();
  });
});

describe('navForViewer: el menú del superadmin no tiene venta', () => {
  it('el superadmin ve Inicio, Reporte autos y Mis Reservas', () => {
    const labels = navForViewer(operationsNav, viewerOf([m('superadmin')])).map((i) => i.label);
    expect(labels).toEqual(['Inicio', 'Reporte autos', 'Mis Reservas']);
  });

  it('quien vende ve el menú completo', () => {
    expect(navForViewer(operationsNav, viewerOf([m('vendedor')]))).toEqual(operationsNav);
  });
});
