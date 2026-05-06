'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNav, managementNav, operationsNav, superAdminNav, type NavItem } from '../../lib/nav';
import { cn } from '../../lib/cn';

interface SidebarProps {
  role?: string;
  tenantName?: string;
  logoUrl?: string;
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        'group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] font-medium'
          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]',
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0',
          active
            ? 'text-[var(--color-primary)]'
            : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]',
        )}
      />
      <span>{item.label}</span>
    </Link>
  );
}

export function Sidebar({ role, tenantName, logoUrl }: SidebarProps) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  
  const isSuperAdmin = role === 'superadmin';
  const isAdmin = role === 'superadmin' || role === 'tenant_admin' || role === 'admin';

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex h-14 items-center gap-2.5 border-b border-[var(--color-border)] px-5">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="size-7 rounded-md object-contain" />
        ) : (
          <div className="size-7 rounded-md bg-[var(--color-primary)] flex items-center justify-center">
            <span className="text-[var(--color-primary-fg)] text-xs font-bold tracking-tight">
              {tenantName ? tenantName.slice(0, 2).toUpperCase() : 'ST'}
            </span>
          </div>
        )}
        <span className="text-sm font-semibold tracking-tight text-[var(--color-fg)] truncate">
          {tenantName ?? 'Sales-Travel'}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {/* OPERACIONES DIARIAS */}
        <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Operaciones
        </p>
        <ul className="space-y-0.5">
          {operationsNav.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={isActive(item.href)} />
            </li>
          ))}
        </ul>

        {/* GESTIÓN */}
        <p className="mt-6 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Gestión
        </p>
        <ul className="space-y-0.5">
          {managementNav.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={isActive(item.href)} />
            </li>
          ))}
        </ul>

        {/* ADMINISTRACIÓN (Solo admins de agencia y superadmins) */}
        {isAdmin && (
          <>
            <p className="mt-6 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Administración
            </p>
            <ul className="space-y-0.5">
              {adminNav.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={isActive(item.href)} />
                </li>
              ))}
            </ul>
          </>
        )}

        {/* AGENCIAS (Solo superadmins) */}
        {isSuperAdmin && (
          <>
            <p className="mt-6 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Super Admin
            </p>
            <ul className="space-y-0.5">
              {superAdminNav.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={isActive(item.href)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      <div className="border-t border-[var(--color-border)] px-5 py-3">
        <p className="text-[10px] text-[var(--color-fg-subtle)]">v0.2.0 · B2B Agent</p>
      </div>
    </aside>
  );
}
