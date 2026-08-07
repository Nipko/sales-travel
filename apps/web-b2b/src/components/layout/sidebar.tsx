'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass } from 'lucide-react';
import {
  accountNav,
  adminNav,
  managementNav,
  operationsNav,
  superAdminNav,
  type NavItem,
} from '../../lib/nav';
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
        'group relative flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-xs font-medium transition-all duration-200',
        active
          ? 'bg-white/[0.06] text-white font-semibold shadow-sm'
          : 'text-slate-400 hover:text-white hover:bg-white/[0.03]',
      )}
    >
      {/* Active Indicator Bar */}
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-[var(--color-primary)]"
          aria-hidden="true"
        />
      )}

      <Icon
        className={cn(
          'size-4 shrink-0 transition-transform duration-200 group-hover:scale-105',
          active ? 'text-[var(--color-primary)]' : 'text-slate-500 group-hover:text-slate-300',
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
  const isAdmin = [
    'superadmin',
    'platform_admin',
    'consolidator_admin',
    'tenant_admin',
    'agency_admin',
    'admin',
  ].includes(role ?? '');

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-slate-800/60 bg-[var(--color-navy-dark)] text-slate-300">
      {/* Header / Branding */}
      <div className="flex h-16 items-center gap-3 border-b border-slate-800/60 px-4">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            className="size-11 shrink-0 rounded-lg object-contain bg-white/10 p-1 border border-white/10"
          />
        ) : (
          <div className="size-11 shrink-0 rounded-lg bg-[var(--color-primary)] flex items-center justify-center shadow-md">
            <Compass className="size-6 text-white animate-spin-slow" />
          </div>
        )}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold tracking-tight text-white truncate leading-tight">
            {tenantName ?? 'Sales-Travel'}
          </span>
          <span className="text-[10px] text-slate-500 leading-none mt-0.5 font-medium uppercase tracking-wider">
            Agencia B2B
          </span>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 overflow-y-auto px-3.5 py-6 space-y-6">
        {/* OPERACIONES DIARIAS */}
        <div className="space-y-1.5">
          <p className="px-3.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
            Operaciones
          </p>
          <ul className="space-y-1">
            {operationsNav.map((item) => (
              <li key={item.href}>
                <NavLink item={item} active={isActive(item.href)} />
              </li>
            ))}
          </ul>
        </div>

        {/* GESTIÓN */}
        <div className="space-y-1.5">
          <p className="px-3.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
            Gestión
          </p>
          <ul className="space-y-1">
            {managementNav.map((item) => (
              <li key={item.href}>
                <NavLink item={item} active={isActive(item.href)} />
              </li>
            ))}
          </ul>
        </div>

        {/* ADMINISTRACIÓN */}
        {isAdmin && (
          <div className="space-y-1.5">
            <p className="px-3.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
              Administración
            </p>
            <ul className="space-y-1">
              {adminNav.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={isActive(item.href)} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* MI CUENTA — visible para todos: la seguridad de la propia cuenta no es admin */}
        <div className="space-y-1.5">
          <p className="px-3.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
            Mi cuenta
          </p>
          <ul className="space-y-1">
            {accountNav.map((item) => (
              <li key={item.href}>
                <NavLink item={item} active={isActive(item.href)} />
              </li>
            ))}
          </ul>
        </div>

        {/* AGENCIAS SUPER ADMIN */}
        {isSuperAdmin && (
          <div className="space-y-1.5">
            <p className="px-3.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
              Super Admin
            </p>
            <ul className="space-y-1">
              {superAdminNav.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={isActive(item.href)} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      {/* Footer info */}
      <div className="border-t border-slate-800/60 px-5 py-3.5 flex items-center justify-between text-[10px] text-slate-500 font-medium">
        <span>Planetour Cloud</span>
        <span className="font-mono text-[9px] text-slate-600">v0.2.0</span>
      </div>
    </aside>
  );
}
