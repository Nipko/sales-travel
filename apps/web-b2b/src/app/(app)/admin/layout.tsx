import { redirect } from 'next/navigation';
import { parseMemberships, resolveActiveMembership } from '../../../lib/agencies';
import { api } from '../../../lib/api';
import { getActiveTenant } from '../../../lib/session';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<unknown>('/me/memberships');
  const memberships = res.ok ? parseMemberships(res.data) : [];

  const activeMembership = resolveActiveMembership(memberships, activeTenantId);

  if (!activeMembership) {
    redirect('/');
  }

  // Admin section requires at least admin-level role
  const allowedAdminRoles = [
    'superadmin',
    'platform_admin',
    'consolidator_admin',
    'tenant_admin',
    'agency_admin',
    'admin',
  ];
  if (!allowedAdminRoles.includes(activeMembership.role)) {
    redirect('/');
  }

  return <>{children}</>;
}
