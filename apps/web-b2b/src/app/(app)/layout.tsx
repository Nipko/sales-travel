import { api } from '../../lib/api';
import { AppShell } from '../../components/layout/app-shell';

interface Membership {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
}

interface MeResponse {
  email?: string;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [meRes, membershipsRes] = await Promise.all([
    api<MeResponse>('/me').catch(() => null),
    api<Membership[]>('/me/memberships'),
  ]);

  const memberships = membershipsRes.ok ? membershipsRes.data : [];
  const activeTenant = memberships[0];

  return (
    <AppShell
      userEmail={meRes?.ok ? meRes.data.email : undefined}
      tenantName={activeTenant?.tenantName}
      tenantSlug={activeTenant?.tenantSlug}
    >
      {children}
    </AppShell>
  );
}
