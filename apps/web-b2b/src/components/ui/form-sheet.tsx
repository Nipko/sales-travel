'use client';

import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { ModalPortal, useConfirm, useModalBehavior } from './dialog';

/**
 * Al abrir, el foco va al primer campo del formulario y no a la X de la cabecera: quien abre el
 * panel viene a escribir.
 */
export const FIRST_FIELD =
  '[data-sheet-body] :is(input, select, textarea):not([disabled]):not([type="hidden"])';

/**
 * Un formulario largo: panel a la derecha en escritorio, pantalla completa en el teléfono.
 *
 * Tres franjas y una sola con scroll. La cabecera (qué se edita, de quién, cerrar) y el pie
 * (Cancelar y Guardar) quedan siempre a la vista; el cuerpo es lo único que se desplaza, con su
 * barra visible y un borde que aparece arriba cuando hay contenido tapado y una sombra en el pie
 * cuando queda más abajo.
 *
 * Cerrar con cambios sin guardar —Escape, la X, el fondo o Cancelar— pide confirmación: en un
 * formulario de credenciales volver a tipear todo es caro. Mientras guarda no se cierra, y Guardar
 * no se deshabilita sino que queda `aria-disabled`: un botón deshabilitado suelta el foco al
 * `<body>`, y quien guardó con el teclado quedaba fuera del panel sin oír "Guardando…".
 */
export function FormSheet({
  title,
  subtitle,
  icon,
  describedBy,
  dirty = false,
  busy = false,
  onClose,
  onSubmit,
  submitLabel,
  submitIcon,
  busyLabel = 'Guardando…',
  status,
  initialFocus = FIRST_FIELD,
  children,
}: {
  title: string;
  /** Debajo del título: de quién es lo que se edita. Lo lee el lector de pantalla al abrir. */
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Ids de más avisos que el lector de pantalla tiene que leer al abrir. */
  describedBy?: string;
  /** Hay cambios que se pierden al cerrar. */
  dirty?: boolean;
  /** Guardando: Guardar y cerrar quedan deshabilitados. */
  busy?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitIcon?: ReactNode;
  busyLabel?: string;
  /** Lo que tiene que verse junto a los botones: el error del guardado, por ejemplo. */
  status?: ReactNode;
  /** Selector, relativo al panel, del control que recibe el foco al abrir. */
  initialFocus?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const subtitleId = useId();
  const [confirm, confirmDialog] = useConfirm();

  const latest = useRef({ dirty, busy, onClose });
  latest.current = { dirty, busy, onClose };
  const confirming = useRef(false);

  // Lee `dirty` y `busy` del último render: la X, el fondo y Escape comparten esta función.
  const requestClose = useCallback(() => {
    if (latest.current.busy || confirming.current) return;
    if (!latest.current.dirty) {
      latest.current.onClose();
      return;
    }
    confirming.current = true;
    void confirm({
      title: '¿Descartar los cambios?',
      description:
        'Lo que cargaste en este formulario todavía no se guardó. Si cierras ahora, se pierde.',
      confirmLabel: 'Descartar cambios',
      cancelLabel: 'Seguir editando',
      destructive: true,
    }).then((discard) => {
      confirming.current = false;
      if (discard) latest.current.onClose();
    });
  }, [confirm]);

  const panelRef = useModalBehavior(true, requestClose, { initialFocus });

  const bodyRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const above = el.scrollTop > 0;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
  }, []);

  useEffect(() => {
    measure();
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // El contenido cambia de alto sin scroll de por medio: aparece un error, un aviso, otra sección.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);

  const described = [subtitle ? subtitleId : null, describedBy ?? null].filter(Boolean).join(' ');

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex justify-end">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={requestClose}
          aria-hidden
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={described || undefined}
          aria-busy={busy || undefined}
          className="relative flex w-full flex-col bg-[var(--color-surface)] shadow-[var(--shadow-xl)] motion-safe:animate-fade-in-up sm:max-w-[600px] sm:border-l sm:border-[var(--color-border)] motion-safe:sm:animate-sheet-in"
        >
          <header
            className={cn(
              'flex shrink-0 items-start gap-3 border-b px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))] transition-[border-color,box-shadow] duration-150',
              edges.above
                ? 'border-[var(--color-border)] shadow-[var(--shadow-sm)]'
                : 'border-transparent',
            )}
          >
            {icon ? (
              <div
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/10 text-[var(--color-primary)] [&_svg]:size-4"
              >
                {icon}
              </div>
            ) : null}
            <div className="min-w-0 flex-1 pt-0.5">
              <h2
                id={titleId}
                className="text-base font-semibold leading-snug text-[var(--color-fg)] [overflow-wrap:anywhere]"
              >
                {title}
              </h2>
              {subtitle ? (
                <p id={subtitleId} className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                  {subtitle}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={requestClose}
              disabled={busy}
              aria-label="Cerrar"
              className="-mr-2 -mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          <div
            ref={bodyRef}
            onScroll={measure}
            data-sheet-body
            className="scroll-panel relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div className="px-5 pb-6 pt-1">{children}</div>
          </div>

          <footer
            className={cn(
              'shrink-0 space-y-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 transition-shadow duration-150',
              edges.below && 'shadow-[0_-8px_16px_-12px_oklch(0.13_0.04_250/0.25)]',
            )}
          >
            {status}
            {/* `wrap-reverse`: en el teléfono van lado a lado mientras entren; cuando no —"Guardar en
                Deshabilitado" a 320 px— Guardar sube a su propia fila en vez de salirse por la
                izquierda de la pantalla. */}
            <div className="flex flex-wrap-reverse items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={requestClose}
                disabled={busy}
                className="h-10 flex-1 sm:h-9 sm:flex-none"
              >
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={busy ? undefined : onSubmit}
                aria-disabled={busy || undefined}
                className="h-10 flex-1 aria-disabled:cursor-wait aria-disabled:opacity-60 sm:h-9 sm:flex-none"
              >
                {busy ? <RefreshCw aria-hidden="true" className="animate-spin" /> : submitIcon}
                {busy ? busyLabel : submitLabel}
              </Button>
            </div>
          </footer>
        </div>
      </div>
      {confirmDialog}
    </ModalPortal>
  );
}
