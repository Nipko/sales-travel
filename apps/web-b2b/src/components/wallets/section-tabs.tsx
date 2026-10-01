'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SectionTab<K extends string> {
  readonly id: K;
  readonly label: string;
  /** La etiqueta en el móvil, si la completa no entra junto a las demás. */
  readonly shortLabel?: string;
  /** Un contador junto a la etiqueta (p. ej. los depósitos pendientes). Se lee también en voz. */
  readonly count?: number;
  readonly countLabel?: string;
}

/**
 * Pestañas con el patrón de WAI-ARIA: flechas para moverse, Inicio y Fin, y sólo la pestaña activa
 * en el orden de tabulación. El panel se renderiza aparte con {@link SectionTabPanel}.
 */
export function SectionTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: readonly SectionTab<K>[];
  value: K;
  onChange: (id: K) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Map<K, HTMLButtonElement>>(new Map());

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    e.preventDefault();
    const tab = tabs[next];
    if (tab === undefined) return;
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      // Si aun así no entran, se desplazan de lado sin barra: la pestaña cortada en el borde dice
      // que hay más. `relative`, para que el `sr-only` del contador de una pestaña que no entra
      // se recorte acá y no haga correr de lado la página entera.
      className="relative flex gap-4 overflow-x-auto border-b border-[var(--color-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) refs.current.set(tab.id, el);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
              selected
                ? 'border-[var(--color-primary)] text-[var(--color-fg)]'
                : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            {tab.shortLabel === undefined ? (
              tab.label
            ) : (
              <>
                <span className="sm:hidden">{tab.shortLabel}</span>
                <span className="hidden sm:inline">{tab.label}</span>
              </>
            )}
            {tab.count !== undefined && tab.count > 0 ? (
              <span className="rounded-full bg-[var(--color-warning)]/25 px-1.5 text-[11px] font-semibold tabular-nums text-[var(--color-fg)]">
                {tab.count}
                {tab.countLabel !== undefined ? (
                  <span className="sr-only"> {tab.countLabel}</span>
                ) : null}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function SectionTabPanel<K extends string>({
  id,
  idPrefix,
  hidden,
  children,
}: {
  id: K;
  idPrefix: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      hidden={hidden}
      tabIndex={0}
      // El panel entra en el orden de tabulación: su foco tiene que verse (WCAG 2.4.7).
      className="mt-4 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
    >
      {hidden ? null : children}
    </div>
  );
}

/** Un prefijo de ids estable para un grupo de pestañas. */
export function useTabsId(): string {
  return useId().replace(/:/g, '');
}
