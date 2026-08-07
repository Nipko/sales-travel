'use client';

import { Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SidebarContent } from './sidebar';

interface MobileNavProps {
  role?: string;
  tenantName?: string;
  logoUrl?: string;
}

/** Elementos enfocables dentro del panel, para el focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Navegación móvil: hamburguesa + drawer lateral.
 *
 * El sidebar de escritorio es `hidden lg:flex`, así que bajo 1024px la aplicación se
 * quedaba sin ninguna forma de navegar — contra el principio mobile-first del proyecto,
 * y especialmente grave para un vendedor en ruta.
 *
 * Implementa la semántica de diálogo que el resto de los overlays de la app todavía no
 * tiene: role="dialog" + aria-modal, cierre con Escape, foco atrapado dentro del panel,
 * scroll del fondo bloqueado y foco devuelto al disparador al cerrar.
 */
export function MobileNav({ role, tenantName, logoUrl }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  const close = useCallback(() => setOpen(false), []);

  // Navegar cierra el drawer: sin esto queda tapando la página recién abierta.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // El primer enfocable del panel, para no dejar el foco atrás en el fondo inerte.
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;

      // Ciclar dentro del panel en vez de escaparse al contenido de atrás.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus();
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir menú de navegación"
        aria-expanded={open}
        className="lg:hidden inline-flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
      >
        <Menu className="size-5" />
      </button>

      {open ? (
        <div className="lg:hidden fixed inset-0 z-50">
          {/* Fondo: cierra al tocar. aria-hidden porque el botón de cerrar ya cubre la acción. */}
          <div
            className="absolute inset-0 bg-black/50 animate-fade-in"
            onClick={close}
            aria-hidden="true"
          />

          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navegación principal"
            className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col border-r border-slate-800/60 bg-[var(--color-navy-dark)] text-slate-300 shadow-[var(--shadow-xl)]"
          >
            <button
              type="button"
              onClick={close}
              aria-label="Cerrar menú de navegación"
              className="absolute right-3 top-4 z-10 inline-flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" />
            </button>

            <SidebarContent role={role} tenantName={tenantName} logoUrl={logoUrl} />
          </div>
        </div>
      ) : null}
    </>
  );
}
