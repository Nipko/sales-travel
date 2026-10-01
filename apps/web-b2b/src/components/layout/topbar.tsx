'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, User } from 'lucide-react';
import { AgencyTrigger, CommandMenuButton } from './agency-switcher';
import { MobileNav } from './mobile-nav';
import { logout } from './session-sync';
import { ThemeToggle } from './theme-toggle';

interface TopbarProps {
  userEmail?: string;
  tenantName?: string;
  tenantSlug?: string;
  logoUrl?: string;
  role?: string;
}

/**
 * El menú del usuario es NO modal (`modal={false}`). Uno modal de Radix, olvidado abierto, atrapaba
 * el foco, dejaba el `<body>` sin clics y ocultaba el resto al lector de pantalla: cuando aparecía
 * el aviso de inactividad, el foco de "Seguir conectado" volvía al menú y el primer clic sólo lo
 * cerraba. Sin modal, el menú se cierra solo en cuanto el foco sale de él. La agencia ya no es un
 * menú: abre el selector de agencia (agency-switcher.tsx).
 */
export function Topbar({ userEmail, tenantName, tenantSlug, logoUrl, role }: TopbarProps) {
  // Revoca en el API, avisa a las demás pestañas (se van al login juntas) y sale con una navegación
  // dura: un `router.push` conservaba el Router Cache y "Atrás" volvía a dibujar la pantalla de
  // antes (clientes, órdenes) sin pedirla al servidor.
  function handleLogout() {
    void logout();
  }

  return (
    <header className="sticky top-0 z-30 flex h-[var(--app-topbar-height)] items-center justify-between border-b border-[var(--color-border)]/50 bg-[var(--color-surface)]/80 px-4 backdrop-blur-md sm:px-6 transition-all">
      {/* Izquierda: la agencia con la que se opera, y el cambio de agencia. */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <MobileNav role={role} tenantName={tenantName} tenantSlug={tenantSlug} logoUrl={logoUrl} />
        <AgencyTrigger tenantName={tenantName} tenantSlug={tenantSlug} logoUrl={logoUrl} />
      </div>

      {/* Right side: Search & User Controls */}
      <div className="flex shrink-0 items-center gap-3 pl-3">
        <ThemeToggle />
        {/* Paleta de comandos (⌘K / Ctrl+K): pantallas y "Cambiar de agencia". */}
        <CommandMenuButton />

        {/* Menú del Usuario */}
        <DropdownMenu.Root modal={false}>
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
                onSelect={handleLogout}
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
