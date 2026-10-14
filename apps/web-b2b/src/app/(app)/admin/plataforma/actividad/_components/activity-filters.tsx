'use client';

import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Select, TextInput } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import {
  ACTIVITY_CATEGORY_CHIPS,
  ACTIVITY_PRESETS,
  EMAIL_MAX,
  activePreset,
  activeFilterCount,
  clearedFilters,
  effectivePeriod,
  withDate,
  withPreset,
  type ActivityFilters as Filters,
} from '../../../../../../lib/platform-audit';
import { PLATFORM_TIME_ZONE, todayIn } from '../../../../../../lib/platform-overview';
import type { NodeOption } from '../../../../../../lib/platform-orders';

/** Los nodos para el selector: se leen aparte y la actividad funciona aunque no lleguen. */
export type ActivityNodesState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly options: readonly NodeOption[] };

const LABEL = 'block text-xs font-medium text-[var(--color-fg-muted)]';

/**
 * Las categorías: "Todo" y una por familia de eventos. Van siempre a la vista (también en el
 * teléfono, con scroll lateral): son el primer corte de una investigación.
 */
export function ActivityCategoryChips({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Categoría de los eventos"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
    >
      {ACTIVITY_CATEGORY_CHIPS.map((chip) => (
        <Chip
          key={chip.label}
          pressed={filters.category === chip.id}
          onClick={() => onChange({ ...filters, category: chip.id })}
        >
          {chip.label}
        </Chip>
      ))}
    </div>
  );
}

/**
 * Los filtros de la Actividad: de qué nodo, quién actuó y cuándo, más los que llegan desde el detalle
 * de un evento (un tipo, una entidad), que se quitan con su ×. Sin estado propio salvo el correo,
 * que se escribe aparte (`email`) y se aplica cuando está completo. En el escritorio van arriba de la
 * lista; en el teléfono, dentro de la hoja de filtros (`layout="sheet"`).
 */
export function ActivityFilters({
  filters,
  onChange,
  email,
  onEmailChange,
  nodes,
  now,
  layout = 'inline',
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  email: string;
  onEmailChange: (value: string) => void;
  nodes: ActivityNodesState;
  now: Date;
  layout?: 'inline' | 'sheet';
}) {
  const id = useId();
  const stacked = layout === 'sheet';
  const today = todayIn(PLATFORM_TIME_ZONE, now);
  const period = effectivePeriod(filters, now);
  const preset = activePreset(filters, now);
  const options = nodes.status === 'ready' ? nodes.options : [];
  const scopedNodeMissing =
    filters.tenantId !== null && !options.some((n) => n.id === filters.tenantId);

  return (
    <div className="space-y-4">
      <div className={cn('grid gap-3', stacked ? 'grid-cols-1' : 'sm:grid-cols-2')}>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-node`} className={LABEL}>
            Nodo
          </label>
          <Select
            id={`${id}-node`}
            value={filters.tenantId ?? ''}
            disabled={nodes.status === 'loading'}
            aria-describedby={nodes.status === 'error' ? `${id}-node-error` : `${id}-node-hint`}
            onChange={(e) => onChange({ ...filters, tenantId: e.target.value || null })}
          >
            <option value="">
              {nodes.status === 'loading' ? 'Cargando la red…' : 'Toda la plataforma'}
            </option>
            {scopedNodeMissing ? (
              <option value={filters.tenantId ?? ''}>Nodo seleccionado</option>
            ) : null}
            {options.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </Select>
          {nodes.status === 'error' ? (
            <p id={`${id}-node-error`} className="text-xs text-[var(--color-fg-muted)]">
              No pudimos cargar la lista de nodos. Puedes mirar toda la plataforma.
            </p>
          ) : (
            <p id={`${id}-node-hint`} className="text-xs text-[var(--color-fg-muted)]">
              {filters.tenantId === null
                ? 'Con los eventos sin nodo, como un ingreso fallido.'
                : 'El nodo y todo lo que cuelga de él.'}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`${id}-actor`} className={LABEL}>
            Correo de quien actuó
          </label>
          <TextInput
            id={`${id}-actor`}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            maxLength={EMAIL_MAX}
            placeholder="nombre@agencia.com"
            aria-describedby={`${id}-actor-hint`}
            onChange={(e) => onEmailChange(e.target.value)}
          />
          <p id={`${id}-actor-hint`} className="text-xs text-[var(--color-fg-muted)]">
            El correo completo. No queda en la dirección de la página.
          </p>
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
              value={period.from}
              max={today}
              onChange={(e) => onChange(withDate(filters, 'from', e.target.value, now))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-to`} className={LABEL}>
              Hasta
            </label>
            <TextInput
              id={`${id}-to`}
              type="date"
              value={period.to}
              min={period.from}
              max={today}
              onChange={(e) => onChange(withDate(filters, 'to', e.target.value, now))}
            />
          </div>
        </div>
        <div
          role="group"
          aria-label="Fechas rápidas"
          className="flex flex-wrap items-center gap-1.5"
        >
          {ACTIVITY_PRESETS.map((p) => (
            <Chip
              key={p.value}
              pressed={preset === p.value}
              onClick={() => onChange(withPreset(filters, p.value, now))}
            >
              {p.label}
            </Chip>
          ))}
        </div>
        {!stacked && activeFilterCount(filters) > 0 ? (
          <button
            type="button"
            onClick={() => {
              onEmailChange('');
              onChange(clearedFilters());
            }}
            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] sm:ml-auto"
          >
            Limpiar filtros
          </button>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-fg-muted)]">
        Hasta 92 días por vez, en hora de Bogotá.
      </p>
    </div>
  );
}

/**
 * Los filtros que llegan desde el detalle de un evento o desde la ficha de una reserva: un tipo
 * exacto y una entidad. Se ven como pastillas con su × para quitarlos.
 */
export function PinnedFilters({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  if (filters.eventType === null && filters.aggregateType === null) return null;
  return (
    <ul aria-label="Filtros desde un evento" className="flex flex-wrap gap-1.5">
      {filters.eventType !== null ? (
        <Pinned
          label="Tipo"
          value={filters.eventType}
          onRemove={() => onChange({ ...filters, eventType: null })}
        />
      ) : null}
      {filters.aggregateType !== null && filters.aggregateId !== null ? (
        <Pinned
          label="Entidad"
          value={`${filters.aggregateType} · ${filters.aggregateId}`}
          onRemove={() => onChange({ ...filters, aggregateType: null, aggregateId: null })}
        />
      ) : null}
    </ul>
  );
}

function Pinned({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <li className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] py-0.5 pl-2 pr-0.5 text-xs text-[var(--color-fg)]">
      <span className="shrink-0 text-[var(--color-fg-muted)]">{label}:</span>
      <code className="min-w-0 truncate font-mono text-[11px]">{value}</code>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Quitar el filtro ${label.toLowerCase()}: ${value}`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}

/** Un filtro que se prende y se apaga. `aria-pressed` dice si está puesto: el color sólo lo acompaña. */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
        pressed
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]',
      )}
    >
      {children}
    </button>
  );
}
