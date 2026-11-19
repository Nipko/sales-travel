'use client';

import { ArrowDown, Minimize2 } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SearchMessages } from '../ui/search-loading-messages';
import { ARCHETYPE_LABEL } from './catalog';
import { resolveScene, type DestinationHint, type ResolvedScene } from './resolve-scene';
import { StageScene, type StageVertical } from './stage-scene';

/*
 * La ventana grande de la espera de una búsqueda: la escena del destino ocupa casi todo, y abajo
 * qué se busca, los mensajes que se turnan y el aviso si tarda.
 *
 * - Se abre con la búsqueda y se cierra sola al llegar los resultados.
 * - «Seguir en segundo plano» (o Escape) la minimiza: queda la tarjeta chica de la página.
 * - Es un diálogo de verdad mientras está abierta (foco adentro, Escape, el foco vuelve al
 *   cerrarse). La región viva de `SearchLoading` sigue anunciando la búsqueda una sola vez.
 * - La escena se congela si la pestaña no está a la vista: no gasta batería en segundo plano.
 */

export const STAGE_TITLES: Readonly<Record<StageVertical, string>> = {
  hotels: 'Buscando tu hotel',
  flights: 'Buscando tu vuelo',
  cars: 'Buscando tu auto',
};

/** "en Cartagena" / "en una playa": qué dice la ventana del destino. */
export function destinationPhrase(scene: ResolvedScene, hint: DestinationHint | undefined): string {
  if (scene.kind === 'city') return `en ${scene.city.label}`;
  const name = hint?.name?.split(',')[0]?.trim();
  if (name) return `en ${name}`;
  return `· ${ARCHETYPE_LABEL[scene.archetype]}`;
}

