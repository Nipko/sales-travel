import type { ReactNode } from 'react';
import { ScrollFade } from './scroll-fade';

/*
 * Los filtros de una pantalla de resultados en pantallas anchas (hoteles, autos): la columna a la
 * izquierda de la lista, pegada arriba mientras la lista corre. Debajo de `xl` no se muestra: los
 * filtros van en la hoja de `filters-sheet`.
 *
 * El título y "Limpiar" quedan fijos arriba; sólo las opciones scrollean, y sólo si no entran en
 * el alto que queda: el de la ventana menos la barra de arriba, el `top-4` del pegado y el
 * relleno de abajo de la página (`sm:p-6`), para que la columna termine a la par de la lista.
 */

/**
 * La grilla de la pantalla de resultados: esta columna y la lista. La usan la lista y su
 * esqueleto (`search-loading`), para que al llegar no salte nada.
 *
 * 16rem y no 15: con la carga por tramos los conteos pasan de 100, y "Solo reembolsables" con un
 * conteo de tres cifras al lado de la barra de scroll partía el renglón en dos.
 */
export const RESULTS_GRID = 'xl:grid xl:grid-cols-[16rem_minmax(0,1fr)] xl:items-start xl:gap-6';

export function FiltersAside({
  headerAction,
  children,
}: {
  /** A la derecha del título: el "Limpiar (n)" de la pantalla. */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Filtros"
      className="hidden flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100dvh-var(--app-topbar-height)-2.5rem)]"
    >
      {/* Alto fijo: "Limpiar" aparece y desaparece y la columna no tiene que saltar. */}
      <div className="box-content flex h-6 shrink-0 items-center justify-between gap-2 px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Filtros</h2>
        {headerAction}
      </div>
      <ScrollFade className="min-h-0 flex-1" contentClassName="px-4 pb-4">
        {children}
      </ScrollFade>
    </aside>
  );
}
