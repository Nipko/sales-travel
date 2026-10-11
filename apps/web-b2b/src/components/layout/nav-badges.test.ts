import { describe, expect, it } from 'vitest';
import { navSections, superAdminNav } from '../../lib/nav';
import { badgeLabel, badgeText } from './nav-badges';

describe('contadores del menú', () => {
  it('sin pendientes no hay contador; más de 99 se abrevia', () => {
    expect(badgeText(undefined)).toBeUndefined();
    expect(badgeText(0)).toBeUndefined();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(140)).toBe('99+');
  });

  it('el lector de pantalla oye qué cuenta, con el número exacto', () => {
    expect(badgeLabel('pendingDeposits', 1)).toBe('1 depósito por aprobar');
    expect(badgeLabel('pendingDeposits', 140)).toBe('140 depósitos por aprobar');
  });
});

describe('sección Plataforma del menú', () => {
  it('Aprobaciones abre la consola y lleva el contador de depósitos', () => {
    expect(superAdminNav.find((i) => i.label === 'Aprobaciones')).toMatchObject({
      href: '/admin/plataforma/aprobaciones',
      badge: 'pendingDeposits',
    });
  });

  it('sólo con el rol superadmin en la agencia activa, como sus pantallas', () => {
    const viewer = { platformUser: true, superadmin: true };
    expect(navSections('superadmin', viewer).at(-1)?.label).toBe('Plataforma');
    expect(navSections('tenant_admin', viewer).map((s) => s.label)).not.toContain('Plataforma');
  });
});
