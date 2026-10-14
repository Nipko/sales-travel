'use client';

import { Armchair, Check, DoorOpen, RefreshCw, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '../../../../components/ui/button';
import { FormSheet } from '../../../../components/ui/form-sheet';
import { TestContentNotice } from '../../../../components/test-content-badge';
import { cn } from '../../../../lib/cn';
import { formatMoney } from '../../../../lib/flight-format';
import type { Offer } from '../actions';
import {
  initialPosition,
  moveInGrid,
  readSeatMapResponse,
  seatChoicesProblem,
  seatGrids,
  seatTabs,
  tabKey,
  toggleSeat,
  type GridPosition,
  type SeatCell,
  type SeatChoice,
  type SeatGrid,
  type SeatMapResponseView,
  type SeatPassenger,
  type SeatTab,
} from './seat-map-view';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly data: SeatMapResponseView; readonly tabs: SeatTab[] };

/**
 * Elegir asientos en el checkout (SAB-16): el panel lateral, a pantalla completa en el teléfono.
 *
 * Pestañas por tramo (y por avión si cambia de equipo), un chip por pasajero con asiento y la grilla
 * del avión. La grilla es un `grid` de WAI-ARIA con foco itinerante: Tab entra y sale, las flechas
 * mueven, Inicio/Fin van al borde de la fila y Enter o Espacio eligen. Cada asiento dice en voz alta
 * su número, sus características y su estado; en pantalla, el estado lleva una marca además del
 * color. Lo que decide cada celda vive en `seat-map-view.ts`, con sus tests.
 *
 * El mapa se lee al abrir. Guardar no reserva nada: los asientos viajan con la reserva, y el
 * servidor vuelve a leer el mapa justo antes de mandarla.
 */
export function SeatMapSheet({
  offer,
  searchCriteria,
  passengers,
  initialChoices,
  onClose,
  onSave,
}: {
  offer: Offer;
  searchCriteria: unknown;
  passengers: readonly SeatPassenger[];
  initialChoices: readonly SeatChoice[];
  onClose: () => void;
  onSave: (choices: SeatChoice[], tabs: SeatTab[]) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<SeatChoice[]>(() => [...initialChoices]);
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);
  const [activePassenger, setActivePassenger] = useState<number>(passengers[0]?.index ?? 0);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: 'loading' });
    fetch('/api/search/seat-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer, searchCriteria }),
      signal: controller.signal,
    })
      .then((res) => readSeatMapResponse(res))
      .then((read) => {
        if (controller.signal.aborted) return;
        if (!read.ok) {
          setLoad({ kind: 'error', message: read.message });
          return;
        }
        const tabs = seatTabs(read.data.seatMap, offer);
        setLoad({ kind: 'ready', data: read.data, tabs });
        setActiveTab((current) => current ?? tabs[0]?.key);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoad({
          kind: 'error',
          message: 'No se pudo conectar para leer el mapa de asientos. Inténtalo de nuevo.',
        });
      });
    return () => controller.abort();
  }, [offer, searchCriteria, attempt]);

  const dirty =
    choices.length !== initialChoices.length ||
    choices.some(
      (choice) =>
        !initialChoices.some(
          (initial) =>
            initial.passengerIndex === choice.passengerIndex &&
            initial.segmentRef === choice.segmentRef &&
            initial.legIndex === choice.legIndex &&
            initial.row === choice.row &&
            initial.column === choice.column,
        ),
    );

  function save() {
    if (load.kind !== 'ready') {
      onClose();
      return;
    }
    const found = seatChoicesProblem(choices, load.data.seatMap, passengers);
    if (found !== undefined) {
      setProblem(found);
      return;
    }
    onSave(choices, load.tabs);
  }

  const statusId = useId();

  return (
    <FormSheet
      title="Elegir asientos"
      subtitle="Opcional. Sólo se reservan asientos sin cargo."
      icon={<Armchair />}
      dirty={dirty}
      onClose={onClose}
      onSubmit={save}
      submitLabel="Guardar asientos"
      submitIcon={<Check aria-hidden="true" />}
      initialFocus='[role="tab"][aria-selected="true"]'
      describedBy={statusId}
      status={
        problem ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {problem}
          </p>
        ) : null
      }
    >
      <div id={statusId} aria-live="polite" className="sr-only">
        {load.kind === 'loading' ? 'Cargando el mapa de asientos.' : ''}
      </div>
      {load.kind === 'loading' ? <SeatMapSkeleton /> : null}
      {load.kind === 'error' ? (
        <div role="alert" className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
          <p className="text-sm text-[var(--color-fg)]">{load.message}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-2"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw aria-hidden="true" className="size-4" /> Reintentar
          </Button>
        </div>
      ) : null}
      {load.kind === 'ready' ? (
        <SeatMapBody
          data={load.data}
          tabs={load.tabs}
          activeTab={activeTab ?? load.tabs[0]?.key}
          onTab={setActiveTab}
          passengers={passengers}
          activePassenger={activePassenger}
          onPassenger={setActivePassenger}
          choices={choices}
          onChoices={(next) => {
            setProblem(null);
            setChoices(next);
          }}
        />
      ) : null}
    </FormSheet>
  );
}

