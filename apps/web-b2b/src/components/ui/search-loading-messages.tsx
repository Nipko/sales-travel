import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn';

/*
 * Los mensajes que se turnan mientras se espera una búsqueda: los usa la tarjeta de la página
 * (search-loading) y la ventana grande de la escena (components/search-stage).
 */

/** Los mensajes que se turnan, en el orden en que pasan las cosas. */
export const SEARCH_LOADING_MESSAGES = [
  'Consultando proveedores…',
  'Comparando tarifas…',
  'Buscando las mejores opciones…',
] as const;

/** Los de cada búsqueda, con sus palabras: el vendedor reconoce lo que está pasando. */
export const SEARCH_MESSAGES_BY_SUBJECT: Readonly<
  Record<string, readonly [string, string, string]>
> = {
  hoteles: [
    'Consultando disponibilidad…',
    'Comparando tarifas entre proveedores…',
    'Preparando fotos y habitaciones…',
  ],
  vuelos: [
    'Consultando aerolíneas…',
    'Comparando tarifas y escalas…',
    'Ordenando las mejores opciones…',
  ],
  autos: [
    'Consultando rentadoras…',
    'Comparando tarifas y coberturas…',
    'Buscando las mejores opciones…',
  ],
};

export function searchMessagesFor(subject: string): readonly [string, string, string] {
  return SEARCH_MESSAGES_BY_SUBJECT[subject] ?? SEARCH_LOADING_MESSAGES;
}

/** Lo que se lee si la búsqueda pasa de unos segundos: que nada se colgó. */
export const SEARCH_SLOW_MESSAGE =
  'Algunos proveedores tardan un poco más en responder. Seguimos buscando…';

/**
 * Cuánto se ve cada mensaje. El ciclo de `search-message` es esto por la cantidad de mensajes
 * (7,5 s) y cada uno se muestra en su tercio: cambiar uno sin el otro los encima.
 */
export const SEARCH_MESSAGE_MS = 2500;

/**
 * Tres mensajes que se turnan en un renglón fijo, uno encima del otro: nada se corre. Fuera del
 * árbol accesible (los resume la región viva de quien los usa) y, con «reducir movimiento», sólo
 * el primero y quieto. `search-message` está pensada para TRES mensajes.
 */
export function SearchMessages({
  messages = SEARCH_LOADING_MESSAGES,
  className,
}: {
  messages?: readonly [string, string, string];
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative h-4 overflow-hidden text-xs leading-4 text-[var(--color-fg-subtle)]',
        className,
      )}
    >
      {messages.map((message, index) => (
        <span
          key={message}
          style={searchMessageStyle(index)}
          className={cn(
            'absolute inset-0 truncate motion-safe:animate-search-message',
            index > 0 && 'motion-reduce:hidden',
          )}
        >
          {message}
        </span>
      ))}
    </div>
  );
}

/** El retraso de cada mensaje dentro del ciclo: el segundo arranca cuando se va el primero. */
export function searchMessageStyle(index: number): CSSProperties {
  return {
    animationDelay: `${index * SEARCH_MESSAGE_MS}ms`,
    animationDuration: `${SEARCH_LOADING_MESSAGES.length * SEARCH_MESSAGE_MS}ms`,
  };
}
