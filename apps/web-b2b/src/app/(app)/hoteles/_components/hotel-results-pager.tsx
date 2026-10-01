'use client';

import { ChevronsDown, CircleCheck, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { SearchButtonLabel, SearchMessages } from '../../../../components/ui/search-loading';
import { cn } from '../../../../lib/cn';
import {
  canLoadMore,
  coverageSegments,
  coverageView,
  revealView,
  type MoreState,
} from './hotel-paging';

/*
 * El pie de la lista de hoteles (docs/tbo/02 §4.4): "Mostrar 20 más" de lo que ya llegó y, cuando
 * ya se ve todo, cuánto del destino se consultó y "Ver más hoteles" para el tramo siguiente. El
 * medidor dibuja un segmento por tramo consultado y el siguiente punteado: mientras se consulta,
 * ese segmento lleva el barrido de la espera de la búsqueda (PR #27), en chico.
 */

const SECONDARY_BUTTON =
  'inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 sm:w-auto';

const PRIMARY_BUTTON =
  'inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-[background-color,transform] hover:bg-[var(--color-primary-hover)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2 aria-disabled:cursor-progress aria-disabled:active:scale-100 motion-reduce:transform-none sm:w-auto';

/** Los mensajes de "Buscando más hoteles", en el orden en que pasan las cosas. */
const LOADING_MORE_MESSAGES = [
  'Consultando los siguientes hoteles…',
  'Comparando tarifas…',
  'Sumándolos a tu lista…',
] as const;

export interface ResultsPagerProps {
  /** Hoteles que cumplen los filtros. */
  shown: number;
  /** Cuántos de ellos se ven. */
  visible: number;
  onShowMore?: () => void;
  /** Los tramos de la búsqueda; sin `paging`, no hay nada que decir del destino. */
  more?: MoreState;
  destinationLabel?: string;
  onLoadMore: () => void;
  onSearchAgain: () => void;
  /** Hay una búsqueda nueva en curso. */
  searching: boolean;
}

export function ResultsPager({
  shown,
  visible,
  onShowMore,
  more,
  destinationLabel,
  onLoadMore,
  onSearchAgain,
  searching,
}: ResultsPagerProps) {
  const reveal = revealView(visible, shown);
  const paging = more?.paging;
  return (
    <div className="space-y-3">
      {reveal !== undefined && onShowMore !== undefined ? (
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-center sm:gap-3">
          <p className="text-center text-xs tabular-nums text-[var(--color-fg-muted)]">
            {reveal.progress}
          </p>
          <button type="button" onClick={onShowMore} className={SECONDARY_BUTTON}>
            <ChevronsDown aria-hidden="true" className="size-4" />
            {reveal.label}
          </button>
        </div>
      ) : null}
      {more !== undefined && paging !== undefined ? (
        <CoverageCard
          more={more}
          allVisible={reveal === undefined}
          destinationLabel={destinationLabel}
          onLoadMore={onLoadMore}
          onSearchAgain={onSearchAgain}
          searching={searching}
        />
      ) : null}
    </div>
  );
}

function CoverageCard({
  more,
  allVisible,
  destinationLabel,
  onLoadMore,
  onSearchAgain,
  searching,
}: {
  more: MoreState;
  allVisible: boolean;
  destinationLabel?: string;
  onLoadMore: () => void;
  onSearchAgain: () => void;
  searching: boolean;
}) {
  const titleId = useId();
  const titleRef = useRef<HTMLParagraphElement>(null);
  const actionFocused = useRef(false);
  const paging = more.paging;
  const loading = more.status === 'loading';
  const expired = more.status === 'expired';
  const offerMore = allVisible && paging?.hasMore === true && !expired;

  // El botón que tenía el foco desaparece (ya no quedan tramos, o la búsqueda venció): el foco
  // pasa a la línea que dice por qué, en vez de perderse en la página.
  useEffect(() => {
    if (actionFocused.current && !offerMore) {
      actionFocused.current = false;
      titleRef.current?.focus();
    }
  });

  if (paging === undefined) return null;
  const view = coverageView(paging, destinationLabel, { allVisible });
  const segments = coverageSegments(more.segments, paging);

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1 space-y-2">
          <p
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="flex items-start gap-1.5 text-sm font-medium text-[var(--color-fg)] focus:outline-none"
          >
            {view.complete ? (
              <CircleCheck
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
              />
            ) : null}
            <span>{view.line}</span>
          </p>

          {segments.length > 0 ? (
            <div
              aria-hidden="true"
              data-coverage-meter=""
              className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full"
            >
              {segments.map((segment, index) => (
                <span
                  key={`${segment.kind}-${index}`}
                  data-segment={segment.kind}
                  style={{ flexGrow: segment.percent, flexBasis: 0 }}
                  className={cn(
                    'relative h-full min-w-1 overflow-hidden rounded-full',
                    segment.kind === 'consulted' && 'bg-[var(--color-primary)]',
                    segment.kind === 'next' && 'bg-[var(--color-primary)]/25',
                    segment.kind === 'rest' && 'bg-[var(--color-border)]',
                  )}
                >
                  {segment.kind === 'next' && loading ? (
                    <span className="block h-full w-1/3 animate-search-sweep rounded-full bg-[var(--color-primary)] motion-reduce:hidden" />
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}

          {loading ? (
            <SearchMessages messages={LOADING_MORE_MESSAGES} />
          ) : expired ? null : (
            <p className="text-xs text-[var(--color-fg-muted)]">{view.detail}</p>
          )}

          {more.notice !== undefined && !loading ? (
            <p
              className={cn(
                'flex items-start gap-1.5 text-xs',
                more.notice.tone === 'warning'
                  ? 'text-[var(--color-fg)]'
                  : 'text-[var(--color-fg-muted)]',
              )}
            >
              {more.notice.tone === 'warning' ? (
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
                />
              ) : (
                <Info
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
                />
              )}
              <span>{more.notice.text}</span>
            </p>
          ) : null}

          {more.error !== undefined && !loading ? (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-xs font-medium text-[var(--color-danger)]"
            >
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>{more.error}</span>
            </p>
          ) : null}
        </div>

        {expired ? (
          <button
            type="button"
            onClick={onSearchAgain}
            aria-disabled={searching || undefined}
            className={cn(SECONDARY_BUTTON, 'shrink-0')}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-4', searching && 'animate-spin motion-reduce:animate-none')}
            />
            {searching ? 'Buscando…' : 'Buscar de nuevo'}
          </button>
        ) : offerMore ? (
          // `aria-disabled` y no `disabled`, como "Buscar hoteles": el foco se queda en el botón
          // mientras llega el tramo, y un segundo clic no pide otro encima.
          <button
            type="button"
            aria-disabled={!canLoadMore(more) || undefined}
            aria-describedby={titleId}
            onFocus={() => {
              actionFocused.current = true;
            }}
            onBlur={() => {
              actionFocused.current = false;
            }}
            onClick={() => {
              if (canLoadMore(more)) onLoadMore();
            }}
            className={PRIMARY_BUTTON}
          >
            <SearchButtonLabel searching={loading}>
              {more.status === 'error' ? 'Reintentar' : 'Ver más hoteles'}
            </SearchButtonLabel>
          </button>
        ) : null}
      </div>
    </section>
  );
}
