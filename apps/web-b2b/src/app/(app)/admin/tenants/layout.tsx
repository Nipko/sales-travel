import { redirect } from 'next/navigation';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';

interface Membership {
  id: string;
  role: string;
  status: string;
  tenantId: string;
}

export default async function TenantsAdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<Membership[]>('/me/memberships');
  const memberships = res.ok ? res.data : [];

  const activeMembership = memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0];

  if (!activeMembership || activeMembership.role !== 'superadmin') {
    redirect('/');
  }

  return <>{children}</>;
}
