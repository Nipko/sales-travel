'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, Search, User } from 'lucide-react';
import { logoutAction } from '../../app/login/actions';
import { cn } from '../../lib/cn';

interface TopbarProps {
  userEmail?: string;
  tenantName?: string;
  tenantSlug?: string;
}

export function Topbar({ userEmail, tenantName, tenantSlug }: TopbarProps) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 lg:px-8">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              tenantName ? 'bg-[var(--color-success)]' : 'bg-[var(--color-fg-subtle)]',
            )}
          />
          <span className="font-medium text-[var(--color-fg)]">{tenantName ?? 'Sin tenant'}</span>
          {tenantSlug ? (
            <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
              {tenantSlug}
            </span>
          ) : null}
          <ChevronDown className="size-3 text-[var(--color-fg-subtle)]" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="hidden md:flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <Search className="size-3.5" />
          <span>Buscar...</span>
          <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
            ⌘K
          </kbd>
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
                <User className="size-3.5" />
              </span>
              <span className="hidden md:inline text-xs text-[var(--color-fg-muted)]">
                {userEmail ?? 'usuario'}
              </span>
              <ChevronDown className="size-3 text-[var(--color-fg-subtle)]" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-[200px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-md)]"
            >
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Sesión
              </div>
              <div className="px-2 pb-2 text-xs text-[var(--color-fg-muted)]">{userEmail}</div>
              <div className="my-1 h-px bg-[var(--color-border)]" />
              <DropdownMenu.Item asChild>
                <form action={logoutAction}>
                  <button
                    type="submit"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-[var(--color-fg)] outline-none hover:bg-[var(--color-surface-muted)]"
                  >
                    <LogOut className="size-3.5 text-[var(--color-fg-muted)]" />
                    <span>Cerrar sesión</span>
                  </button>
                </form>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