function SeatMapSkeleton() {
  return (
    <div className="animate-pulse space-y-3 pt-2" aria-hidden="true">
      <div className="h-9 w-2/3 rounded-lg bg-[var(--color-surface-muted)]" />
      <div className="h-8 w-1/2 rounded-full bg-[var(--color-surface-muted)]" />
      <div className="h-64 rounded-xl bg-[var(--color-surface-muted)]" />
    </div>
  );
}

function SeatMapBody({
  data,
  tabs,
  activeTab,
  onTab,
  passengers,
  activePassenger,
  onPassenger,
  choices,
  onChoices,
}: {
  data: SeatMapResponseView;
  tabs: readonly SeatTab[];
  activeTab: string | undefined;
  onTab: (key: string) => void;
  passengers: readonly SeatPassenger[];
  activePassenger: number;
  onPassenger: (index: number) => void;
  choices: SeatChoice[];
  onChoices: (next: SeatChoice[]) => void;
}) {
  const tab = tabs.find((candidate) => candidate.key === activeTab) ?? tabs[0];
  const segment = data.seatMap.segments.find(
    (candidate) =>
      tab !== undefined && tabKey(candidate.segmentRef, candidate.legIndex) === tab.key,
  );
  const passenger = passengers.find((p) => p.index === activePassenger) ?? passengers[0];
  const panelId = useId();

  if (tab === undefined || segment === undefined || passenger === undefined) {
    return (
      <p className="pt-2 text-sm text-[var(--color-fg-muted)]">
        La aerolínea no devolvió asientos para este vuelo. Puedes reservar sin asiento.
      </p>
    );
  }

  const grids = seatGrids({ segment, passenger, passengers, choices, formatMoney });
  const seatOf = (index: number) =>
    choices.find(
      (c) =>
        c.passengerIndex === index &&
        c.segmentRef === tab.segmentRef &&
        c.legIndex === tab.legIndex,
    );

  return (
    <div className="space-y-4 pt-1">
      {data.testContent ? (
        <TestContentNotice>
          Mapa de la cuenta de pruebas del proveedor: no es el de un vuelo que se venda.
        </TestContentNotice>
      ) : null}

      {tabs.length > 1 ? (
        <div
          role="tablist"
          aria-label="Tramos del viaje"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
          onKeyDown={(event) => {
            const index = tabs.findIndex((t) => t.key === tab.key);
            const next =
              event.key === 'ArrowRight'
                ? tabs[Math.min(tabs.length - 1, index + 1)]
                : event.key === 'ArrowLeft'
                  ? tabs[Math.max(0, index - 1)]
                  : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onTab(next.key);
            requestAnimationFrame(() =>
              document.getElementById(`${panelId}-tab-${next.key}`)?.focus(),
            );
          }}
        >
          {tabs.map((candidate) => {
            const selected = candidate.key === tab.key;
            return (
              <button
                key={candidate.key}
                id={`${panelId}-tab-${candidate.key}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${panelId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTab(candidate.key)}
                className={cn(
                  'h-9 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
                  selected
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-fg)]'
                    : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
                )}
              >
                {candidate.label}
              </button>
            );
          })}
        </div>
      ) : (
        // Una sola pestaña no es un tablist: el tramo se nombra y ya.
        <p className="text-sm font-medium text-[var(--color-fg)]">{tab.label}</p>
      )}

      <div
        id={`${panelId}-panel`}
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        className="space-y-4"
      >
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-[var(--color-fg-muted)]">
            ¿Para quién eliges?
          </legend>
          <div role="radiogroup" aria-label="Pasajero" className="flex flex-wrap gap-2">
            {passengers.map((p) => {
              const checked = p.index === passenger.index;
              const chosen = seatOf(p.index);
              return (
                <button
                  key={p.index}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => onPassenger(p.index)}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
                    checked
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                      : 'border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
                  )}
                >
                  {p.label}
                  <span className={cn('font-mono', checked ? '' : 'text-[var(--color-fg-muted)]')}>
                    {chosen ? `${String(chosen.row)}${chosen.column}` : 'sin asiento'}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {segment.displayOnly ? (
          <p
            role="note"
            className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg)]"
          >
            La aerolínea no deja elegir asiento en este tramo desde aquí. El mapa es sólo para ver.
          </p>
        ) : (
          <p className="text-xs text-[var(--color-fg-muted)]">
            Sólo puedes elegir asientos sin cargo. Los de cargo se ven con el precio de la
            aerolínea.
          </p>
        )}

        <SeatLegend />

        {grids.map((grid, index) => (
          <SeatGridView
            key={`${tab.key}-${String(index)}`}
            grid={grid}
            label={`Asientos de ${tab.label}${grid.cabin ? `, cabina ${cabinName(grid.cabin)}` : ''}, para ${passenger.label}`}
            onSelect={(cell) =>
              onChoices(
                toggleSeat(
                  choices,
                  cell,
                  { segmentRef: tab.segmentRef, legIndex: tab.legIndex },
                  passenger.index,
                ),
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

const CABIN_NAMES: Readonly<Record<string, string>> = {
  economy: 'económica',
  premium_economy: 'económica premium',
  business: 'ejecutiva',
  first: 'primera',
};

function cabinName(cabin: string): string {
  return CABIN_NAMES[cabin] ?? cabin;
}

/** Cada estado con su marca: nada se distingue sólo por el color. */
function SeatLegend() {
  const items: { label: string; swatch: string; mark: ReactNode }[] = [
    { label: 'Disponible', swatch: SEAT_STYLE.free, mark: null },
    { label: 'Elegido', swatch: SEAT_STYLE.selected, mark: <Check className="size-3" /> },
    { label: 'Ocupado', swatch: SEAT_STYLE.occupied, mark: <X className="size-3" /> },
    { label: 'Con cargo', swatch: SEAT_STYLE.paid, mark: '$' },
    {
      label: 'Salida de emergencia',
      swatch: SEAT_STYLE.free,
      mark: <DoorOpen className="size-3" />,
    },
  ];
  return (
    <ul
      aria-label="Leyenda"
      className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--color-fg-muted)]"
    >
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-5 items-center justify-center rounded border text-[10px] font-semibold',
              item.swatch,
            )}
          >
            {item.mark}
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

const SEAT_STYLE = {
  free: 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-fg)]',
  selected:
    'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]',
  occupied:
    'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
  paid: 'border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
} as const;

function cellStyle(cell: SeatCell): string {
  switch (cell.state) {
    case 'selected':
      return SEAT_STYLE.selected;
    case 'free':
      return cn(
        SEAT_STYLE.free,
        'hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/10',
      );
    case 'paid':
      return SEAT_STYLE.paid;
    default:
      return SEAT_STYLE.occupied;
  }
}

function cellMark(cell: SeatCell): ReactNode {
  switch (cell.state) {
    case 'selected':
      return <Check aria-hidden="true" className="size-4" />;
    case 'free':
      return cell.column;
    case 'paid':
      return '$';
    default:
      return <X aria-hidden="true" className="size-3.5" />;
  }
}

/**
 * Una cabina como `grid` de WAI-ARIA. Foco itinerante: sólo una celda está en el orden de Tab; las
 * flechas lo mueven (saltando los huecos del avión) y Enter o Espacio eligen. Los asientos que no se
 * pueden elegir también reciben el foco: el lector tiene que poder oír por qué.
 */
export function SeatGridView({
  grid,
  label,
  onSelect,
}: {
  grid: SeatGrid;
  label: string;
  onSelect: (cell: SeatCell) => void;
}) {
  const [focus, setFocus] = useState<GridPosition | undefined>(() => initialPosition(grid));
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const key = (p: GridPosition) => `${String(p.row)}:${String(p.col)}`;
  const aisle = useMemo(() => new Set(grid.aisleAfter), [grid.aisleAfter]);

  const current = focus ?? initialPosition(grid);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (current === undefined) return;
      if (event.key === 'Enter' || event.key === ' ') {
        const cell = grid.rows[current.row]?.cells[current.col];
        if (cell?.kind === 'seat') {
          event.preventDefault();
          onSelect(cell);
        }
        return;
      }
      const next = moveInGrid(grid, current, event.key);
      if (next === current) {
        if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      setFocus(next);
      refs.current.get(key(next))?.focus();
    },
    [current, grid, onSelect],
  );

  return (
    <div className="overflow-x-auto overscroll-x-contain pb-1">
      <div
        role="grid"
        aria-label={label}
        aria-rowcount={grid.rows.length + 1}
        aria-colcount={grid.columns.length + 1}
        onKeyDown={onKeyDown}
        className="mx-auto w-max space-y-1.5"
      >
        <div role="row" className="flex items-center gap-1.5">
          <span
            role="columnheader"
            className="w-9 text-center text-[10px] text-[var(--color-fg-subtle)]"
          >
            <span className="sr-only">Fila</span>
          </span>
          {grid.columns.map((column) => (
            <span
              key={column}
              role="columnheader"
              className={cn(
                'w-9 text-center text-xs font-medium text-[var(--color-fg-muted)] sm:w-10',
                aisle.has(column) && 'mr-4',
              )}
            >
              {column}
            </span>
          ))}
        </div>
        {grid.rows.map((row, rowIndex) => (
          <div key={row.number} role="row" className="flex items-center gap-1.5">
            <span
              role="rowheader"
              className="inline-flex w-9 items-center justify-center gap-0.5 text-xs tabular-nums text-[var(--color-fg-muted)]"
            >
              {row.exit ? (
                <DoorOpen aria-hidden="true" className="size-3 text-[var(--color-fg-subtle)]" />
              ) : null}
              {row.number}
              {row.exit ? <span className="sr-only">, salida de emergencia</span> : null}
            </span>
            {row.cells.map((cell, colIndex) => {
              const spacing = cn(aisle.has(cell.column) && 'mr-4');
              if (cell.kind === 'gap') {
                return (
                  <span
                    key={cell.column}
                    role="gridcell"
                    className={cn('size-9 sm:size-10', spacing)}
                  >
                    <span className="sr-only">Sin asiento</span>
                  </span>
                );
              }
              const position = { row: rowIndex, col: colIndex };
              const focused =
                current !== undefined && current.row === rowIndex && current.col === colIndex;
              return (
                <span
                  key={cell.column}
                  role="gridcell"
                  aria-selected={cell.state === 'selected'}
                  className={spacing}
                >
                  <button
                    ref={(node) => {
                      if (node) refs.current.set(key(position), node);
                      else refs.current.delete(key(position));
                    }}
                    type="button"
                    tabIndex={focused ? 0 : -1}
                    aria-label={cell.label}
                    aria-disabled={!cell.selectable || undefined}
                    title={cell.price ?? undefined}
                    onFocus={() => setFocus(position)}
                    onClick={() => onSelect(cell)}
                    className={cn(
                      'relative inline-flex size-9 items-center justify-center rounded-md border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 sm:size-10',
                      cellStyle(cell),
                      cell.selectable ? 'cursor-pointer' : 'cursor-not-allowed',
                      cell.exit && 'ring-1 ring-inset ring-[var(--color-warning)]',
                    )}
                  >
                    {cellMark(cell)}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
