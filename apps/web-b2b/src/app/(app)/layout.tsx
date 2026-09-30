import { redirect } from 'next/navigation';
import { Toaster } from 'sonner';
import { agencyOptions, parseMemberships, resolveActiveMembership } from '../../lib/agencies';
import { api } from '../../lib/api';
import { getActiveTenant, getRequestedPath } from '../../lib/session';
import { viewerOf } from '../../lib/viewer';
import { AppShell, BrandStyle } from '../../components/layout/app-shell';
import { SalesGate } from '../../components/layout/sales-gate';
import { SessionGuard } from '../../components/layout/session-guard';
import { decideLayoutGate } from '../../components/layout/session-gate';
import { parseSessionSnapshot, sessionEndPath } from '../../components/layout/session-guard-state';
import { VerifyBanner } from '../../components/layout/verify-banner';
import { MfaEnrollmentGate } from './configuracion/seguridad/_components/mfa-enrollment-gate';

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
  // `/auth/session` y `/auth/mfa` además de lo de siempre: el primero da a la guardia de sesión la
  // inactividad y el vencimiento sin esperar al primer ping, y el segundo dice si hay que enrolar
  // el 2FA. Las cuatro están exentas del chequeo de 2FA en el API, justamente para poder decidir.
  const [meRes, membershipsRes, sessionRes, mfaRes] = await Promise.all([
    api<MeResponse>('/me'),
    api<unknown>('/me/memberships'),
    api<unknown>('/auth/session'),
    api<unknown>('/auth/mfa'),
  ]);

  const gate = decideLayoutGate({
    session: sessionRes,
    me: meRes,
    memberships: membershipsRes,
    mfa: mfaRes,
  });
  // Un Server Component no puede borrar cookies: `/api/session/end` las borra y manda al login con
  // el motivo y la pantalla pedida (la deja el middleware en `x-st-path`), para volver a ella
  // después de entrar: un link profundo con la cookie vigente pero la sesión ya cerrada en el API
  // (inactividad, otro dispositivo) no puede terminar en `/`. `redirect` lanza, así que no puede
  // quedar dentro de un try/catch.
  if (gate.kind === 'end') redirect(sessionEndPath(gate.motivo, await getRequestedPath()));

  const memberships = membershipsRes.ok ? parseMemberships(membershipsRes.data) : [];
  const session = sessionRes.ok ? parseSessionSnapshot(sessionRes.data) : null;

  // La cookie la alinea el middleware con el `tid` de la sesión; si no calza con ninguna
  // membership activa, la por defecto de la API (el mismo criterio del login). Acá no se escribe
  // la cookie: un Server Component no puede, y antes lo intentaba.
  const activeTenant = resolveActiveMembership(memberships, await getActiveTenant());
  const activeTenantId = activeTenant?.tenantId;

  let branding: TenantBranding | undefined;
  if (activeTenantId) {
    const brandingRes = await api<TenantBranding>(`/tenants/${activeTenantId}/branding`).catch(
      () => null,
    );
    if (brandingRes?.ok) branding = brandingRes.data;
  }

  const userEmail = meRes.ok ? meRes.data.email : undefined;

  if (gate.kind === 'mfa-enrollment') {
    // Pantalla completa, sin sidebar ni topbar: el rol exige 2FA y el API rechaza todo lo demás
    // hasta que lo active. La única salida es "Cerrar sesión", dentro del propio gate.
    return (
      <>
        <BrandStyle branding={branding} />
        <MfaEnrollmentGate email={userEmail} tenantName={activeTenant?.tenantName} />
        {/* `mfaEnrollmentGate`: acá que falte el 2FA es lo esperado; en el panel, la guardia
            recarga para llegar a esta pantalla si el rol pasa a exigirlo en plena sesión. */}
        <SessionGuard initial={session} mfaEnrollmentGate />
        <Toaster richColors closeButton position="top-right" />
      </>
    );
  }

  const showVerifyBanner = meRes.ok ? meRes.data.emailVerified === false : false;
  // El superadmin es una identidad del usuario, no del tenant activo: se mira en todas sus
  // memberships, como hace la API al rechazar una venta.
  const viewer = viewerOf(memberships);
  const agencies = agencyOptions(memberships, activeTenantId);

  return (
    <AppShell
      userEmail={userEmail}
      tenantName={activeTenant?.tenantName}
      tenantSlug={activeTenant?.tenantSlug}
      role={activeTenant?.role}
      branding={branding}
      viewer={viewer}
      session={session}
      agencies={agencies}
    >
      {showVerifyBanner && <VerifyBanner />}
      <SalesGate>{children}</SalesGate>
      <Toaster richColors closeButton position="top-right" />
    </AppShell>
  );
}
