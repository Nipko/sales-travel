import type { Role } from '../database/database.types.js';

/**
 * Fuente ÚNICA de verdad sobre roles.
 *
 * Antes de este módulo, las listas de roles estaban duplicadas y divergentes en cinco
 * lugares (admin.controller, network.service, is_admin_user() en SQL, can_read_membership()
 * en SQL y la UI). La divergencia ya había dejado a `platform_admin` fuera de
 * NetworkService.canManageTenant. Cualquier rol nuevo se agrega ACÁ y en la migración
 * correspondiente, en ningún otro lado.
 */

/** Roles con alcance global, independientes del nodo donde cuelgue la membership. */
export const PLATFORM_ROLES = ['superadmin', 'platform_admin'] as const satisfies readonly Role[];

/**
 * Roles que un admin puede asignar por API.
 *
 * Excluye PLATFORM_ROLES a propósito: NetworkService.isSuperadmin() busca el rol
 * superadmin en CUALQUIER nodo, así que poder asignarlo desde un endpoint de red
 * equivale a escalada global. Sólo se conceden por migración/operación manual, y
 * 0025_role_escalation_guard.sql lo refuerza a nivel base de datos.
 *
 * `platform_admin` además está retirado (D7 B): sigue en el tipo `Role` y en la base porque
 * puede haber memberships viejas, pero ni la API ni la web lo asignan.
 */
export const ASSIGNABLE_ROLES = [
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
  'vendedor',
  'cliente_final',
] as const satisfies readonly Role[];

/** Roles que administran su nodo (y su subárbol). Espejo de is_admin_user() en SQL. */
export const ADMIN_ROLES = [
  'superadmin',
  'platform_admin',
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
] as const satisfies readonly Role[];

/**
 * Administradores de un nodo de la red (sin los roles globales de plataforma, que
 * RolesGuard deja pasar salvo en las operaciones de venta). Es el grupo que gobierna
 * configuración sensible: markup, credenciales BYOC, límites de crédito y movimientos de cartera.
 */
export const AGENCY_ADMIN_ROLES = [
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
] as const satisfies readonly Role[];

/**
 * Quienes operan comercialmente: los admins de nodo más el vendedor. Cubre cotizar,
 * reservar y gestionar clientes. Excluye a `cliente_final`, que no debe alcanzar
 * ningún endpoint de gestión.
 *
 * Excluye también PLATFORM_ROLES, y en las rutas `@SalesOperation()` RolesGuard la aplica sin
 * el pase libre de la plataforma: el superadmin cuadra la red pero no vende. Planetour vende por
 * sus sucursales, con usuarios de esas sucursales.
 */
export const SELLING_ROLES = [...AGENCY_ADMIN_ROLES, 'vendedor'] as const satisfies readonly Role[];

type MustBeEmpty<T extends never> = T;

/**
 * Siempre `never`. Deja de compilar si alguien suma un rol de plataforma a SELLING_ROLES: sería
 * devolverle al superadmin la venta por la puerta de atrás.
 */
export type PlatformRoleThatSells = MustBeEmpty<
  Extract<(typeof SELLING_ROLES)[number], (typeof PLATFORM_ROLES)[number]>
>;

/**
 * Jerarquía de privilegio. Se usa para impedir que un admin asigne un rol igual o
 * superior al propio (auto-promoción) o degrade a alguien por encima suyo.
 */
export const ROLE_RANK: Record<Role, number> = {
  superadmin: 100,
  platform_admin: 90,
  consolidator_admin: 70,
  tenant_admin: 60,
  agency_admin: 50,
  admin: 40,
  vendedor: 20,
  cliente_final: 10,
};

export function isPlatformRole(role: Role): boolean {
  return (PLATFORM_ROLES as readonly Role[]).includes(role);
}

export function isAdminRole(role: Role): boolean {
  return (ADMIN_ROLES as readonly Role[]).includes(role);
}

/** ¿Puede operar una ruta de venta? Nunca un rol de plataforma. */
export function canSell(role: Role): boolean {
  return (SELLING_ROLES as readonly Role[]).includes(role);
}

/** ¿`actor` puede otorgar/quitar el rol `target`? Sólo roles estrictamente por debajo suyo. */
export function canGrantRole(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/** ¿Se puede asignar por API? Para lo que no pasa por Zod, como una invitación ya guardada. */
export function isAssignableRole(role: Role): boolean {
  return (ASSIGNABLE_ROLES as readonly Role[]).includes(role);
}

/** El de más rango, o `undefined` si no hay ninguno. */
export function highestRole(roles: readonly Role[]): Role | undefined {
  return roles.reduce<Role | undefined>(
    (best, role) => (best === undefined || ROLE_RANK[role] > ROLE_RANK[best] ? role : best),
    undefined,
  );
}

/** Roles a los que se les exige MFA. Requisito no negociable de CLAUDE.md. */
export const MFA_REQUIRED_ROLES = [
  'superadmin',
  'platform_admin',
  'consolidator_admin',
  'tenant_admin',
] as const satisfies readonly Role[];

export function requiresMfa(role: Role): boolean {
  return (MFA_REQUIRED_ROLES as readonly Role[]).includes(role);
}
