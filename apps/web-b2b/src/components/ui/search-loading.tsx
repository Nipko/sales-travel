import { Loader2, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { RESULTS_GRID } from './filters-aside';
import { SEARCH_SLOW_MESSAGE, SearchMessages, searchMessagesFor } from './search-loading-messages';
import { SearchStage } from '../search-stage/search-stage';
import type { DestinationHint } from '../search-stage/resolve-scene';
import { TravelScene, sceneForSubject } from './travel-scene';

export {
  SEARCH_LOADING_MESSAGES,
  SEARCH_MESSAGES_BY_SUBJECT,
  SEARCH_MESSAGE_MS,
  SEARCH_SLOW_MESSAGE,
  SearchMessages,
  searchMessageStyle,
  searchMessagesFor,
} from './search-loading-messages';

/*
 * La espera de una búsqueda, igual en vuelos, hoteles y autos: el botón pasa a «Buscando…» y el
 * lugar de los resultados muestra qué se está buscando, tres mensajes que se turnan y la silueta
 * de los resultados, para que al llegar la lista no salte nada.
 *
 * Todo el movimiento es CSS (`search-sweep`, `search-message` en globals.css): sin temporizadores
 * que limpiar ni estado que se desfase con el servidor. Con «reducir movimiento» no se mueve nada
 * y queda sólo el texto: sin giro, sin barrido, sin siluetas latiendo y un único mensaje fijo.
 */

/**
 * Lo que oye un lector de pantalla al empezar la búsqueda: una sola vez, sin los mensajes que
 * se turnan, que repetidos cada dos segundos taparían todo lo demás.
 */
export function searchAnnouncement(subject: string, echo?: string): string {
  const what = echo ? `${subject}: ${echo}` : subject;
  return `Buscando ${what}. Consultando proveedores y comparando tarifas.`;
}

/** El contenido del botón de buscar: el mismo «Buscando…» con indicador en las tres búsquedas. */
export function SearchButtonLabel({
  searching,
  children,
}: {
  searching: boolean;
  /** El texto en reposo: «Buscar hoteles», «Buscar autos», «Buscar». */
  children: ReactNode;
}) {
  return searching ? (
    <>
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:hidden" />
      Buscando…
    </>
  ) : (
    <>
      <Search aria-hidden="true" className="size-4" />
      {children}
    </>
  );
}

export function SearchLoading({
  active,
  subject,
  echo,
  destination,
  children,
  className,
  cardClassName,
}: {
  /** Hay una búsqueda en curso. La región viva queda montada siempre: así se anuncia al cambiar. */
  active: boolean;
  /** Qué se busca, en plural: «hoteles», «autos», «vuelos». */
  subject: string;
  /** Lo que se buscó, en una línea: quien dictó las fechas de memoria las ve escritas. */
  echo?: string;
  /**
   * Adónde se busca: la ventana grande de la espera muestra su paisaje (o el que más se le
   * parece). Sin él, la escena genérica de ciudad.
   */
  destination?: DestinationHint;
  /** La silueta de los resultados de esta búsqueda. */
  children?: ReactNode;
  className?: string;
  cardClassName?: string;
}) {
  const scene = sceneForSubject(subject);
  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {active ? searchAnnouncement(subject, echo) : ''}
      </p>
      {scene === undefined ? null : (
        <SearchStage
          active={active}
          vertical={scene}
          {...(destination === undefined ? {} : { destination })}
          {...(echo ? { echo } : {})}
          messages={searchMessagesFor(subject)}
          slowMessage={SEARCH_SLOW_MESSAGE}
        />
      )}
      {active ? (
        /*
          `aria-busy` marca el lugar de los resultados mientras se llenan. Lo que dice qué se busca
          queda legible adentro (quien recorre la página con el lector lo encuentra ahí); los
          mensajes que se turnan y la silueta no, que ya los resume la región viva de arriba.
        */
        <div
          aria-busy="true"
          className={cn('animate-fade-in space-y-3 motion-reduce:animate-none', className)}
        >
          <div
            className={cn(
              'relative flex items-center gap-4 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)]',
              cardClassName,
            )}
          >
            <div className="min-w-0 flex-1">
              {/* Hasta dos renglones: en el teléfono, cortado en uno, el eco perdía las fechas. */}
              <p className="line-clamp-2 text-sm">
                <span className="font-semibold text-[var(--color-fg)]">Buscando</span>{' '}
                <span className="text-[var(--color-fg-muted)]">{echo || subject}</span>
              </p>
              {/* Un renglón fijo: los mensajes se turnan encima unos de otros y nada se corre. */}
              <SearchMessages className="mt-0.5" messages={searchMessagesFor(subject)} />
              {/* Sólo si tarda: aparece a los 8 s y no se mueve (ya lo anunció la región viva). */}
              <p
                aria-hidden="true"
                className="mt-1.5 text-[11px] leading-4 text-[var(--color-fg-subtle)] motion-safe:animate-search-slow motion-reduce:hidden"
              >
                {SEARCH_SLOW_MESSAGE}
              </p>
            </div>
            {/* Después del texto en el documento (el lector oye primero qué se busca) y a la
                izquierda en pantalla. */}
            {scene === undefined ? null : (
              <TravelScene kind={scene} className="order-first w-24 shrink-0 sm:w-36" />
            )}
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[var(--color-primary)]/10 motion-reduce:hidden"
            >
              <span className="block h-full w-1/3 animate-search-sweep rounded-full bg-[var(--color-primary)]" />
            </span>
          </div>
          {children ? (
            <div aria-hidden="true" className="space-y-3 motion-reduce:hidden">
              {children}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

const BONE = 'animate-pulse rounded bg-[var(--color-surface-muted)]';

/**
 * El marco de los resultados de hoteles y autos mientras llegan: filtros a la izquierda en
 * pantallas anchas y la barra de orden arriba, como la lista real, para que al llegar no salte.
 */
export function ResultsSkeletonFrame({ children }: { children: ReactNode }) {
  return (
    <div className={RESULTS_GRID}>
      <div className="hidden space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] xl:block">
        <div className={cn(BONE, 'h-4 w-16')} />
        {[0, 1, 2].map((group) => (
          <div key={group} className="space-y-2">
            <div className={cn(BONE, 'h-3 w-24')} />
            <div className={cn(BONE, 'h-3 w-32')} />
            <div className={cn(BONE, 'h-3 w-28')} />
          </div>
        ))}
      </div>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <div className={cn(BONE, 'h-9 w-24 rounded-lg xl:hidden')} />
          <div className={cn(BONE, 'h-9 flex-1 rounded-lg sm:w-44 sm:flex-none')} />
          <div className={cn(BONE, 'ml-auto hidden h-9 w-28 rounded-lg sm:block')} />
        </div>
        <div className={cn(BONE, 'h-4 w-56')} />
        {children}
      </div>
    </div>
  );
}
