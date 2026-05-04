import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

interface AppShellProps {
  children: React.ReactNode;
  userEmail?: string;
  tenantName?: string;
  tenantSlug?: string;
}

export function AppShell({ children, userEmail, tenantName, tenantSlug }: AppShellProps) {
  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar userEmail={userEmail} tenantName={tenantName} tenantSlug={tenantSlug} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
