'use client';

import { CalendarSearch, Download, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { TextInput } from '../../../../../../components/ui/field';
import { FiltersSheet } from '../../../../../../components/ui/filters-sheet';
import { EmptyState, ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import { saveFile } from '../../../../../../lib/platform-audit-client';
import {
  DEFAULT_ORDERS_FILTERS,
  ORDERS_EXPORT_NOTE,
  ORDERS_SEARCH_MAX_LENGTH,
  ORDERS_SEARCH_MIN_LENGTH,
  activeFilterCount,
  appendOrders,
  clearedFilters,
  emptyCopy,
  nodeOptions,
  ordersExportDoneMessage,
  ordersHref,
  searchTerm,
  type OrdersFilters as Filters,
  type PlatformOrderRow,
  type PlatformOrdersPage,
} from '../../../../../../lib/platform-orders';
import {
  exportPlatformOrders,
  loadPlatformOrders,
} from '../../../../../../lib/platform-orders-client';
import { isStepUpCancelled } from '../../../../../../lib/step-up';
import { loadAdminNetwork } from '../../../../../../lib/tenant-admin-client';
import { OrderDetailSheet } from './order-detail-sheet';
import { OrdersFilters, type NodeOptionsState } from './orders-filters';
import { OrdersTable } from './orders-table';

export type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly data: PlatformOrdersPage;
      readonly more: 'idle' | 'loading' | { readonly error: string };
      readonly refreshing: boolean;
    };

interface Selected {
  readonly id: string;
  readonly preview: PlatformOrderRow | null;
}

/** Espera de la búsqueda: no se pide una página por cada tecla. */
const SEARCH_DEBOUNCE_MS = 300;

const subscribeNothing = () => () => undefined;
/** Cada cuánto se rehace "desde hace…" sin volver a pedir nada. */
const CLOCK_TICK_MS = 60_000;

/**
 * Plataforma → Reservas de la red: el superadmin busca cualquier reserva de cualquier nodo, ve cuáles
 * esperan a una persona y abre su ficha, desde donde hace la post-venta (nunca vende). Antes se
 * enteraba cuando la agencia se lo contaba.
 *
 * Los filtros viven en la URL (`?atencion=1&estado=…&nodo=…`) y la ficha abierta también
 * (`?orden=`): un enlace abre lo mismo, y el Resumen enlaza aquí. La búsqueda no va en la URL: puede
 * ser el correo de un cliente.
 *
 * "Exportar CSV" se lleva la vista con los mismos filtros de la lista (hasta 5.000, sin pasajeros ni
 * contacto); pide el 2FA reciente y queda en la auditoría.
 */
export function OrdersConsole({
  initialFilters = DEFAULT_ORDERS_FILTERS,
  initialOrderId = null,
}: {
  initialFilters?: Filters;
  initialOrderId?: string | null;
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [search, setSearch] = useState(initialFilters.q);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [nodes, setNodes] = useState<NodeOptionsState>({ status: 'loading' });
  const [selected, setSelected] = useState<Selected | null>(
    initialOrderId === null ? null : { id: initialOrderId, preview: null },
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /**
   * La ficha se pinta recién con la página hidratada. Con `?orden=` en una carga completa, el
   * servidor la pintaba en su lugar y al hidratar ModalPortal la movía al `<body>`: el foco inicial
   * quedaba en el nodo que se descartó y el diálogo abría sin foco para el teclado y el lector.
   */
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  /** El último pedido de la lista: una respuesta vieja (filtros de antes) no pisa la nueva. */
  const request = useRef(0);
  /** Hay una lista en pantalla: si falla una actualización, se conserva. */
  const showing = useRef(false);

  /** `initial` pinta el esqueleto; `refresh` deja la lista (atenuada) y, si falla, la conserva. */
  const load = useCallback(async (next: Filters, mode: 'initial' | 'refresh') => {
    const id = ++request.current;
    setList((s) =>
      mode === 'refresh' && s.status === 'ready'
        ? { ...s, refreshing: true }
        : { status: 'loading' },
    );
    const page = await loadPlatformOrders(next);
    if (id !== request.current) return;
    setNow(Date.now());
    if (page.ok) {
      showing.current = true;
      setList({ status: 'ready', data: page.data, more: 'idle', refreshing: false });
      return;
    }
    if (mode === 'refresh' && showing.current) {
      toast.error(`No pudimos actualizar la lista: ${page.message}`);
      // Un "Cargar más" que salió antes de actualizar ya no vuelve (su respuesta se descarta): sin
      // esto, el botón quedaba en "Cargando…" para siempre.
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

  // La red para el selector de nodo: se lee una vez; sin ella se busca igual en toda la red.
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

  // Los filtros y la ficha a la URL sin recargar: Next sincroniza replaceState con su router.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    const href = ordersHref(filters, selectedId);
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.replaceState(null, '', href);
    }
  }, [filters, selectedId]);

  useEffect(() => {
    const q = searchTerm(search);
    if (q === filters.q) return;
    const timer = window.setTimeout(() => setFilters((f) => ({ ...f, q })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, filters.q]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function loadMore() {
    if (list.status !== 'ready' || list.data.nextCursor === null || list.more === 'loading') return;
    const id = request.current;
    const cursor = list.data.nextCursor;
    setList({ ...list, more: 'loading' });
    const res = await loadPlatformOrders(filters, cursor);
    if (id !== request.current) return;
    setList((s) => {
      if (s.status !== 'ready') return s;
      if (!res.ok) return { ...s, more: { error: res.message } };
      return {
        ...s,
        more: 'idle',
        data: {
          nextCursor: res.data.nextCursor,
          orders: appendOrders(s.data.orders, res.data.orders),
        },
      };
    });
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    // Los filtros de la lista en pantalla. Alto impacto: puede pedir el código del 2FA en el medio
    // y repetirse (USR-13).
    const res = await exportPlatformOrders(filters);
    setExporting(false);
    if (isStepUpCancelled(res)) return;
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    saveFile(res.data);
    toast.success(ordersExportDoneMessage(res.data.rows));
  }

  const open = useCallback(
    (row: PlatformOrderRow) => setSelected({ id: row.id, preview: row }),
    [],
  );
  const close = useCallback(() => setSelected(null), []);
  // Una acción desde la ficha (cancelar, reintentar, consultar) puede cambiar el estado de la fila.
  const changed = useCallback(() => void load(filters, 'refresh'), [filters, load]);
  const hrefFor = useCallback((row: PlatformOrderRow) => ordersHref(filters, row.id), [filters]);

  const activeCount = activeFilterCount(filters);
  // Lo que no se pide (una letra, un "#" solo): se avisa en vez de mostrar la lista sin filtrar.
  const tooShort = search.trim() !== '' && searchTerm(search) === '';

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Reservas de la red
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Busca y revisa cualquier reserva de todos los nodos.
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
              aria-describedby="reservas-nota-exportar"
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
          <p
            id="reservas-nota-exportar"
            className="max-w-xs text-xs text-[var(--color-fg-muted)] sm:text-right"
          >
            {ORDERS_EXPORT_NOTE}
          </p>
        </div>
      </header>

      <div className="mb-5 space-y-4">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1 md:max-w-xl">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
            />
            <TextInput
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={ORDERS_SEARCH_MAX_LENGTH}
              placeholder="Busca por PNR, localizador, n.º de orden o correo del cliente"
              aria-label="Buscar por PNR, localizador, n.º de orden o correo del cliente"
              aria-describedby={tooShort ? 'reservas-busqueda-corta' : undefined}
              className="pl-9"
            />
          </div>
          <Button
            variant="secondary"
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
        <p
          id="reservas-busqueda-corta"
          aria-live="polite"
          className={cn('text-xs text-[var(--color-fg-muted)]', !tooShort && 'sr-only')}
        >
          {tooShort ? `Escribe al menos ${ORDERS_SEARCH_MIN_LENGTH} caracteres para buscar.` : ''}
        </p>
        <div className="hidden md:block">
          <OrdersFilters
            filters={filters}
            onChange={setFilters}
            nodes={nodes}
            now={new Date(now)}
          />
        </div>
      </div>

      <FiltersSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        submitLabel="Ver reservas"
        headerAction={
          activeCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(clearedFilters(filters))}>
              Limpiar
            </Button>
          ) : undefined
        }
      >
        <OrdersFilters
          filters={filters}
          onChange={setFilters}
          nodes={nodes}
          now={new Date(now)}
          layout="sheet"
        />
      </FiltersSheet>

      <OrdersResults
        list={list}
        filters={filters}
        now={now}
        selectedId={selectedId}
        hrefFor={hrefFor}
        onOpen={open}
        onRetry={() => void load(filters, 'initial')}
        onLoadMore={() => void loadMore()}
        onClear={() => setFilters(clearedFilters(filters))}
      />

      {selected !== null && hydrated ? (
        <OrderDetailSheet
          key={selected.id}
          orderId={selected.id}
          preview={selected.preview}
          onClose={close}
          onChanged={changed}
        />
      ) : null}
    </div>
  );
}

/** La lista con sus estados: cargando, error, vacía, con filas y "Cargar más". */
export function OrdersResults({
  list,
  filters,
  now,
  selectedId,
  hrefFor,
  onOpen,
  onRetry,
  onLoadMore,
  onClear,
}: {
  list: ListState;
  filters: Filters;
  now: number;
  selectedId: string | null;
  hrefFor: (row: PlatformOrderRow) => ReturnType<typeof ordersHref>;
  onOpen: (row: PlatformOrderRow) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onClear: () => void;
}) {
  if (list.status === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <span className="sr-only">Cargando las reservas…</span>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
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

  const { orders, nextCursor } = list.data;
  const empty = emptyCopy(filters);
  return (
    <section
      aria-label="Reservas encontradas"
      aria-busy={list.refreshing || undefined}
      className={cn('space-y-3 transition-opacity', list.refreshing && 'opacity-60')}
    >
      <p aria-live="polite" className="text-xs text-[var(--color-fg-muted)]">
        {orders.length === 0
          ? 'Sin reservas.'
          : `${orders.length === 1 ? '1 reserva' : `${orders.length} reservas`}${
              nextCursor !== null ? ' · hay más' : ''
            } · de la más nueva a la más vieja · hora de Bogotá`}
      </p>

      {orders.length === 0 ? (
        <EmptyState icon={<CalendarSearch className="size-6" />} title={empty.title}>
          <p>{empty.text}</p>
          {activeFilterCount(filters) > 0 ? (
            <Button variant="secondary" size="sm" className="mt-3" onClick={onClear}>
              Limpiar filtros
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <OrdersTable
          orders={orders}
          selectedId={selectedId}
          now={now}
          hrefFor={hrefFor}
          onOpen={onOpen}
        />
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