interface Area {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * El rectángulo del contenido de la página (el `<main>` del shell, sin el menú ni la barra de
 * arriba). La ventana se centra ahí y no en la pantalla entera: centrada en la pantalla quedaba
 * corrida respecto del formulario de búsqueda, que vive a la derecha del menú. Sin `<main>`, la
 * pantalla.
 */
const MIN_AREA_WIDTH = 640;

function useContentArea(open: boolean): Area | null {
  const [area, setArea] = useState<Area | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const main = document.querySelector('main');
    if (main === null) return;
    const measure = () => {
      const r = main.getBoundingClientRect();
      // Angosto (teléfono, o un panel lateral abierto): la ventana usa la pantalla entera.
      if (r.width < MIN_AREA_WIDTH) {
        setArea(null);
        return;
      }
      setArea((prev) =>
        prev !== null &&
        prev.left === r.left &&
        prev.top === r.top &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { left: r.left, top: r.top, width: r.width, height: r.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open]);
  return area;
}

/**
 * Lo mínimo que la ventana queda abierta. Una búsqueda que vuelve en medio segundo la mostraba y la
 * cerraba de golpe, sin dejar ver nada: así se alcanza a ver la escena, y los resultados ya se
 * pintan debajo mientras tanto. Si la búsqueda tarda más, la ventana sigue hasta que termine.
 */
export const STAGE_MIN_OPEN_MS = 2_500;

/** Cuánto más queda abierta una ventana que se abrió en `openedAt` y cuya búsqueda ya terminó. */
export function lingerMs(openedAt: number | null, now: number, min = STAGE_MIN_OPEN_MS): number {
  if (openedAt === null) return 0;
  return Math.max(0, min - (now - openedAt));
}

export const STAGE_DONE_TITLE = 'Listo, ya están tus resultados';

export function SearchStage({
  active,
  vertical,
  destination,
  echo,
  messages,
  slowMessage,
}: {
  active: boolean;
  vertical: StageVertical;
  destination?: DestinationHint;
  /** Lo que se buscó, en una línea (fechas, noches, pasajeros). */
  echo?: string;
  messages: readonly [string, string, string];
  slowMessage: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [lingering, setLingering] = useState(false);
  const openedAt = useRef<number | null>(null);
  const titleId = useId();
  const descId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const scene = useMemo(
    () => resolveScene(destination),
    [destination?.name, destination?.iata, destination?.country],
  );

  useEffect(() => setMounted(true), []);

  // Cada búsqueda nueva abre la ventana otra vez. Al terminar, se queda lo que falte para el mínimo.
  useEffect(() => {
    if (active) {
      setMinimized(false);
      setLingering(false);
      openedAt.current = Date.now();
      return;
    }
    const rest = lingerMs(openedAt.current, Date.now());
    openedAt.current = null;
    if (rest === 0) return;
    setLingering(true);
    const timer = window.setTimeout(() => setLingering(false), rest);
    return () => window.clearTimeout(timer);
  }, [active]);

  const done = !active;
  const open = mounted && (active || lingering) && !minimized;
  const area = useContentArea(open);

  useEffect(() => {
    if (!open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    buttonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMinimized(true);
      } else if (e.key === 'Tab') {
        // Un solo control: el foco se queda en él.
        e.preventDefault();
        buttonRef.current?.focus();
      }
    };
    const onVisibility = () => setHidden(document.hidden);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      returnFocus.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div
        aria-hidden="true"
        className={
          done
            ? 'ss-modal-backdrop absolute inset-0 bg-[color-mix(in_oklch,var(--color-bg)_25%,transparent)] transition-[background-color] duration-500'
            : 'ss-modal-backdrop absolute inset-0 bg-[color-mix(in_oklch,var(--color-bg)_55%,transparent)] backdrop-blur-[3px]'
        }
      />
      <div
        data-search-stage-area=""
        className="absolute inset-0 flex items-end justify-center p-0 sm:items-center sm:p-6"
        style={area ?? undefined}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          data-search-stage={vertical}
          className="ss-modal relative w-full max-w-[760px] overflow-hidden rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] sm:rounded-2xl"
        >
          <StageScene vertical={vertical} scene={scene} paused={hidden} className="aspect-[16/9]" />
          <div className="flex items-start gap-4 px-5 pb-5 pt-4 sm:px-6">
            <div className="min-w-0 flex-1">
              <h2
                id={titleId}
                className="text-base font-semibold text-[var(--color-fg)] sm:text-lg"
              >
                {done ? (
                  STAGE_DONE_TITLE
                ) : (
                  <>
                    {STAGE_TITLES[vertical]}{' '}
                    <span className="text-[var(--color-primary)]">
                      {destinationPhrase(scene, destination)}
                    </span>
                  </>
                )}
              </h2>
              {echo ? (
                <p id={descId} className="mt-0.5 line-clamp-2 text-sm text-[var(--color-fg-muted)]">
                  {echo}
                </p>
              ) : (
                <p id={descId} className="sr-only">
                  Consultando proveedores y comparando tarifas.
                </p>
              )}
              {done ? null : (
                <>
                  <SearchMessages className="mt-2" messages={messages} />
                  <p
                    aria-hidden="true"
                    className="mt-1.5 text-xs text-[var(--color-fg-subtle)] motion-safe:animate-search-slow motion-reduce:hidden"
                  >
                    {slowMessage}
                  </p>
                </>
              )}
            </div>
            <button
              ref={buttonRef}
              type="button"
              onClick={() => setMinimized(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
            >
              {done ? (
                <>
                  <ArrowDown aria-hidden="true" className="size-3.5" />
                  Ver resultados
                </>
              ) : (
                <>
                  <Minimize2 aria-hidden="true" className="size-3.5" />
                  <span className="hidden sm:inline">Seguir en segundo plano</span>
                  <span className="sm:hidden">Minimizar</span>
                </>
              )}
            </button>
          </div>
          {done ? null : (
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-[var(--color-primary)]/10 motion-reduce:hidden"
            >
              <span className="block h-full w-1/3 animate-search-sweep rounded-full bg-[var(--color-primary)]" />
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
