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

/** ¿`actor` puede otorgar/quitar el rol `target`? Sólo roles estrictamente por debajo suyo. */
export function canGrantRole(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
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
