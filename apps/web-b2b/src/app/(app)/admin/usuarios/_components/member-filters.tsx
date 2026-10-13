'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type Ref } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Checkbox } from '../../../../../components/ui/field';
import { cn } from '../../../../../lib/cn';
import {
  DEFAULT_TEAM_FILTERS,
  TEAM_CHIPS,
  TEAM_SORTS,
  hasActiveFilters,
  nextSort,
  parseTeamFilters,
  queryWithTeamFilters,
  type TeamChip,
  type TeamFilters,
  type TeamSort,
} from '../../../../../lib/team-filters';
import { offeredRoleLabel } from './roles';

/** Espera antes de escribir la URL: Safari corta más de 100 `replaceState` en 30 s. */
const URL_WRITE_DELAY_MS = 300;

/**
 * Los filtros de Equipo, leídos de la URL al montar y escritos de vuelta en cada cambio, sin tocar
 * los demás parámetros (`?tenant=`). Hasta leer la URL valen los de por defecto y no se escribe nada:
 * escribirlos borraría los del enlace antes de leerlos.
 */
export function useTeamFilters(): [TeamFilters, (next: TeamFilters) => void] {
  const [filters, setFilters] = useState<TeamFilters | null>(null);

  useEffect(() => {
    setFilters(parseTeamFilters(window.location.search));
  }, []);

  useEffect(() => {
    if (filters === null) return;
    const id = window.setTimeout(() => {
      const { pathname, search, hash } = window.location;
      const query = queryWithTeamFilters(search, filters);
      if (query === search || (query === '' && search === '')) return;
      try {
        // `null`: el router de Next conserva su propio estado.
        window.history.replaceState(null, '', `${pathname}${query}${hash}`);
      } catch {
        // El navegador limitó los cambios de URL: los filtros siguen andando, sólo no se recuerdan.
      }
    }, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [filters]);

  const update = useCallback((next: TeamFilters) => setFilters(next), []);
  return [filters ?? DEFAULT_TEAM_FILTERS, update];
}

const CHIP =
  'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]';

const CHIP_ON = 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-fg)]';

const CHIP_OFF =
  'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]';

const SELECT =
  'h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

function Chip({
  pressed,
  onClick,
  buttonRef,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(CHIP, pressed ? CHIP_ON : CHIP_OFF)}
    >
      {children}
    </button>
  );
}

/**
 * La barra de filtros de la lista de miembros: los filtros rápidos con cuántos deja cada uno, el
 * rol, ocultar los suspendidos y, en el teléfono (donde no hay encabezado de columnas), el orden.
 *
 * `allRef`: el botón "Todos", adonde vuelve el foco al quitar los filtros (el botón que se tocó
 * desaparece con ellos).
 */
export function MemberFilters({
  filters,
  counts,
  roles,
  suspendedCount,
  allRef,
  onChange,
  onClear,
}: {
  filters: TeamFilters;
  counts: Readonly<Record<TeamChip, number>>;
  /** Los roles del selector, ya ordenados (`roleOptions`). */
  roles: readonly string[];
  suspendedCount: number;
  allRef?: Ref<HTMLButtonElement> | undefined;
  onChange: (next: TeamFilters) => void;
  /** "Quitar filtros": la lista decide adónde va el foco cuando el botón desaparece. */
  onClear: () => void;
}) {
  const roleId = useId();
  const hideId = useId();
  const sortId = useId();
  const toggleChip = (chip: TeamChip) =>
    onChange({ ...filters, chip: filters.chip === chip ? null : chip });

  return (
    <div className="space-y-2 border-b border-[var(--color-border)] px-4 py-2 md:space-y-3 md:py-3">
      {/*
       * En el teléfono las chips van en una fila que se desliza de lado, como las clases de Autos: en
       * tres renglones empujaban la lista fuera de la pantalla. `relative`, para que nada de adentro
       * corra la página de costado; `py-1`, para que el anillo de foco no quede cortado por el scroll.
       */}
      <div
        className="relative -mx-4 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:py-0"
        role="group"
        aria-label="Filtrar miembros"
      >
        <Chip
          pressed={filters.chip === null}
          onClick={() => onChange({ ...filters, chip: null })}
          buttonRef={allRef}
        >
          Todos
        </Chip>
        {TEAM_CHIPS.map((chip) => (
          <Chip
            key={chip.id}
            pressed={filters.chip === chip.id}
            onClick={() => toggleChip(chip.id)}
          >
            {chip.label} ({counts[chip.id]})
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={roleId} className="sr-only">
          Filtrar por rol
        </label>
        <select
          id={roleId}
          value={filters.role ?? ''}
          onChange={(e) => onChange({ ...filters, role: e.target.value || null })}
          className={cn(SELECT, 'max-w-[220px]')}
        >
          <option value="">Todos los roles</option>
          {roles.map((role) => (
            <option key={role} value={role}>
              {offeredRoleLabel(role)}
            </option>
          ))}
        </select>

        <label
          htmlFor={hideId}
          className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-xs font-medium text-[var(--color-fg)]"
        >
          <Checkbox
            id={hideId}
            checked={filters.hideSuspended}
            onChange={(e) => onChange({ ...filters, hideSuspended: e.target.checked })}
            className="shrink-0"
          />
          Ocultar suspendidos{suspendedCount > 0 ? ` (${suspendedCount})` : ''}
        </label>

        <div className="flex items-center gap-2 md:hidden">
          <label htmlFor={sortId} className="text-xs font-medium text-[var(--color-fg-muted)]">
            Ordenar por
          </label>
          <select
            id={sortId}
            value={filters.sort}
            onChange={(e) =>
              onChange({
                ...filters,
                sort: TEAM_SORTS.find((s) => s.id === e.target.value)?.id ?? 'default',
              })
            }
            className={cn(SELECT, 'max-w-[240px]')}
          >
            {TEAM_SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {hasActiveFilters(filters) ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X aria-hidden="true" />
            Quitar filtros
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const SORT_STATE: Readonly<Record<TeamSort, string>> = {
  default: 'sin ordenar',
  'last-access-desc': 'más reciente primero',
  'last-access-asc': 'más antiguo primero',
};

const SORT_ICON: Readonly<Record<TeamSort, typeof ArrowDown>> = {
  default: ArrowUpDown,
  'last-access-desc': ArrowDown,
  'last-access-asc': ArrowUp,
};

/**
 * El encabezado "Último acceso" en pantalla ancha: ordena la lista y, al tocarlo de nuevo, invierte
 * el orden; la tercera vez vuelve al de alta. La lista no es una tabla (en el teléfono cada miembro es
 * una tarjeta), así que el orden actual no va en `aria-sort`, que sólo vale en un encabezado de
 * tabla: lo dice el nombre del botón.
 */
export function LastAccessSortButton({
  sort,
  onChange,
}: {
  sort: TeamSort;
  onChange: (next: TeamSort) => void;
}) {
  const Icon = SORT_ICON[sort];
  return (
    <button
      type="button"
      onClick={() => onChange(nextSort(sort))}
      title="Ordenar por último acceso"
      className={cn(
        '-mx-1 inline-flex items-center gap-1 rounded px-1 text-left font-semibold transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
        sort !== 'default' && 'text-[var(--color-fg)]',
      )}
    >
      Último acceso
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">, {SORT_STATE[sort]}</span>
    </button>
  );
}
