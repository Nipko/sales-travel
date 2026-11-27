import { redirect } from 'next/navigation';
import { parseMemberships, resolveActiveMembership } from '../../../../lib/agencies';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';
import { viewerOf } from '../../../../lib/viewer';

/**
 * Agencias es de la persona superadmin, esté en el nodo que esté, igual que `/admin/plataforma`
 * (QA-H-22): antes miraba el rol del nodo activo y a un superadmin parado en una agencia lo devolvía
 * al inicio. La que manda es la guarda del API (`SuperadminGuard`).
 */
export default async function TenantsAdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<unknown>('/me/memberships');
  const memberships = res.ok ? parseMemberships(res.data) : [];

  const activeMembership = resolveActiveMembership(memberships, activeTenantId);

  if (!activeMembership || !viewerOf(memberships).superadmin) {
    redirect('/');
  }

  return <>{children}</>;
}
