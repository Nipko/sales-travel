import { redirect } from 'next/navigation';
import { parseMemberships, resolveActiveMembership } from '../../../../lib/agencies';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';

export default async function TenantsAdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<unknown>('/me/memberships');
  const memberships = res.ok ? parseMemberships(res.data) : [];

  const activeMembership = resolveActiveMembership(memberships, activeTenantId);

  if (!activeMembership || activeMembership.role !== 'superadmin') {
    redirect('/');
  }

  return <>{children}</>;
}
