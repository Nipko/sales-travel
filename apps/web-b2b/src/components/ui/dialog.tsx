'use client';

import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Semántica de diálogo modal, en un solo lugar.
 *
 * La app tenía doce overlays escritos a mano: ninguno atrapaba el foco, ninguno cerraba
 * con Escape, ninguno declaraba role="dialog" y ninguno bloqueaba el scroll del fondo.
 * En la práctica un usuario de teclado tabulaba "detrás" del modal y quedaba operando
 * controles que no veía, y un lector de pantalla seguía leyendo la página de atrás como
 * si el modal no existiera.
 *
 * Se implementa a mano y no con @radix-ui/react-dialog para no sumar dependencia: el
 * comportamiento necesario cabe en este hook y ya está probado en el drawer móvil.
 */
export function useModalBehavior(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;

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
  }, [open, onClose]);

  return panelRef;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useModalBehavior(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative w-full max-w-md animate-scale-up rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xl)]',
          className,
        )}
      >
        <div className="mb-4 pr-8">
          <h2 className="text-base font-semibold text-[var(--color-fg)]">{title}</h2>
          {description ? (
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="absolute right-4 top-4 text-[var(--color-fg-subtle)] transition-colors hover:text-[var(--color-fg)]"
        >
          <X className="size-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
}

/**
 * Reemplazo de `window.confirm` para acciones destructivas.
 *
 * El confirm nativo no se puede estilar, bloquea el hilo, no dice QUÉ se va a borrar más
 * allá del texto plano, y en móvil aparece como un aviso del navegador que muchos
 * usuarios descartan por reflejo. Devuelve una promesa, así que el código llamante se
 * lee igual que antes: `if (!(await confirm({...}))) return;`
 */
export function useConfirm(): [(req: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((req: ConfirmRequest) => {
    setRequest(req);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  }, []);

  const element = request ? (
    <Dialog
      open
      onClose={() => settle(false)}
      title={request.title}
      description={request.description}
    >
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => settle(false)}>
          Cancelar
        </Button>
        <Button
          variant={request.destructive === false ? 'primary' : 'danger'}
          onClick={() => settle(true)}
        >
          {request.confirmLabel ?? 'Confirmar'}
        </Button>
      </div>
    </Dialog>
  ) : null;

  return [confirm, element];
}
