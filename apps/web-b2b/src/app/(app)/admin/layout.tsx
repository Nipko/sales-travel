import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';
import { getActiveTenant } from '../../../lib/session';

interface Membership {
  id: string;
  role: string;
  status: string;
  tenantId: string;
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<Membership[]>('/me/memberships');
  const memberships = res.ok ? res.data : [];

  const activeMembership = memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0];

  if (!activeMembership) {
    redirect('/');
  }

  // Admin section requires at least 'admin' role
  if (!['superadmin', 'tenant_admin', 'admin'].includes(activeMembership.role)) {
    redirect('/');
  }

  return <>{children}</>;
}
