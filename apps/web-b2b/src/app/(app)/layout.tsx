import { api } from '../../lib/api';
import { getActiveTenant, setActiveTenant } from '../../lib/session';
import { AppShell } from '../../components/layout/app-shell';
import { VerifyBanner } from '../../components/layout/verify-banner';

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
  emailVerified?: boolean;
}

interface TenantBranding {
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [meRes, membershipsRes] = await Promise.all([
    api<MeResponse>('/me').catch(() => null),
    api<Membership[]>('/me/memberships'),
  ]);

  const memberships = membershipsRes.ok ? membershipsRes.data : [];

  let activeTenantId = await getActiveTenant();
  const activeTenant = activeTenantId
    ? (memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0])
    : memberships[0];

  if (activeTenant && activeTenant.tenantId !== activeTenantId) {
    activeTenantId = activeTenant.tenantId;
    await setActiveTenant(activeTenantId);
  }

  let branding: TenantBranding | undefined;
  if (activeTenantId) {
    const brandingRes = await api<TenantBranding>(`/tenants/${activeTenantId}/branding`).catch(
      () => null,
    );
    if (brandingRes?.ok) branding = brandingRes.data;
  }

  const showVerifyBanner = meRes?.ok ? meRes.data.emailVerified === false : false;

  return (
    <AppShell
      userEmail={meRes?.ok ? meRes.data.email : undefined}
      tenantName={activeTenant?.tenantName}
      tenantSlug={activeTenant?.tenantSlug}
      role={activeTenant?.role}
      branding={branding}
    >
      {showVerifyBanner && <VerifyBanner />}
      {children}
    </AppShell>
  );
}
