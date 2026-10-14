'use client';

import { Download, History, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { FiltersSheet } from '../../../../../../components/ui/filters-sheet';
import { EmptyState, ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import { eventDetail, eventLabel } from '../../../../../../lib/audit-format';
import { cn } from '../../../../../../lib/cn';
import {
  ACTIVITY_EMPTY,
  ACTIVITY_EXPORT_NOTE,
  DEFAULT_ACTIVITY_FILTERS,
  activeFilterCount,
  activityActorLabel,
  activityHref,
  activityNodeLabel,
  actorEmailTerm,
  appendEvents,
  clearedFilters,
  exportDoneMessage,
  formatActivityDate,
  type ActivityEventView,
  type ActivityFilters as Filters,
  type ActivityPage,
} from '../../../../../../lib/platform-audit';
import {
  exportPlatformActivity,
  loadPlatformActivity,
  saveFile,
} from '../../../../../../lib/platform-audit-client';
import { nodeOptions } from '../../../../../../lib/platform-orders';
import { isStepUpCancelled } from '../../../../../../lib/step-up';
import { loadAdminNetwork } from '../../../../../../lib/tenant-admin-client';
import {
  ActivityCategoryChips,
  ActivityFilters,
  PinnedFilters,
  type ActivityNodesState,
} from './activity-filters';
import { EventDetailSheet, type EventDetailFilter } from './event-detail-sheet';

export type ActivityListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly data: ActivityPage;
      readonly more: 'idle' | 'loading' | { readonly error: string };
      readonly refreshing: boolean;
    };

/** Espera del correo: no se pide una página por cada tecla. */
const EMAIL_DEBOUNCE_MS = 400;

const subscribeNothing = () => () => undefined;

/**
 * Plataforma → Actividad: el founder investiga quién hizo qué, dónde y cuándo, en toda la plataforma.
 * Filtra por categoría, nodo, persona y fechas (hasta 92 días), abre el detalle de cada evento y
 * exporta lo que ve a CSV (hasta 5.000 eventos; pide el 2FA reciente y queda en la auditoría).
 *
 * Los filtros viven en la URL salvo el correo de quien actuó (es un dato personal). "Todo" no trae
 * los latidos del barrido de post-venta: están en "Sistema".
 */
export function ActivityPanel({
  initialFilters = DEFAULT_ACTIVITY_FILTERS,
}: {
  initialFilters?: Filters;
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [email, setEmail] = useState(initialFilters.actorEmail);
  const [list, setList] = useState<ActivityListState>({ status: 'loading' });
  const [nodes, setNodes] = useState<ActivityNodesState>({ status: 'loading' });
  const [selected, setSelected] = useState<ActivityEventView | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  /** El último pedido de la lista: una respuesta vieja (filtros de antes) no pisa la nueva. */
  const request = useRef(0);
  const showing = useRef(false);

  const load = useCallback(async (next: Filters, mode: 'initial' | 'refresh') => {
    const id = ++request.current;
    const at = new Date();
    setNow(at);
    setList((s) =>
      mode === 'refresh' && s.status === 'ready'
        ? { ...s, refreshing: true }
        : { status: 'loading' },
    );
    const page = await loadPlatformActivity(next, at);
    if (id !== request.current) return;
    if (page.ok) {
      showing.current = true;
      setList({ status: 'ready', data: page.data, more: 'idle', refreshing: false });
      return;
    }
    if (mode === 'refresh' && showing.current) {
      toast.error(`No pudimos actualizar la actividad: ${page.message}`);
      setList((s) =>
        s.status === 'ready'
          ? { ...s, refreshing: false, more: s.more === 'loading' ? 'idle' : s.more }
          : s,
      );
      return;
    }
    showing.current = false;
    setList({ status: 'error', message: page.message });
  }, []);

  useEffect(() => {
    void load(filters, 'initial');
  }, [filters, load]);

  // La red para el selector de nodo: se lee una vez; sin ella se mira toda la plataforma igual.
  useEffect(() => {
    let alive = true;
    void loadAdminNetwork().then((res) => {
      if (!alive) return;
      setNodes(res.ok ? { status: 'ready', options: nodeOptions(res.data) } : { status: 'error' });
    });
    return () => {
      alive = false;
    };
  }, []);

  // Los filtros a la URL sin recargar (sin el correo).
  useEffect(() => {
    const href = activityHref(filters);
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.replaceState(null, '', href);
    }
  }, [filters]);

  // El correo se aplica cuando está completo (o vacío), sin pedir una página por tecla.
  useEffect(() => {
    const term = email.trim() === '' ? '' : actorEmailTerm(email);
    if (term === null || term === filters.actorEmail) return;
    const timer = window.setTimeout(
      () => setFilters((f) => ({ ...f, actorEmail: term })),
      EMAIL_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [email, filters.actorEmail]);

  async function loadMore() {
    if (list.status !== 'ready' || list.data.nextCursor === null || list.more === 'loading') return;
    const id = request.current;
    const cursor = list.data.nextCursor;
    setList({ ...list, more: 'loading' });
    const res = await loadPlatformActivity(filters, now, cursor);
    if (id !== request.current) return;
    setList((s) => {
      if (s.status !== 'ready') return s;
      if (!res.ok) return { ...s, more: { error: res.message } };
      return {
        ...s,
        more: 'idle',
        data: {
          nextCursor: res.data.nextCursor,
          events: appendEvents(s.data.events, res.data.events),
        },
      };
    });
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    // Alto impacto: puede pedir el código del 2FA en el medio y repetirse (USR-13).
    const res = await exportPlatformActivity(filters, now);
    setExporting(false);
    if (isStepUpCancelled(res)) return;
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    saveFile(res.data);
    toast.success(exportDoneMessage(res.data.rows, res.data.truncated));
  }

  const filterFrom = useCallback((f: EventDetailFilter) => {
    setSelected(null);
    setFilters((current) =>
      f.kind === 'type'
        ? { ...current, eventType: f.eventType }
        : { ...current, aggregateType: f.aggregateType, aggregateId: f.aggregateId },
    );
  }, []);

  const clearAll = useCallback(() => {
    setEmail('');
    setFilters(clearedFilters());
  }, []);

  const activeCount = activeFilterCount(filters);
  const emailIncomplete = email.trim() !== '' && actorEmailTerm(email) === null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Actividad de la plataforma
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Quién hizo qué, dónde y cuándo, en toda la red.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={list.status === 'loading' || (list.status === 'ready' && list.refreshing)}
              onClick={() => void load(filters, list.status === 'ready' ? 'refresh' : 'initial')}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn(list.status === 'ready' && list.refreshing && 'animate-spin')}
              />
              Actualizar
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={exporting}
              aria-describedby="actividad-nota-exportar"
              onClick={() => void exportCsv()}
            >
              {exporting ? (
                <RefreshCw aria-hidden="true" className="animate-spin" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {exporting ? 'Exportando…' : 'Exportar CSV'}
            </Button>
          </div>
          <p id="actividad-nota-exportar" className="text-xs text-[var(--color-fg-muted)]">
            {ACTIVITY_EXPORT_NOTE}
          </p>
        </div>
      </header>

      <div className="mb-5 space-y-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ActivityCategoryChips filters={filters} onChange={setFilters} />
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 md:hidden"
            aria-haspopup="dialog"
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filtros
            {activeCount > 0 ? (
              <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--color-primary-fg)]">
                {activeCount}
                <span className="sr-only">
                  {' '}
                  {activeCount === 1 ? 'filtro puesto' : 'filtros puestos'}
                </span>
              </span>
            ) : null}
          </Button>
        </div>
        <PinnedFilters filters={filters} onChange={setFilters} />
        <div className="hidden md:block">
          <ActivityFilters
            filters={filters}
            onChange={setFilters}
            email={email}
            onEmailChange={setEmail}
            nodes={nodes}
            now={now}
          />
        </div>
        <p
          aria-live="polite"
          className={cn('text-xs text-[var(--color-fg-muted)]', !emailIncomplete && 'sr-only')}
        >
          {emailIncomplete ? 'Escribe el correo completo para filtrar por quién actuó.' : ''}
        </p>
      </div>

      <FiltersSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        submitLabel="Ver actividad"
        headerAction={
          activeCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Limpiar
            </Button>
          ) : undefined
        }
      >
        <ActivityFilters
          filters={filters}
          onChange={setFilters}
          email={email}
          onEmailChange={setEmail}
          nodes={nodes}
          now={now}
          layout="sheet"
        />
      </FiltersSheet>

      <ActivityResults
        list={list}
        filtered={activeCount > 0}
        selectedId={selected?.id ?? null}
        onOpen={setSelected}
        onRetry={() => void load(filters, 'initial')}
        onLoadMore={() => void loadMore()}
        onClear={clearAll}
      />

      {selected !== null && hydrated ? (
        <EventDetailSheet
          key={selected.id}
          event={selected}
          onClose={() => setSelected(null)}
          onFilter={filterFrom}
        />
      ) : null}
    </div>
  );
}

