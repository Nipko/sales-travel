'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, Search, User, Globe } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { MobileNav } from './mobile-nav';

interface TopbarProps {
  userEmail?: string;
  tenantName?: string;
  tenantSlug?: string;
  logoUrl?: string;
  role?: string;
}

export function Topbar({ userEmail, tenantName, tenantSlug, logoUrl, role }: TopbarProps) {
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[var(--color-border)]/50 bg-[var(--color-surface)]/80 px-6 backdrop-blur-md transition-all">
      {/* Left side: Active Agency Indicator */}
      <div className="flex items-center gap-3">
        <MobileNav role={role} tenantName={tenantName} logoUrl={logoUrl} />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-fg-muted)] shadow-[var(--shadow-xs)] transition-all duration-200 hover:bg-[var(--color-surface-muted)] hover:border-[var(--color-border-strong)] active:scale-[0.98] cursor-pointer"
            >
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt=""
                  className="size-7 rounded-md object-contain bg-white/5 border border-[var(--color-border)]"
                />
              ) : (
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-primary)] opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-[var(--color-primary)]" />
                </span>
              )}
              <span className="font-semibold text-[var(--color-fg)] group-hover:text-[var(--color-primary)] transition-colors">
                {tenantName ?? 'Sin tenant'}
              </span>
              {tenantSlug ? (
                <span className="hidden sm:inline font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-subtle)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                  {tenantSlug}
                </span>
              ) : null}
              <ChevronDown className="size-3 text-[var(--color-fg-subtle)] transition-transform duration-200 group-hover:translate-y-0.5" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-[220px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)] animate-fade-in-up"
            >
              <div className="px-2.5 py-2 text-[9px] font-bold uppercase tracking-widest text-[var(--color-fg-subtle)]">
                Agencia Activa
              </div>
              <div className="flex items-center gap-2.5 rounded-lg bg-[var(--color-surface-muted)] p-2.5 mb-1.5">
                <div className="flex size-7 items-center justify-center rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
                  <Globe className="size-4" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold text-[var(--color-fg)] truncate leading-tight">
                    {tenantName ?? 'Sin Agencia'}
                  </span>
                  <span className="text-[10px] text-[var(--color-fg-subtle)] truncate mt-0.5 font-mono">
                    {tenantSlug ?? '-'}
                  </span>
                </div>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* Right side: Search & User Controls */}
      <div className="flex items-center gap-3">
        {/* Comando de Búsqueda Rápida */}
        <button
          type="button"
          className="hidden md:flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-1.5 text-xs text-[var(--color-fg-subtle)] shadow-[var(--shadow-xs)] transition-all duration-200 hover:bg-[var(--color-surface-muted)] hover:border-[var(--color-border-strong)] active:scale-[0.98] cursor-pointer"
        >
          <Search className="size-3.5 text-[var(--color-fg-subtle)]" />
          <span className="font-medium">Buscar...</span>
          <kbd className="ml-3 inline-flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[9px] font-bold text-[var(--color-fg-subtle)] shadow-[var(--shadow-xs)]">
            <span>⌘</span>
            <span>K</span>
          </kbd>
        </button>

        {/* Menú del Usuario */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="group flex items-center gap-2 rounded-lg p-1.5 transition-colors hover:bg-[var(--color-surface-muted)] cursor-pointer"
            >
              <span className="flex size-7.5 items-center justify-center rounded-full bg-gradient-to-tr from-[var(--color-primary)]/10 to-[var(--color-accent)]/10 border border-[var(--color-primary)]/15 text-[var(--color-primary)] shadow-sm transition-transform group-hover:scale-105">
                <User className="size-4 shrink-0" />
              </span>
              <span className="hidden md:inline text-xs font-semibold text-[var(--color-fg-muted)] group-hover:text-[var(--color-fg)] transition-colors max-w-[150px] truncate">
                {userEmail ?? 'Usuario'}
              </span>
              <ChevronDown className="size-3 text-[var(--color-fg-subtle)] transition-transform duration-200 group-hover:translate-y-0.5" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-[200px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)] animate-fade-in-up"
            >
              <div className="px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-widest text-[var(--color-fg-subtle)]">
                Sesión Iniciada
              </div>
              <div className="px-2.5 pb-2.5 pt-0.5">
                <p className="truncate text-xs font-semibold text-[var(--color-fg)]">{userEmail}</p>
                <p className="text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider font-semibold mt-0.5">
                  Agente Autorizado
                </p>
              </div>

              <div className="my-1 h-px bg-[var(--color-border)]/60" />

              <DropdownMenu.Item
                onSelect={() => void handleLogout()}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-[var(--color-fg)] outline-none hover:bg-[var(--color-danger)]/[0.06] hover:text-[var(--color-danger)] transition-colors"
              >
                <LogOut className="size-4 text-[var(--color-fg-muted)] group-hover:text-inherit" />
                <span className="font-medium">Cerrar sesión</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
