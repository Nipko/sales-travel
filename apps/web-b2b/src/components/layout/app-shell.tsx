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
  branding?: TenantBranding;
}

export function AppShell({ children, userEmail, tenantName, tenantSlug, branding }: AppShellProps) {
  const style = branding?.primaryColor
    ? ({
        '--color-primary': branding.primaryColor,
        '--color-primary-hover': branding.primaryColor,
        ...(branding.accentColor ? { '--color-accent': branding.accentColor } : {}),
      } as React.CSSProperties)
    : undefined;

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]" style={style}>
      <Sidebar />
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
