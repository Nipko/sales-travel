import { pickDefaultMembership } from '../auth/default-tenant.js';

/**
 * Por qué no se puede operar con una agencia en la que el usuario tiene membership activa. El panel
 * la muestra deshabilitada en el selector con este motivo, en vez de esconderla: quien la conoce
 * tiene que saber por qué no aparece como opción.
 *
 * - `tenant_suspended` / `tenant_archived`: el propio nodo.
 * - `ancestor_suspended`: un nodo de arriba (el consolidador, la agencia madre) no está activo, y
 *   suspender un nodo corta a toda su red (SessionService.validate).
 */
export type UnavailableReason = 'tenant_suspended' | 'tenant_archived' | 'ancestor_suspended';

/** Una fila de GET /me/memberships antes de armar la vista. */
export interface MembershipRow {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
  tenantType: string;
  logoUrl: string | null;
  createdAt: Date;
  /** El nodo más alto de la cadena que no está activo (puede ser el propio). */
  blockerId: string | null;
  blockerName: string | null;
}

export interface MembershipView {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantType: string;
  /** Logo efectivo (heredado por la jerarquía, 0030). */
  logoUrl: string | null;
  /** Se puede operar con esta agencia: membership activa y el nodo y sus ancestros activos. */
  operable: boolean;
  unavailableReason: UnavailableReason | null;
  /** El nodo que la bloquea, si es un ancestro: "Viajes Andinos está suspendida". */
  blockedByName: string | null;
  /** La agencia con la que se abre el próximo login (el mismo criterio que usa la API). */
  isDefault: boolean;
}

function unavailableReasonOf(row: MembershipRow): UnavailableReason | null {
  if (row.blockerId === null) return null;
  if (row.blockerId !== row.tenantId) return 'ancestor_suspended';
  return row.tenantStatus === 'archived' ? 'tenant_archived' : 'tenant_suspended';
}

/**
 * Arma la vista de cada membership y marca la agencia por defecto con {@link pickDefaultMembership},
 * que decide entre las ACTIVAS de la más antigua a la más nueva, igual que el login. Conserva el
 * orden de entrada (alfabético, para mostrar).
 */
export function toMembershipViews(
  rows: readonly MembershipRow[],
  lastTenantId: string | null,
): MembershipView[] {
  const candidates = rows
    .filter((r) => r.status === 'active')
    .map((r) => ({ tenantId: r.tenantId, operable: r.blockerId === null, createdAt: r.createdAt }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const defaultTenantId = pickDefaultMembership(candidates, { last: lastTenantId })?.tenantId;

  return rows.map((row) => {
    const reason = unavailableReasonOf(row);
    return {
      id: row.id,
      role: row.role,
      status: row.status,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      tenantName: row.tenantName,
      tenantType: row.tenantType,
      logoUrl: row.logoUrl,
      operable: row.status === 'active' && reason === null,
      unavailableReason: reason,
      blockedByName: reason === 'ancestor_suspended' ? row.blockerName : null,
      isDefault: row.status === 'active' && row.tenantId === defaultTenantId,
    };
  });
}
