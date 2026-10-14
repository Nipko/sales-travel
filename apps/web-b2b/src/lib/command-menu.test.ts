import { describe, expect, it } from 'vitest';
import { SWITCH_AGENCY_LABEL, commandItems, filterCommands, moveActive } from './command-menu';
import { navSections } from './nav';
import { ANONYMOUS_VIEWER } from './viewer';

const SECTIONS = [
  {
    label: 'Operaciones',
    items: [
      { label: 'Inicio', href: '/' },
      { label: 'Hoteles', href: '/hoteles' },
    ],
  },
  { label: 'Administración', items: [{ label: 'Proveedores (GDS)', href: '/admin/proveedores' }] },
];

describe('commandItems', () => {
  it('"Cambiar de agencia…" primero, con la agencia actual, y después las pantallas', () => {
    const items = commandItems({
      canSwitch: true,
      currentAgencyName: 'Andinos',
      sections: SECTIONS,
    });
    expect(items.map((i) => i.label)).toEqual([
      SWITCH_AGENCY_LABEL,
      'Inicio',
      'Hoteles',
      'Proveedores (GDS)',
    ]);
    expect(items[0]).toMatchObject({ kind: 'switch-agency', hint: 'Operas como Andinos' });
    expect(items[3]).toMatchObject({ kind: 'navigate', hint: 'Administración', group: 'Ir a' });
  });

  it('con una sola agencia no se ofrece el cambio', () => {
    const items = commandItems({ canSwitch: false, currentAgencyName: 'A', sections: SECTIONS });
    expect(items.some((i) => i.kind === 'switch-agency')).toBe(false);
  });

  it('una pantalla repetida en dos secciones aparece una vez', () => {
    const items = commandItems({
      canSwitch: false,
      currentAgencyName: null,
      sections: [...SECTIONS, { label: 'Otra', items: [{ label: 'Inicio', href: '/' }] }],
    });
    expect(items.filter((i) => i.kind === 'navigate' && i.href === '/')).toHaveLength(1);
  });
});

describe('filterCommands', () => {
  const items = commandItems({ canSwitch: true, currentAgencyName: 'Andinos', sections: SECTIONS });

  it('"agencia", "cambiar" o "tenant" encuentran el cambio de agencia', () => {
    for (const q of ['agencia', 'cambiar', 'tenant', 'operar']) {
      expect(filterCommands(items, q)[0]?.kind).toBe('switch-agency');
    }
  });

  it('por nombre de pantalla o de sección, sin tildes', () => {
    expect(filterCommands(items, 'hotel').map((i) => i.label)).toEqual(['Hoteles']);
    expect(filterCommands(items, 'administracion').map((i) => i.label)).toEqual([
      'Proveedores (GDS)',
    ]);
  });
});

describe('moveActive', () => {
  it('baja, sube y da la vuelta', () => {
    expect(moveActive(0, 1, 3)).toBe(1);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
  });

  it('desde un índice fuera de rango arranca por el extremo que corresponde', () => {
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(9, -1, 3)).toBe(2);
  });

  it('una lista vacía no se mueve', () => {
    expect(moveActive(0, 1, 0)).toBe(0);
  });
});