/** La lista con sus estados: cargando, error, vacía, con eventos y "Cargar más". */
export function ActivityResults({
  list,
  filtered,
  selectedId,
  onOpen,
  onRetry,
  onLoadMore,
  onClear,
}: {
  list: ActivityListState;
  filtered: boolean;
  selectedId: string | null;
  onOpen: (event: ActivityEventView) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onClear: () => void;
}) {
  if (list.status === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <span className="sr-only">Cargando la actividad…</span>
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
          />
        ))}
      </div>
    );
  }

  if (list.status === 'error') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
      >
        <p className="mx-auto max-w-md text-sm font-medium text-[var(--color-fg)]">
          {list.message}
        </p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Reintentar
        </Button>
      </div>
    );
  }

  const { events, nextCursor } = list.data;
  return (
    <section
      aria-label="Eventos encontrados"
      aria-busy={list.refreshing || undefined}
      className={cn('space-y-3 transition-opacity', list.refreshing && 'opacity-60')}
    >
      <p aria-live="polite" className="text-xs text-[var(--color-fg-muted)]">
        {events.length === 0
          ? 'Sin eventos.'
          : `${events.length === 1 ? '1 evento' : `${events.length} eventos`}${
              nextCursor !== null ? ' · hay más' : ''
            } · del más nuevo al más viejo · hora de Bogotá`}
      </p>

      {events.length === 0 ? (
        <EmptyState icon={<History className="size-6" />} title={ACTIVITY_EMPTY}>
          <p>Prueba con otras fechas, otra categoría u otro nodo.</p>
          {filtered ? (
            <Button variant="secondary" size="sm" className="mt-3" onClick={onClear}>
              Limpiar filtros
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <ActivityTable events={events} selectedId={selectedId} onOpen={onOpen} />
      )}

      {nextCursor !== null ? (
        <div className="flex flex-col items-center gap-2 pt-1">
          {typeof list.more === 'object' ? (
            <ToneNotice tone="danger" role="alert">
              {list.more.error}
            </ToneNotice>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={list.more === 'loading'}
            onClick={onLoadMore}
          >
            {list.more === 'loading' ? (
              <RefreshCw aria-hidden="true" className="animate-spin" />
            ) : null}
            {list.more === 'loading' ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const TH =
  'px-3 pb-2 pt-3 text-left text-[11px] font-medium text-[var(--color-fg-muted)] first:pl-4 last:pr-4';
const TD = 'px-3 py-2.5 align-top first:pl-4 last:pr-4';

/** El nombre del evento y, debajo, su código: lo que se lee y lo que se busca. */
function EventName({ event }: { event: ActivityEventView }) {
  const label = eventLabel(event.eventType, event.payload);
  return (
    <>
      <span
        className={cn(
          'block font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]',
          label.raw && 'font-mono text-xs',
        )}
      >
        {label.text}
      </span>
      {!label.raw ? (
        <code className="block truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
          {event.eventType}
        </code>
      ) : null}
    </>
  );
}

function NodeCell({ event }: { event: ActivityEventView }) {
  if (event.tenantId === null) {
    return (
      <span className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-[10px] font-medium text-[var(--color-fg-muted)]">
        Plataforma
      </span>
    );
  }
  return <span className="block truncate text-[var(--color-fg)]">{activityNodeLabel(event)}</span>;
}

/**
 * La lista: una tabla en pantallas anchas y tarjetas en el teléfono y la tableta. Cada evento abre su
 * detalle con un botón (teclado y lector); en la tabla, toda la fila responde al clic.
 */
export function ActivityTable({
  events,
  selectedId,
  onOpen,
}: {
  events: readonly ActivityEventView[];
  selectedId: string | null;
  onOpen: (event: ActivityEventView) => void;
}) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] lg:block">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">
            Actividad de la plataforma, del evento más nuevo al más viejo
          </caption>
          <colgroup>
            <col className="w-[9.5rem]" />
            <col className="w-[30%]" />
            <col className="w-[15%]" />
            <col className="w-[18%]" />
            <col />
          </colgroup>
          <thead className="border-b border-[var(--color-border)]">
            <tr>
              <th scope="col" className={TH}>
                Fecha
              </th>
              <th scope="col" className={TH}>
                Evento
              </th>
              <th scope="col" className={TH}>
                Nodo
              </th>
              <th scope="col" className={TH}>
                Quién
              </th>
              <th scope="col" className={TH}>
                Detalle
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {events.map((event) => (
              <tr
                key={event.id}
                onClick={() => onOpen(event)}
                className={cn(
                  'cursor-pointer transition-colors hover:bg-[var(--color-surface-muted)]',
                  event.id === selectedId && 'bg-[var(--color-surface-muted)]',
                )}
              >
                <td
                  className={cn(
                    TD,
                    'whitespace-nowrap tabular-nums text-xs text-[var(--color-fg-muted)]',
                  )}
                >
                  <time dateTime={event.occurredAt}>{formatActivityDate(event.occurredAt)}</time>
                </td>
                <td className={TD}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(event);
                    }}
                    className="block w-full min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                  >
                    <EventName event={event} />
                  </button>
                </td>
                <td className={cn(TD, 'text-xs')}>
                  <NodeCell event={event} />
                </td>
                <td className={cn(TD, 'text-xs')}>
                  <span
                    className={cn(
                      'block truncate',
                      event.actorEmail === null
                        ? 'text-[var(--color-fg-subtle)]'
                        : 'text-[var(--color-fg)]',
                    )}
                  >
                    {activityActorLabel(event)}
                  </span>
                </td>
                <td className={cn(TD, 'text-xs text-[var(--color-fg-muted)]')}>
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">
                    {eventDetail(event)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 lg:hidden" aria-label="Eventos">
        {events.map((event) => {
          const detail = eventDetail(event);
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(event)}
                className={cn(
                  'block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left text-sm shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
                  event.id === selectedId && 'border-[var(--color-primary)]',
                )}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <EventName event={event} />
                  </span>
                  <time
                    dateTime={event.occurredAt}
                    className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-[var(--color-fg-muted)]"
                  >
                    {formatActivityDate(event.occurredAt)}
                  </time>
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-muted)]">
                  <NodeCell event={event} />
                  <span aria-hidden="true">·</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {activityActorLabel(event)}
                  </span>
                </span>
                {detail !== '' ? (
                  <span className="mt-1 block text-xs text-[var(--color-fg-muted)] [overflow-wrap:anywhere]">
                    {detail}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
