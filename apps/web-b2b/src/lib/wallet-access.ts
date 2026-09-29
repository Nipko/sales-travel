import type { NetworkNode } from './tenant-network';

/**
 * Quién gestiona las carteras de qué nodo, para ofrecer la acción sólo donde el API la va a
 * aceptar. Espejo de `tenant_financier_id` y `can_finance_tenant` (db/migrations/0052): la base
 * decide en cada escritura, esto sólo evita mostrar un botón que terminaría en 403.
 *
 * Decisión del founder del 2026-09-29 (opción A): la cartera de cada nodo la establece quien lo
 * financia, su ancestro más cercano de tipo plataforma, consolidador o agencia. Lo que cuelga de
 * Planetour lo financia su superadmin; nadie gestiona su propia cartera.
 */

type Node = Pick<NetworkNode, 'id' | 'tenantType' | 'parentTenantId' | 'status'>;

const FINANCIER_TYPES: readonly string[] = ['platform', 'consolidator', 'agency'];

/**
 * Quien financia a `node` entre los nodos visibles: su ancestro más cercano que financia.
 * `undefined` para la raíz, para un nodo suelto o si el ancestro no está a la vista.
 */
export function walletFinancierOf<T extends Node>(nodes: readonly T[], node: Node): T | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const seen = new Set<string>([node.id]);
  let parentId = node.parentTenantId;
  while (parentId !== null) {
    if (seen.has(parentId)) return undefined;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) return undefined;
    if (FINANCIER_TYPES.includes(parent.tenantType)) return parent;
    parentId = parent.parentTenantId;
  }
  return undefined;
}

/**
 * ¿Ofrecer "Carteras" para `node` en Mi Red?
 *
 * - El superadmin, en cualquier nodo (la raíz incluida).
 * - Un admin, en los nodos que financia un nodo que él administra y que no es la plataforma. Mi Red
 *   lista el subárbol de los nodos donde el usuario es admin, así que las raíces de lo visible son
 *   nodos que administra; se ofrece cuando quien financia es una de ellas, activa como todo el
 *   camino hasta ella (la base no deja operar a un financiador suspendido).
 */
export function canManageWalletsFromNetwork(
  nodes: readonly Node[],
  node: Node,
  viewer: { readonly superadmin: boolean },
): boolean {
  if (viewer.superadmin) return true;
  const financier = walletFinancierOf(nodes, node);
  if (financier === undefined || financier.tenantType === 'platform') return false;
  if (financier.status !== 'active') return false;
  const visible = new Set(nodes.map((n) => n.id));
  const isRoot = financier.parentTenantId === null || !visible.has(financier.parentTenantId);
  return isRoot;
}

/**
 * Los admins con membership en la agencia activa (espejo de `assertAdminMembership` del API): son
 * los que informan un depósito en Cartera B2B y los que cancelan y liberan una reserva retenida. El
 * vendedor ve las carteras y sus movimientos, pero no hace ninguna de las dos cosas.
 */
const AGENCY_WALLET_ADMIN_ROLES: readonly string[] = [
  'superadmin',
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
];

export function canReportDeposits(role: string | undefined): boolean {
  return role !== undefined && AGENCY_WALLET_ADMIN_ROLES.includes(role);
}

export function canReleaseHolds(role: string | undefined): boolean {
  return canReportDeposits(role);
}