describe('navSections: la misma lista para el sidebar y la paleta', () => {
  const labels = (role: string | undefined, platformUser = false) =>
    navSections(role, { ...ANONYMOUS_VIEWER, platformUser, superadmin: role === 'superadmin' }).map(
      (s) => s.label,
    );

  it('un vendedor: sin Administración ni Plataforma', () => {
    expect(labels('vendedor')).toEqual(['Operaciones', 'Gestión', 'Mi cuenta']);
  });

  it('Mi cuenta, para cualquier rol: Perfil antes que Seguridad (USR-18)', () => {
    for (const role of ['vendedor', 'agency_admin', 'superadmin', undefined]) {
      const account = navSections(role, ANONYMOUS_VIEWER).find((s) => s.label === 'Mi cuenta');
      expect(
        account?.items.map((i) => [i.label, i.href]),
        String(role),
      ).toEqual([
        ['Perfil', '/configuracion/perfil'],
        ['Seguridad', '/configuracion/seguridad'],
      ]);
    }
  });

  it('un admin de agencia ve Administración', () => {
    expect(labels('agency_admin')).toEqual([
      'Operaciones',
      'Gestión',
      'Administración',
      'Mi cuenta',
    ]);
  });

  it('el superadmin: Plataforma después de Operaciones, sin Gestión ni las pantallas de venta', () => {
    const sections = navSections('superadmin', { platformUser: true, superadmin: true });
    // Gestión mostraría los datos del tenant de la plataforma, que no vende.
    expect(sections.map((s) => s.label)).toEqual([
      'Operaciones',
      'Plataforma',
      'Administración',
      'Mi cuenta',
    ]);
    const operations = sections.find((s) => s.label === 'Operaciones')?.items.map((i) => i.href);
    expect(operations).not.toContain('/hoteles');
    // El tenant de la plataforma no tiene reservas: las de la red van en Plataforma → Reservas.
    expect(operations).not.toContain('/reservas');
    expect(operations).toContain('/');
  });

  it('un superadmin que opera una sucursal como vendedor sí ve Mis Reservas', () => {
    const sections = navSections('vendedor', { platformUser: true, superadmin: true });
    const operations = sections.find((s) => s.label === 'Operaciones')?.items.map((i) => i.href);
    expect(operations).toContain('/reservas');
    expect(sections.map((s) => s.label)).not.toContain('Plataforma');
  });

  it('Plataforma: Resumen, Agencias, Reservas, Carteras, Proveedores, Usuarios, Actividad y Sistema', () => {
    const sections = navSections('superadmin', { platformUser: true, superadmin: true });
    const platform = sections.find((s) => s.label === 'Plataforma')?.items ?? [];
    expect(platform.map((i) => [i.label, i.href])).toEqual([
      ['Resumen', '/admin/plataforma/resumen'],
      ['Agencias', '/admin/tenants'],
      ['Reservas', '/admin/plataforma/reservas'],
      ['Carteras', '/admin/plataforma/carteras'],
      ['Proveedores', '/admin/plataforma/proveedores'],
      ['Usuarios', '/admin/plataforma/usuarios'],
      ['Actividad', '/admin/plataforma/actividad'],
      ['Sistema', '/admin/plataforma/sistema'],
    ]);
  });

  it('en la paleta del superadmin, "actividad" lleva a la de toda la plataforma', () => {
    const items = commandItems({
      canSwitch: false,
      currentAgencyName: null,
      sections: navSections('superadmin', { platformUser: true, superadmin: true }),
    });
    expect(filterCommands(items, 'actividad')).toEqual([
      expect.objectContaining({ label: 'Actividad', href: '/admin/plataforma/actividad' }),
    ]);
  });

  it('en la paleta del superadmin, "sistema" lleva a Sistema', () => {
    const items = commandItems({
      canSwitch: false,
      currentAgencyName: null,
      sections: navSections('superadmin', { platformUser: true, superadmin: true }),
    });
    expect(filterCommands(items, 'sistema')).toEqual([
      expect.objectContaining({ label: 'Sistema', href: '/admin/plataforma/sistema' }),
    ]);
  });

  it('en la paleta del superadmin, "reservas" lleva a las de la red y no a Mis Reservas', () => {
    const items = commandItems({
      canSwitch: false,
      currentAgencyName: null,
      sections: navSections('superadmin', { platformUser: true, superadmin: true }),
    });
    expect(filterCommands(items, 'reservas')).toEqual([
      expect.objectContaining({ label: 'Reservas', href: '/admin/plataforma/reservas' }),
    ]);
  });

  it('un platform_admin (retirado) no ve Plataforma: sus pantallas son del superadmin', () => {
    expect(labels('platform_admin', true)).not.toContain('Plataforma');
    expect(labels('platform_admin', true)).toContain('Gestión');
  });
});
