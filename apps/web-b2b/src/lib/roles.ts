/**
 * Los roles en la web: espejo de apps/api/src/auth/roles.ts, la fuente de verdad. Un test
 * (roles.test.ts) compara las listas con las del API. Lo que la web muestra u oculta es una guía:
 * quién puede qué lo decide el API en cada llamada. Sin I/O.
 *
 * Antes cada pantalla tenía su copia (layout de Administración, menú, equipo, carteras, inicio) y ya
 * diferían (docs/platform/16, H8).
 */

/** Roles con alcance global. `platform_admin` está retirado: desde 0093 no queda activo en nadie. */
export const PLATFORM_ROLES: readonly string[] = ['superadmin', 'platform_admin'];

/** Los que administran su nodo y su subárbol (ADMIN_ROLES del API). */
export const ADMIN_ROLES: readonly string[] = [
  'superadmin',
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
];

/** Los administradores de un nodo, sin la plataforma (AGENCY_ADMIN_ROLES del API). */
export const AGENCY_ADMIN_ROLES: readonly string[] = [
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
];

/** ROLE_RANK del API. */
export const ROLE_RANK: Readonly<Record<string, number>> = {
  superadmin: 100,
  platform_admin: 90,
  consolidator_admin: 70,
  tenant_admin: 60,
  agency_admin: 50,
  admin: 40,
  vendedor: 20,
  cliente_final: 10,
};

/** MFA_REQUIRED_ROLES del API: desde el 2026-11-05, todo rol que administra (H6). */
export const MFA_REQUIRED_ROLES: readonly string[] = [
  'superadmin',
  'platform_admin',
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
];

export function isAdminRole(role: string | undefined): boolean {
  return role !== undefined && ADMIN_ROLES.includes(role);
}
