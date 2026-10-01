'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/*
 * Un área con scroll propio que dice lo que queda fuera de la vista: un degradado arriba cuando
 * hay contenido por encima y otro abajo cuando queda más por bajar, en vez de un corte seco a
 * mitad de renglón. Si todo entra, no hay scroll ni degradado.
 *
 * Los degradados van DENTRO del área, pegados (`sticky`) a sus bordes: tapan el contenido y no
 * la barra de scroll, que queda a la vista.
 *
 * El área es `relative` por la misma razón que el `<main>` del shell: es el bloque contenedor de
 * los `sr-only` de las opciones. Si no, su bloque contenedor era el panel de afuera: no corrían
 * con el scroll y, cuando un lector de pantalla llevaba uno a la vista, el que se movía era el
 * panel (con `overflow-hidden`), que perdía el título arriba y dejaba un hueco abajo sin vuelta.
 */

export interface ScrollEdges {
  /** Hay contenido por encima de lo que se ve. */
  readonly above: boolean;
  /** Queda contenido por debajo de lo que se ve. */
  readonly below: boolean;
}

const NO_EDGES: ScrollEdges = { above: false, below: false };

/** Con zoom el navegador da el scroll con decimales: al final pueden faltar fracciones de píxel. */
const SLACK_PX = 1;

/** Qué queda fuera de la vista con estas medidas del área (las de cualquier elemento). */
export function scrollEdges(area: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): ScrollEdges {
  const hidden = area.scrollHeight - area.clientHeight;
  if (hidden <= SLACK_PX) return NO_EDGES;
  return {
    above: area.scrollTop > SLACK_PX,
    below: hidden - area.scrollTop > SLACK_PX,
  };
}

const FADE =
  'pointer-events-none sticky z-10 block from-[var(--color-surface)] to-transparent transition-opacity duration-150 motion-reduce:transition-none';

export function ScrollFade({
  children,
  className,
  contentClassName,
  contain = false,
}: {
  children: ReactNode;
  /** El área que scrollea: su alto lo pone quien la usa (`min-h-0 flex-1` en una columna flex). */
  className?: string;
  /** El relleno va en el contenido y no en el área: así los degradados llegan a los bordes. */
  contentClassName?: string;
  /**
   * La rueda no sigue a la página al llegar al final (`overscroll-contain`). Sólo en un modal,
   * donde lo de atrás no se tiene que mover. En una columna pegada de la página no: Chrome traga
   * la rueda aunque todo entre, y con la página arriba de todo la columna nunca llegaba a pegarse
   * y sus últimas opciones quedaban debajo del borde de la ventana.
   */
  contain?: boolean;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);

  useEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = scrollEdges(area);
      setEdges((prev) => (prev.above === next.above && prev.below === next.below ? prev : next));
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    area.addEventListener('scroll', schedule, { passive: true });
    // Lo que entra también cambia sin scrollear: la ventana cambia de alto o un filtro suma o
    // quita opciones.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(area);
    if (contentRef.current !== null) observer?.observe(contentRef.current);
    return () => {
      area.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={areaRef}
      data-scroll-area=""
      // El `scroll-padding` deja lo que recibe el foco con el teclado fuera de los degradados.
      className={cn(
        'relative overflow-y-auto scroll-pb-10 scroll-pt-6',
        contain && 'overscroll-contain',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          FADE,
          'top-0 -mb-4 h-4 bg-gradient-to-b',
          edges.above ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div ref={contentRef} className={contentClassName}>
        {children}
      </div>
      <span
        aria-hidden="true"
        className={cn(
          FADE,
          'bottom-0 -mt-8 h-8 bg-gradient-to-t',
          edges.below ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}
