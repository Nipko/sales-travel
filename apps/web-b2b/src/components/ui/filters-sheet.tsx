'use client';

import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useModalBehavior } from './dialog';

/**
 * Los filtros de una pantalla de resultados en el teléfono: una hoja que sube desde abajo, con el
 * foco atrapado, Escape para cerrar y el botón de abajo que dice cuántos resultados quedan. Nació
 * en hoteles; autos usa la misma.
 */
export function FiltersSheet({
  open,
  onClose,
  submitLabel,
  headerAction,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** El botón de abajo: "Ver 12 hoteles", "Ningún auto con estos filtros". */
  submitLabel: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useModalBehavior(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] animate-fade-in-up flex-col rounded-t-xl border-t border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
            Filtros
          </h2>
          <div className="flex items-center gap-1">
            {headerAction}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar filtros"
              className="inline-flex size-9 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {children}
        </div>
        <div className="border-t border-[var(--color-border)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
