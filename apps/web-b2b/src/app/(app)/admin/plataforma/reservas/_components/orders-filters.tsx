'use client';

import { TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Checkbox, Select, TextInput } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import { PLATFORM_TIME_ZONE, todayIn } from '../../../../../../lib/platform-overview';
import {
  ATTENTION_CHIP_LABEL,
  DATE_PRESETS,
  STATUS_CHIPS,
  VERTICAL_OPTIONS,
  activeFilterCount,
  activePreset,
  clearedFilters,
  providerOptions,
  toggleStatus,
  withDate,
  withPreset,
  type NodeOption,
  type OrdersFilters,
} from '../../../../../../lib/platform-orders';

/** Los nodos para el selector: se leen aparte y la lista funciona aunque no lleguen. */
export type NodeOptionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly options: readonly NodeOption[] };

const LABEL = 'block text-xs font-medium text-[var(--color-fg-muted)]';

/**
 * Los filtros de Reservas de la red: los chips de estado, de qué es la reserva, de qué nodo y de
 * cuándo. Sin estado propio: cada cambio sale entero por `onChange`. En el escritorio van arriba de
 * la lista; en el teléfono, dentro de la hoja de filtros (`layout="sheet"`, una columna).
 */
export function OrdersFilters({
  filters,
  onChange,
  nodes,
  now,
  layout = 'inline',
}: {
  filters: OrdersFilters;
  onChange: (next: OrdersFilters) => void;
  nodes: NodeOptionsState;
  now: Date;
  layout?: 'inline' | 'sheet';
}) {
  const id = useId();
  const stacked = layout === 'sheet';
  const today = todayIn(PLATFORM_TIME_ZONE, now);
  const preset = activePreset(filters, now);
  const nodeOptions = nodes.status === 'ready' ? nodes.options : [];
  const scopedNodeMissing =
    filters.tenantId !== null && !nodeOptions.some((n) => n.id === filters.tenantId);

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Estado de las reservas" className="flex flex-wrap gap-1.5">
        <Chip
          pressed={filters.attention}
          tone="attention"
          onClick={() => onChange({ ...filters, attention: !filters.attention })}
        >
          <TriangleAlert aria-hidden="true" className="size-3.5" />
          {ATTENTION_CHIP_LABEL}
        </Chip>
        <span
          aria-hidden="true"
          className="mx-0.5 hidden w-px self-stretch bg-[var(--color-border)] sm:block"
        />
        {STATUS_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            pressed={filters.statuses.includes(chip.value)}
            onClick={() => onChange(toggleStatus(filters, chip.value))}
          >
            {chip.label}
          </Chip>
        ))}
      </div>

      <div
        className={cn(
          'grid gap-3',
          stacked ? 'grid-cols-1' : 'sm:grid-cols-2 lg:grid-cols-[1fr_1fr_minmax(0,1.6fr)]',
        )}
      >
        <div className="space-y-1.5">
          <label htmlFor={`${id}-vertical`} className={LABEL}>
            Vertical
          </label>
          <Select
            id={`${id}-vertical`}
            value={filters.vertical ?? ''}
            onChange={(e) => {
              const value = VERTICAL_OPTIONS.find((v) => v.value === e.target.value)?.value;
              onChange({ ...filters, vertical: value ?? null });
            }}
          >
            <option value="">Todas</option>
            {VERTICAL_OPTIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`${id}-provider`} className={LABEL}>
            Proveedor
          </label>
          <Select
            id={`${id}-provider`}
            value={filters.provider ?? ''}
            onChange={(e) => onChange({ ...filters, provider: e.target.value || null })}
          >
            <option value="">Todos</option>
            {providerOptions(filters.provider).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>

        <div className={cn('space-y-1.5', !stacked && 'sm:col-span-2 lg:col-span-1')}>
          <label htmlFor={`${id}-node`} className={LABEL}>
            Nodo
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              id={`${id}-node`}
              value={filters.tenantId ?? ''}
              disabled={nodes.status === 'loading'}
              aria-describedby={nodes.status === 'error' ? `${id}-node-error` : undefined}
              onChange={(e) =>
                onChange({ ...filters, tenantId: e.target.value || null, subtree: true })
              }
              className="min-w-0 sm:flex-1"
            >
              <option value="">
                {nodes.status === 'loading' ? 'Cargando la red…' : 'Toda la red'}
              </option>
              {scopedNodeMissing ? (
                <option value={filters.tenantId ?? ''}>Nodo seleccionado</option>
              ) : null}
              {nodeOptions.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </Select>
            <label
              className={cn(
                'flex shrink-0 items-center gap-2 text-xs',
                filters.tenantId === null
                  ? 'text-[var(--color-fg-subtle)]'
                  : 'text-[var(--color-fg)]',
              )}
            >
              <Checkbox
                checked={filters.subtree}
                disabled={filters.tenantId === null}
                onChange={(e) => onChange({ ...filters, subtree: e.target.checked })}
              />
              Incluir su red
            </label>
          </div>
          {nodes.status === 'error' ? (
            <p id={`${id}-node-error`} className="text-xs text-[var(--color-fg-muted)]">
              No pudimos cargar la lista de nodos. Puedes buscar en toda la red.
            </p>
          ) : null}
        </div>
      </div>

      <div className={cn('flex gap-3', stacked ? 'flex-col' : 'flex-wrap items-end')}>
        <div className={cn('grid grid-cols-2 gap-3', !stacked && 'sm:w-80')}>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-from`} className={LABEL}>
              Desde
            </label>
            <TextInput
              id={`${id}-from`}
              type="date"
              value={filters.from ?? ''}
              max={filters.to ?? today}
              onChange={(e) => onChange(withDate(filters, 'from', e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-to`} className={LABEL}>
              Hasta
            </label>
            <TextInput
              id={`${id}-to`}
              type="date"
              value={filters.to ?? ''}
              min={filters.from ?? undefined}
              max={today}
              onChange={(e) => onChange(withDate(filters, 'to', e.target.value))}
            />
          </div>
        </div>
        <div
          role="group"
          aria-label="Fechas rápidas"
          className="flex flex-wrap items-center gap-1.5"
        >
          {DATE_PRESETS.map((p) => (
            <Chip
              key={p.value}
              pressed={preset === p.value}
              onClick={() => onChange(withPreset(filters, p.value, now))}
            >
              {p.label}
            </Chip>
          ))}
          {filters.from !== null || filters.to !== null ? (
            <button
              type="button"
              onClick={() => onChange({ ...filters, from: null, to: null })}
              className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              Cualquier fecha
            </button>
          ) : null}
        </div>
        {!stacked && activeFilterCount(filters) > 0 ? (
          <button
            type="button"
            onClick={() => onChange(clearedFilters(filters))}
            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] sm:ml-auto"
          >
            Limpiar filtros
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Un filtro que se prende y se apaga. `aria-pressed` dice si está puesto: el color sólo lo acompaña.
 * El de "Requieren atención" usa el ámbar de lo que espera a una persona.
 */
function Chip({
  pressed,
  tone = 'default',
  onClick,
  children,
}: {
  pressed: boolean;
  tone?: 'default' | 'attention';
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
        pressed
          ? tone === 'attention'
            ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
            : 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]',
      )}
    >
      {children}
    </button>
  );
}
