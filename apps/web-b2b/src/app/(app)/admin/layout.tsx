import { redirect } from 'next/navigation';
import { parseMemberships, resolveActiveMembership } from '../../../lib/agencies';
import { api } from '../../../lib/api';
import { isAdminRole } from '../../../lib/roles';
import { getActiveTenant } from '../../../lib/session';
import { viewerOf } from '../../../lib/viewer';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<unknown>('/me/memberships');
  const memberships = res.ok ? parseMemberships(res.data) : [];

  const activeMembership = resolveActiveMembership(memberships, activeTenantId);

  if (!activeMembership) {
    redirect('/');
  }

  // Administración: un rol que administra en el nodo activo (lib/roles.ts, espejo del API); o la
  // persona superadmin, que entra a la consola de la plataforma desde cualquier nodo (H12).
  if (!isAdminRole(activeMembership.role) && !viewerOf(memberships).superadmin) {
    redirect('/');
  }

  return <>{children}</>;
}
