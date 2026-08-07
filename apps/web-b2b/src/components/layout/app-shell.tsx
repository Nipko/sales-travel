import { brandStyleSheet } from '../../lib/brand-tokens';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

interface TenantBranding {
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

interface AppShellProps {
  children: React.ReactNode;
  userEmail?: string;
  tenantName?: string;
  tenantSlug?: string;
  role?: string;
  branding?: TenantBranding;
}

export function AppShell({
  children,
  userEmail,
  tenantName,
  tenantSlug,
  role,
  branding,
}: AppShellProps) {
  // Hoja de estilo con alcance :root en vez de un style inline en este div. Dos razones:
  // los Portals de React (toasts, diálogos) se montan fuera de este árbol y con el style
  // inline se quedaban con los colores de la plataforma; y así se derivan hover y
  // foreground del color elegido en lugar de repetir el mismo hex (ver brand-tokens.ts).
  const brandCss = brandStyleSheet(branding?.primaryColor, branding?.accentColor);

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      {brandCss ? <style dangerouslySetInnerHTML={{ __html: brandCss }} /> : null}
      <Sidebar role={role} tenantName={tenantName} logoUrl={branding?.logoUrl ?? undefined} />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar
          userEmail={userEmail}
          tenantName={tenantName}
          tenantSlug={tenantSlug}
          logoUrl={branding?.logoUrl ?? undefined}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
