'use client';

import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { Button } from './button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** El primer control dentro de `scope` (un selector), con el mismo criterio que la trampa de foco. */
export function firstFocusableWithin(scope: string): string {
  return FOCUSABLE.split(', ')
    .map((selector) => `${scope} ${selector}`)
    .join(', ');
}

/**
 * Los paneles de los modales abiertos. Sólo el de más arriba atiende Escape y Tab.
 *
 * Mirar si el panel CONTIENE otro diálogo ya no alcanza: los modales se montan en un portal al
 * `<body>`, así que una confirmación abierta desde un panel es un hermano suyo en el DOM, no un
 * hijo. Sin esto, un Escape cerraba los dos y el Tab de la confirmación lo robaba el panel.
 *
 * "Más arriba" es el último en el orden del documento, no el último en registrarse. El portal agrega
 * al final del `<body>`, así que abrir después es quedar después; y un diálogo anidado sin portal es
 * descendiente, que también va después.
 */
const openPanels = new Set<HTMLElement>();

function isTopmost(panel: HTMLElement): boolean {
  for (const other of openPanels) {
    if (other === panel || !other.isConnected) continue;
    if (panel.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
  }
  return true;
}

/**
 * Cuántos modales piden el fondo sin scroll, y cómo estaba antes del primero. Un contador y no un
 * valor guardado por modal: al cerrar un panel con su confirmación abierta, los dos se desmontan en
 * el mismo commit, y si la confirmación restauraba después lo que vio al abrirse —`hidden`, puesto
 * por el panel— la página quedaba sin scroll para siempre.
 */
let scrollLocks = 0;
let overflowBeforeLock = '';

export interface ModalBehaviorOptions {
  /** Selector, relativo al panel, del control que recibe el foco al abrir. Sin él, el primero. */
  readonly initialFocus?: string;
}

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
export function useModalBehavior(
  open: boolean,
  onClose: () => void,
  options?: ModalBehaviorOptions,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const initialFocus = options?.initialFocus;
  // El efecto no depende de `onClose`: quien lo pasa en línea estrena función en cada render, y
  // volver a correr el efecto devolvía el foco al que abrió el modal y lo mandaba otra vez al
  // primer control. En "Invitar usuario", elegir un rol con el teclado saltaba al correo.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    if (panel) openPanels.add(panel);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (scrollLocks === 0) {
      overflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;

    const first =
      (initialFocus ? panel?.querySelector<HTMLElement>(initialFocus) : null) ??
      panel?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    function onKeyDown(e: KeyboardEvent) {
      const current = panelRef.current;
      if (current && !isTopmost(current)) return;
      // Un diálogo abierto DENTRO de éste sin pasar por este hook maneja su Escape y su Tab: si no,
      // un Escape cerraba los dos y el Tab ciclaba por los controles tapados.
      if (panelRef.current?.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !current) return;

      const nodes = current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;

      // El foco puede quedar FUERA del panel sin que nadie lo saque de ahí: al guardar, el botón que
      // lo tenía se deshabilita y el navegador lo deja en el `<body>`. Mirar sólo el primero y el
      // último dejaba que el Tab siguiente cayera en la página tapada por el fondo.
      if (!current.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
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
      if (panel) openPanels.delete(panel);
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = overflowBeforeLock;
      // Sólo si sigue en la página: el que abrió una confirmación puede irse con el panel que la
      // contenía, y enfocar un nodo suelto no hace nada útil.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open, initialFocus]);

  return panelRef;
}

const subscribeNothing = () => () => undefined;

/**
 * Monta un modal en el `<body>`.
 *
 * Un `position: fixed` NO se ubica contra la ventana si algún ancestro tiene `transform`, `filter`
 * o `backdrop-filter`: se ubica contra ese ancestro. Las páginas entran con `animate-fade-in-up`,
 * que con `forwards` dejaba puesto `transform: translateY(0)`, así que un modal montado adentro
 * quedaba centrado en la PÁGINA —en /admin/proveedores, el editor de Sabre abría entero fuera de la
 * pantalla en el teléfono— y su fondo oscuro no tapaba la barra ni el menú. La animación ya no deja
 * nada puesto (globals.css); el portal sigue porque cualquier ancestro con `filter` o `transform`
 * lo volvería a romper.
 *
 * En el servidor y durante la hidratación se pinta en su lugar, igual que antes: así el HTML del
 * servidor coincide con el primer render del cliente, y los tests que renderizan a texto lo ven.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  return hydrated ? createPortal(children, document.body) : <>{children}</>;
}

/**
 * Diálogo centrado: título fijo arriba, el contenido con su propio scroll y, si se pasa `footer`,
 * un pie fijo abajo. Con un formulario largo el título y los botones ya no se van con el scroll.
 * Para un formulario largo de verdad (credenciales de un proveedor) está `FormSheet`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocus,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Acciones que quedan siempre a la vista, debajo del contenido que scrollea. */
  footer?: ReactNode;
  /**
   * Selector, relativo al panel, del control que recibe el foco al abrir. Sin él, el primero del
   * cuerpo: cuando ése es un botón que borra algo, conviene apuntar a otro.
   */
  initialFocus?: string;
  className?: string;
}) {
  const panelRef = useModalBehavior(open, onClose, {
    initialFocus: initialFocus ?? firstFocusableWithin('[data-dialog-body]'),
  });
  const titleId = useId();
  const descriptionId = useId();
  if (!open) return null;

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={onClose}
          aria-hidden
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          // En una confirmación, la descripción es lo que dice qué se corta: el lector de pantalla
          // tiene que leerla al abrir, no sólo el título.
          aria-describedby={description ? descriptionId : undefined}
          className={cn(
            'relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-xl motion-safe:animate-scale-up border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]',
            className,
          )}
        >
          <div className="shrink-0 pb-3 pl-5 pr-12 pt-5">
            <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {description}
              </p>
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
          {/* `pt-1`: el anillo de foco del primer control se dibuja por fuera del control, y un
              contenedor con scroll lo recorta. */}
          <div
            data-dialog-body
            className="scroll-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-1"
          >
            {children}
          </div>
          {footer ? (
            <div className="shrink-0 border-t border-[var(--color-border)] px-5 py-3">{footer}</div>
          ) : null}
        </div>
      </div>
    </ModalPortal>
  );
}

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  /** El botón que no confirma. "Cancelar" salvo que se diga otra cosa. */
  cancelLabel?: string;
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

  const dismiss = useCallback(() => settle(false), [settle]);

  const element = request ? (
    <Dialog open onClose={dismiss} title={request.title} description={request.description}>
      {/* Apiladas en el teléfono: a 320 px "Seguir editando" y "Descartar cambios" no entran en una
          fila, y con `justify-end` lo que sobra se salía por la izquierda de la pantalla. */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={dismiss}>
          {request.cancelLabel ?? 'Cancelar'}
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
