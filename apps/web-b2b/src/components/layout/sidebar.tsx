'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { mainNav, settingsNav, type NavItem } from '../../lib/nav';
import { cn } from '../../lib/cn';

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

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-5">
        <div className="size-7 rounded-md bg-[var(--color-primary)] flex items-center justify-center">
          <span className="text-[var(--color-primary-fg)] text-xs font-bold tracking-tight">
            ST
          </span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
          Sales-Travel
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Operación
        </p>
        <ul className="space-y-0.5">
          {mainNav.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={isActive(item.href)} />
            </li>
          ))}
        </ul>

        <p className="mt-6 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Sistema
        </p>
        <ul className="space-y-0.5">
          {settingsNav.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={isActive(item.href)} />
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-[var(--color-border)] px-5 py-3">
        <p className="text-[10px] text-[var(--color-fg-subtle)]">v0.1.1 · Sprint 0</p>
      </div>
    </aside>
  );
}
