import { redirect } from 'next/navigation';
import { parseMemberships, resolveActiveMembership } from '../../../../lib/agencies';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';

/**
 * El panel de la plataforma es sólo del superadmin, como `/admin/tenants`. Es la guarda de la
 * pantalla; la que manda es la del API (`/admin/providers` exige superadmin en cada llamada).
 */
export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const activeTenantId = await getActiveTenant();
  const res = await api<unknown>('/me/memberships');
  const memberships = res.ok ? parseMemberships(res.data) : [];

  const activeMembership = resolveActiveMembership(memberships, activeTenantId);

  if (!activeMembership || activeMembership.role !== 'superadmin') {
    redirect('/');
  }

  return <>{children}</>;
}
