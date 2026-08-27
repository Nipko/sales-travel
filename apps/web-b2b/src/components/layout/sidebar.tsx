'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  accountNav,
  adminNav,
  managementNav,
  operationsNav,
  superAdminNav,
  type NavItem,
} from '../../lib/nav';
import { cn } from '../../lib/cn';
import { BrandMark } from './brand-mark';

interface SidebarProps {
  role?: string;
  tenantName?: string;
  /** Identificador del tenant. Se muestra bajo el nombre: es dato real, no una etiqueta fija. */
  tenantSlug?: string;
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

/**
 * Contenido del sidebar, sin el contenedor.
 *
 * Se comparte entre el `<aside>` de escritorio y el drawer móvil, para que la navegación
 * no se duplique y no se desincronice. Bajo 1024px el aside está oculto y, hasta ahora,
 * no había ninguna alternativa: la app se quedaba sin navegación.
 */
export function SidebarContent({ role, tenantName, tenantSlug, logoUrl }: SidebarProps) {
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
    <>
      {/* Marca de la agencia. Es el enlace al inicio: el gesto que todo el mundo intenta. */}
      <Link
        href="/"
        aria-label={`${tenantName ?? 'Sales-Travel'} — ir al inicio`}
        aria-current={isActive('/') ? 'page' : undefined}
        className={cn(
          'group flex h-[4.5rem] items-center gap-3 border-b border-slate-800/60 px-4',
          'transition-colors duration-200 hover:bg-white/[0.04]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]',
        )}
      >
        <BrandMark
          tenantName={tenantName}
          logoUrl={logoUrl}
          size="lg"
          tone="onDark"
          className="transition-transform duration-200 group-hover:scale-[1.03]"
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-bold leading-tight tracking-tight text-white">
            {tenantName ?? 'Sales-Travel'}
          </span>
          {/* El identificador REAL del tenant, no una etiqueta fija igual para toda la red. */}
          <span className="mt-1 truncate text-[10px] font-semibold uppercase leading-none tracking-wider text-slate-500">
            {tenantSlug ?? 'Agencia B2B'}
          </span>
        </span>
      </Link>

      {/* Navigation Links */}
      <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3.5 py-6">
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
    </>
  );
}

/** Sidebar fijo de escritorio. En móvil se usa MobileNav con el mismo contenido. */
export function Sidebar(props: SidebarProps) {
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-slate-800/60 bg-[var(--color-navy-dark)] text-slate-300">
      <SidebarContent {...props} />
    </aside>
  );
}
