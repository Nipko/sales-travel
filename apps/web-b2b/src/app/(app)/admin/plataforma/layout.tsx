import { redirect } from 'next/navigation';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';

interface Membership {
  id: string;
  role: string;
  status: string;
  tenantId: string;
}

/**
 * El panel de la plataforma es sólo del superadmin, como `/admin/tenants`. Es la guarda de la
 * pantalla; la que manda es la del API (`/admin/providers` exige superadmin en cada llamada).
 */
export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<Membership[]>('/me/memberships');
  const memberships = res.ok ? res.data : [];

  const activeMembership = memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0];

  if (!activeMembership || activeMembership.role !== 'superadmin') {
    redirect('/');
  }

  return <>{children}</>;
}
