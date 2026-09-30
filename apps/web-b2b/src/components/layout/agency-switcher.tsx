'use client';

import {
  ArrowLeft,
  ArrowLeftRight,
  Ban,
  Check,
  ChevronsUpDown,
  Loader2,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { roleLabel } from '../../app/(app)/admin/usuarios/_components/roles';
import { SeatsFullStep } from '../../app/login/_components/seats-full-step';
import type { SeatsFull } from '../../app/login/login-state';
import {
  filterAgencies,
  hasOtherAgencies,
  isSelectable,
  showsAgencySearch,
  switchedMessage,
  type AgencyOption,
} from '../../lib/agencies';
import { cn } from '../../lib/cn';
import { commandItems, filterCommands, moveActive, type CommandItem } from '../../lib/command-menu';
import { navSections } from '../../lib/nav';
import { SWITCH_MESSAGES, initialSwitchSeatsState } from '../../lib/tenant-switch';
import { useModalBehavior } from '../ui/dialog';
import { releaseSeatForSwitchAction, switchAgencyAction } from './agency-switcher-actions';
import { BrandMark } from './brand-mark';
import { endSession } from './session-sync';
import { publishTenantSwitch, subscribeTenantSwitch } from './tenant-sync';
import { useViewer } from './viewer-context';

/*
 * Cambiar de agencia: quien opera en varias agencias de la red (el admin de un consolidador que
 * además vende en una sucursal, un vendedor que aceptó la invitación de otra agencia) elige con
 * cuál operar. Se abre desde el topbar, desde el drawer móvil y con ⌘K / Ctrl+K ("Cambiar de
 * agencia…" en la paleta de comandos).
 *
 * Elegir llama a POST /auth/switch-tenant: la API reemplaza la sesión y controla el cupo de puestos
 * del destino. Con el cupo lleno se muestra el mismo panel del login (SeatsFullStep) y la sesión
 * actual sigue. Con éxito: cookies nuevas (la server action), `router.refresh()`, aviso a las otras
 * pestañas y "Ahora operás como <Agencia>".
 */

type Page = 'commands' | 'agencies';

type DialogState =
  | { page: Page; from: Page | null }
  | { page: 'seats'; from: Page | null; seats: SeatsFull; target: AgencyOption };

interface AgencySwitcherApi {
  agencies: readonly AgencyOption[];
  current: AgencyOption | undefined;
  /** Hay otra agencia además de la actual. */
  canSwitch: boolean;
  open: (page: Page) => void;
}

const AgencySwitcherContext = createContext<AgencySwitcherApi | null>(null);

const NO_SWITCHER: AgencySwitcherApi = {
  agencies: [],
  current: undefined,
  canSwitch: false,
  open: () => undefined,
};

export function useAgencySwitcher(): AgencySwitcherApi {
  return useContext(AgencySwitcherContext) ?? NO_SWITCHER;
}

export function AgencySwitcherProvider({
  agencies,
  role,
  children,
}: {
  agencies: AgencyOption[];
  /** Rol en la agencia activa: decide qué pantallas ofrece la paleta, como el sidebar. */
  role?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agenciesRef = useRef(agencies);
  agenciesRef.current = agencies;

  const current = agencies.find((a) => a.current);
  const canSwitch = hasOtherAgencies(agencies);

  const open = useCallback((page: Page) => {
    setError(null);
    setDialog({ page, from: null });
  }, []);
  const close = useCallback(() => {
    setError(null);
    setDialog(null);
  }, []);

  // ⌘K en Mac, Ctrl+K en el resto: abre (o cierra) la paleta desde cualquier pantalla.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') {
        return;
      }
      e.preventDefault();
      setError(null);
      setDialog((prev) => (prev ? null : { page: 'commands', from: null }));
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Otra pestaña cambió de agencia: ésta ya opera con la sesión nueva (las cookies son de todas),
  // así que se refresca para no mostrar una agencia y vender en otra.
  useEffect(
    () =>
      subscribeTenantSwitch((message) => {
        setDialog(null);
        const name = agenciesRef.current.find((a) => a.tenantId === message.tenantId)?.name;
        toast.info(
          name
            ? `${switchedMessage(name)} (lo cambiaste en otra pestaña)`
            : 'Cambiaste de agencia en otra pestaña',
        );
        router.refresh();
      }),
    [router],
  );

  const finishSwitch = useCallback(
    (tenantId: string, name: string) => {
      publishTenantSwitch(tenantId);
      setDialog(null);
      setError(null);
      toast.success(switchedMessage(name));
      router.refresh();
    },
    [router],
  );

  const choose = useCallback(
    async (option: AgencyOption, from: Page | null) => {
      if (pendingId) return;
      if (option.current) {
        close();
        return;
      }
      if (!isSelectable(option)) return;

      setError(null);
      setPendingId(option.tenantId);
      try {
        const result = await switchAgencyAction(option.tenantId);
        switch (result.kind) {
          case 'switched':
            finishSwitch(result.tenantId || option.tenantId, option.name);
            break;
          case 'seats':
            setDialog({ page: 'seats', from, seats: result.seats, target: option });
            break;
          case 'error':
            setError(result.message);
            if (result.refresh) router.refresh();
            break;
          case 'ended':
            endSession(result.motivo);
            break;
        }
      } catch {
        setError(SWITCH_MESSAGES.unavailable);
      } finally {
        setPendingId(null);
      }
    },
    [pendingId, close, finishSwitch, router],
  );

  const api = useMemo<AgencySwitcherApi>(
    () => ({ agencies, current, canSwitch, open }),
    [agencies, current, canSwitch, open],
  );

  return (
    <AgencySwitcherContext.Provider value={api}>
      {children}
      {dialog ? (
        <SwitcherDialog
          dialog={dialog}
          agencies={agencies}
          current={current}
          canSwitch={canSwitch}
          role={role}
          pendingId={pendingId}
          error={error}
          onClose={close}
          onNavigate={(href) => {
            close();
            router.push(href);
          }}
          onPage={(page, from) => {
            setError(null);
            setDialog({ page, from });
          }}
          onChoose={(option) => void choose(option, dialog.page === 'seats' ? null : dialog.from)}
          onSwitched={finishSwitch}
          onSeatsRetry={(message) => {
            setError(message);
            setDialog({ page: 'agencies', from: dialog.from });
          }}
        />
      ) : null}
    </AgencySwitcherContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// Disparadores
// ---------------------------------------------------------------------------------------------

/**
 * La agencia activa en el topbar. Con otra agencia a la que cambiar es un botón que abre el
 * selector; con una sola, sólo la muestra (un botón que no lleva a nada es ruido).
 */
export function AgencyTrigger({
  tenantName,
  tenantSlug,
  logoUrl,
}: {
  tenantName?: string;
  tenantSlug?: string;
  logoUrl?: string;
}) {
  const { agencies, open } = useAgencySwitcher();
  const name = tenantName ?? 'Sin agencia';
  const interactive = agencies.length > 1;

  const content = (
    <>
      <BrandMark tenantName={tenantName} logoUrl={logoUrl} size="sm" tone="onLight" />
      <span className="min-w-0 truncate font-semibold text-[var(--color-fg)] transition-colors group-hover:text-[var(--color-primary)] sm:max-w-[14rem]">
        {name}
      </span>
      {tenantSlug ? (
        <span className="hidden whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-subtle)] sm:inline">
          {tenantSlug}
        </span>
      ) : null}
    </>
  );

  const base =
    // Encoge con el topbar: en un teléfono el nombre se trunca en vez de montarse sobre los botones.
    'flex min-h-9 min-w-0 max-w-[16rem] items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-xs)]';

  if (!interactive) return <div className={base}>{content}</div>;

  return (
    <button
      type="button"
      onClick={() => open('agencies')}
      aria-haspopup="dialog"
      aria-label={`Agencia activa: ${name}. Cambiar de agencia`}
      className={cn(
        base,
        'group cursor-pointer transition-all duration-200 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
      )}
    >
      {content}
      <ChevronsUpDown
        className="size-3.5 shrink-0 text-[var(--color-fg-subtle)] transition-colors group-hover:text-[var(--color-fg-muted)]"
        aria-hidden="true"
      />
    </button>
  );
}

/** "Cambiar de agencia" dentro del drawer móvil, debajo de la marca. */
export function DrawerAgencyButton({ onBeforeOpen }: { onBeforeOpen: () => void }) {
  const { canSwitch, agencies, open } = useAgencySwitcher();
  if (!canSwitch) return null;
  return (
    <div className="border-b border-slate-800/60 px-3.5 py-3">
      <button
        type="button"
        onClick={() => {
          onBeforeOpen();
          open('agencies');
        }}
        aria-haspopup="dialog"
        className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-slate-700/70 px-3 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      >
        <ArrowLeftRight className="size-4 text-slate-400" aria-hidden="true" />
        Cambiar de agencia
        <span className="ml-auto rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium tabular-nums text-slate-300">
          {agencies.length}
          <span className="sr-only"> agencias</span>
        </span>
      </button>
    </div>
  );
}

/** ⌘K en Mac, Ctrl K en el resto. Se decide en el navegador: en el servidor no hay plataforma. */
function useShortcutLabel(): string {
  const [label, setLabel] = useState('⌘K');
  useEffect(() => {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.platform;
    if (!/mac|iphone|ipad/i.test(platform)) setLabel('Ctrl K');
  }, []);
  return label;
}

/** El "Buscar…" del topbar: abre la paleta de comandos. */
export function CommandMenuButton() {
  const { open } = useAgencySwitcher();
  const shortcut = useShortcutLabel();
  return (
    <button
      type="button"
      onClick={() => open('commands')}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      className="hidden cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-1.5 text-xs text-[var(--color-fg-subtle)] shadow-[var(--shadow-xs)] transition-all duration-200 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] md:flex"
    >
      <Search className="size-3.5 text-[var(--color-fg-subtle)]" aria-hidden="true" />
      <span className="font-medium">Buscar…</span>
      <kbd className="ml-3 inline-flex items-center whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[9px] font-bold text-[var(--color-fg-subtle)] shadow-[var(--shadow-xs)]">
        {shortcut}
      </kbd>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// El diálogo
// ---------------------------------------------------------------------------------------------

interface SwitcherDialogProps {
  dialog: DialogState;
  agencies: readonly AgencyOption[];
  current: AgencyOption | undefined;
  canSwitch: boolean;
  role?: string;
  pendingId: string | null;
  error: string | null;
  onClose: () => void;
  onNavigate: (href: Route) => void;
  onPage: (page: Page, from: Page | null) => void;
  onChoose: (option: AgencyOption) => void;
  onSwitched: (tenantId: string, name: string) => void;
  onSeatsRetry: (message: string) => void;
}

/**
 * Hoja desde abajo en el teléfono (se alcanza con el pulgar), paleta arriba al centro en
 * escritorio. Semántica de diálogo modal de `useModalBehavior`: foco atrapado, Escape, scroll del
 * fondo bloqueado y foco devuelto a quien lo abrió.
 */
export function SwitcherDialog(props: SwitcherDialogProps) {
  const { dialog, onClose } = props;
  const panelRef = useModalBehavior(true, onClose);
  const titleId = useId();
  const seats = dialog.page === 'seats';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:px-4 sm:pt-[12vh]">
      <div
        className="absolute inset-0 animate-fade-in bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={seats ? undefined : titleId}
        aria-label={seats ? `No hay puestos libres en ${dialog.target.name}` : undefined}
        className={cn(
          'relative flex max-h-[85dvh] w-full animate-fade-in-up flex-col sm:max-h-[70vh] sm:max-w-lg',
          seats
            ? 'overflow-y-auto rounded-t-2xl sm:rounded-xl'
            : 'overflow-hidden rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] sm:rounded-xl',
        )}
      >
        {dialog.page === 'seats' ? (
          <SeatsPage
            seats={dialog.seats}
            target={dialog.target}
            onBack={() => props.onPage('agencies', dialog.from)}
            onSwitched={props.onSwitched}
            onRetry={props.onSeatsRetry}
          />
        ) : dialog.page === 'agencies' ? (
          <AgenciesPage {...props} titleId={titleId} from={dialog.from} />
        ) : (
          <CommandsPage {...props} titleId={titleId} />
        )}
      </div>
    </div>
  );
}

function DialogHeader({
  titleId,
  title,
  subtitle,
  onBack,
  onClose,
  srOnlyTitle = false,
}: {
  titleId: string;
  title: string;
  subtitle?: ReactNode;
  onBack?: () => void;
  onClose: () => void;
  srOnlyTitle?: boolean;
}) {
  return (
    <div
      className={cn('flex items-start gap-2 px-4 pt-4', srOnlyTitle ? 'pb-0 sm:hidden' : 'pb-3')}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Volver a los comandos"
          className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <div className={cn('min-w-0 flex-1 pt-1.5', srOnlyTitle && 'sr-only')}>
        <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)]">{subtitle}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar"
        className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] sm:size-8"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  // La región existe siempre: una región viva que aparece junto con su texto no siempre se anuncia.
  return (
    <div role="alert" className={cn(message ? 'px-4 pb-3' : 'sr-only')}>
      {message ? (
        <p className="flex gap-2 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 px-3 py-2 text-xs leading-snug text-[var(--color-danger)]">
          <Ban className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      ) : null}
    </div>
  );
}

function KeyboardHints() {
  return (
    <p
      className="hidden border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-fg-subtle)] sm:block"
      aria-hidden="true"
    >
      <kbd className="font-mono">↑↓</kbd> para moverte · <kbd className="font-mono">↵</kbd> para
      elegir · <kbd className="font-mono">Esc</kbd> para cerrar
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Página: agencias
// ---------------------------------------------------------------------------------------------

function AgenciesPage({
  agencies,
  current,
  pendingId,
  error,
  titleId,
  from,
  onClose,
  onPage,
  onChoose,
}: SwitcherDialogProps & { titleId: string; from: Page | null }) {
  const [query, setQuery] = useState('');
  const withSearch = showsAgencySearch(agencies.length);
  const visible = useMemo(
    () => (withSearch ? filterAgencies(agencies, query) : [...agencies]),
    [agencies, query, withSearch],
  );
  const pendingName = agencies.find((a) => a.tenantId === pendingId)?.name;

  const items = visible.map<ListItem>((option) => ({
    id: option.tenantId,
    disabled: option.disabledReason !== null,
    render: (active) => (
      <AgencyRow option={option} active={active} pending={pendingId === option.tenantId} />
    ),
  }));

  // La primera que se puede elegir, no la actual: es a la que casi siempre se quiere ir.
  const preferred = Math.max(
    0,
    visible.findIndex((o) => isSelectable(o)),
  );

  return (
    <>
      <DialogHeader
        titleId={titleId}
        title="Cambiar de agencia"
        subtitle={
          current ? (
            <>
              Operás como <span className="font-medium text-[var(--color-fg)]">{current.name}</span>
              {' · '}
              {roleLabel(current.role)}
            </>
          ) : null
        }
        onBack={from === 'commands' ? () => onPage('commands', null) : undefined}
        onClose={onClose}
      />
      <ErrorLine message={error} />
      <CommandList
        items={items}
        preferredIndex={preferred}
        labelledBy={titleId}
        busy={pendingId !== null}
        search={
          withSearch
            ? {
                value: query,
                onChange: setQuery,
                label: 'Buscar agencia',
                placeholder: 'Buscar por nombre o identificador…',
                onBackspaceEmpty: from === 'commands' ? () => onPage('commands', null) : undefined,
              }
            : null
        }
        emptyText={`No hay agencias que coincidan con «${query.trim()}».`}
        onSelect={(id) => {
          const option = visible.find((o) => o.tenantId === id);
          if (option) onChoose(option);
        }}
      />
      <p className="sr-only" aria-live="polite">
        {pendingName ? `Cambiando a ${pendingName}…` : ''}
      </p>
      <KeyboardHints />
    </>
  );
}

function AgencyRow({
  option,
  active,
  pending,
}: {
  option: AgencyOption;
  active: boolean;
  pending: boolean;
}) {
  const disabled = option.disabledReason !== null;
  return (
    <div
      className={cn(
        'flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 transition-colors sm:min-h-12',
        active && !disabled && 'bg-[var(--color-surface-muted)]',
        active && disabled && 'bg-[var(--color-surface-muted)]/60',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <BrandMark
        tenantName={option.name}
        logoUrl={option.logoUrl ?? undefined}
        size="sm"
        tone="onLight"
        className={cn(disabled && 'opacity-50 grayscale')}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-sm font-medium',
            disabled ? 'text-[var(--color-fg-muted)]' : 'text-[var(--color-fg)]',
          )}
        >
          {option.name}
        </p>
        <p className="truncate text-xs text-[var(--color-fg-muted)]">
          {roleLabel(option.role)}
          {option.slug ? (
            <span className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
              {' · '}
              {option.slug}
            </span>
          ) : null}
        </p>
        {option.disabledReason ? (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
            <Ban className="size-3 shrink-0" aria-hidden="true" />
            {option.disabledReason}
          </p>
        ) : null}
      </div>
      {pending ? (
        <Loader2
          className="size-4 shrink-0 animate-spin text-[var(--color-fg-muted)]"
          aria-hidden="true"
        />
      ) : option.current ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--color-fg)]">
          <Check className="size-3 text-[var(--color-primary)]" aria-hidden="true" />
          Actual
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Página: comandos (⌘K)
// ---------------------------------------------------------------------------------------------

function CommandsPage({
  current,
  canSwitch,
  role,
  titleId,
  onClose,
  onNavigate,
  onPage,
}: SwitcherDialogProps & { titleId: string }) {
  const viewer = useViewer();
  const [query, setQuery] = useState('');
  const sections = useMemo(() => navSections(role, viewer), [role, viewer]);
  const icons = useMemo(() => {
    const map = new Map<string, LucideIcon>();
    for (const section of sections) for (const item of section.items) map.set(item.href, item.icon);
    return map;
  }, [sections]);
  const all = useMemo(
    () => commandItems({ canSwitch, currentAgencyName: current?.name ?? null, sections }),
    [canSwitch, current, sections],
  );
  const visible = useMemo(() => filterCommands(all, query), [all, query]);

  const items = visible.map<ListItem>((item) => ({
    id: item.id,
    group: item.group,
    render: (active) => <CommandRow item={item} active={active} icon={icons.get(itemHref(item))} />,
  }));

  return (
    <>
      <DialogHeader titleId={titleId} title="Comandos" onClose={onClose} srOnlyTitle />
      <CommandList
        items={items}
        preferredIndex={0}
        labelledBy={titleId}
        busy={false}
        search={{
          value: query,
          onChange: setQuery,
          label: 'Buscar una pantalla o acción',
          placeholder: 'Buscá una pantalla o acción…',
        }}
        emptyText={`No encontramos nada con «${query.trim()}».`}
        onSelect={(id) => {
          const item = visible.find((i) => i.id === id);
          if (!item) return;
          if (item.kind === 'switch-agency') onPage('agencies', 'commands');
          else onNavigate(item.href);
        }}
      />
      <KeyboardHints />
    </>
  );
}

function itemHref(item: CommandItem): string {
  return item.kind === 'navigate' ? item.href : '';
}

function CommandRow({
  item,
  active,
  icon: Icon = ArrowLeftRight,
}: {
  item: CommandItem;
  active: boolean;
  icon?: LucideIcon | undefined;
}) {
  return (
    <div
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors sm:min-h-10',
        active && 'bg-[var(--color-surface-muted)]',
      )}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]',
          active ? 'text-[var(--color-primary)]' : 'text-[var(--color-fg-muted)]',
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-fg)]">{item.label}</span>
      {item.hint ? (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--color-fg-muted)]">
          {item.hint}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Página: cupo lleno (el panel del login)
// ---------------------------------------------------------------------------------------------

function SeatsPage({
  seats,
  target,
  onBack,
  onSwitched,
  onRetry,
}: {
  seats: SeatsFull;
  target: AgencyOption;
  onBack: () => void;
  onSwitched: (tenantId: string, name: string) => void;
  onRetry: (message: string) => void;
}) {
  const [state, formAction, pending] = useActionState(
    releaseSeatForSwitchAction,
    initialSwitchSeatsState(seats),
  );

  useEffect(() => {
    if (state.step === 'switched') onSwitched(state.tenantId || target.tenantId, target.name);
    else if (state.step === 'retry') onRetry(state.message);
    // Sólo reacciona a cada respuesta del servidor, no a callbacks nuevos del padre.
  }, [state]);

  if (state.step !== 'seats') {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" aria-hidden="true" />
        <span className="sr-only">Entrando a {target.name}…</span>
      </div>
    );
  }

  return (
    <SeatsFullStep
      state={state}
      pending={pending}
      formAction={formAction}
      next="/"
      onBack={onBack}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Lista con teclado (patrón combobox + listbox de WAI-ARIA)
// ---------------------------------------------------------------------------------------------

interface ListItem {
  id: string;
  /** Encabezado del grupo: los ítems seguidos con el mismo grupo van juntos. */
  group?: string;
  /** Se puede enfocar (para leer el motivo), no elegir. */
  disabled?: boolean;
  render: (active: boolean) => ReactNode;
}

interface SearchConfig {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  /** Borrar con el campo vacío vuelve a la página anterior, como en las paletas de escritorio. */
  onBackspaceEmpty?: (() => void) | undefined;
}

/**
 * Con buscador, el foco queda en el campo (`combobox`) y la opción activa se anuncia con
 * `aria-activedescendant`; sin buscador (menos de 5 agencias), el foco va a la lista misma. Las
 * opciones deshabilitadas se pueden recorrer —así el lector de pantalla lee por qué no se pueden
 * elegir— pero no elegir.
 */
export function CommandList({
  items,
  preferredIndex,
  labelledBy,
  busy,
  search,
  emptyText,
  onSelect,
}: {
  items: readonly ListItem[];
  preferredIndex: number;
  labelledBy: string;
  busy: boolean;
  search: SearchConfig | null;
  emptyText: string;
  onSelect: (id: string) => void;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(() => clampIndex(preferredIndex, items.length));
  const idsKey = items.map((i) => i.id).join('|');

  // Filtrar cambia la lista: la activa vuelve a la preferida en vez de quedar en un índice viejo.
  useEffect(() => {
    setActive(clampIndex(preferredIndex, items.length));
  }, [idsKey]);

  // Después de `useModalBehavior`, que enfoca el primer control (volver o cerrar): los efectos del
  // hijo corren ANTES que los del padre, así que se difiere a la siguiente vuelta. En una pantalla
  // táctil el foco va a la lista y no al campo: si no, el teclado del teléfono tapa las agencias.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const touch = window.matchMedia?.('(pointer: coarse)').matches === true;
      (touch ? listRef.current : (inputRef.current ?? listRef.current))?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const optionId = (index: number) => `${listId}-o${index}`;
  const activeId = items.length > 0 ? optionId(active) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function select(index: number) {
    const item = items[index];
    if (!item || item.disabled || busy) return;
    onSelect(item.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => moveActive(i, 1, items.length));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => moveActive(i, -1, items.length));
        return;
      case 'Home':
      case 'End':
        // En el campo, Inicio y Fin mueven el cursor del texto.
        if (e.currentTarget === inputRef.current) return;
        e.preventDefault();
        setActive(e.key === 'Home' ? 0 : Math.max(0, items.length - 1));
        return;
      case 'Enter':
        e.preventDefault();
        select(active);
        return;
      case 'Backspace':
        if (search?.onBackspaceEmpty && search.value === '') {
          e.preventDefault();
          search.onBackspaceEmpty();
        }
        return;
    }
  }

  const groups = groupItems(items);

  return (
    <>
      {search ? (
        // El foco del campo se marca en la barra entera (línea inferior de marca): el contorno global
        // de `:focus-visible` quedaba pegado al borde del diálogo.
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-4 transition-colors focus-within:bg-[var(--color-surface)] focus-within:shadow-[inset_0_-2px_0_var(--color-primary)]">
          <Search className="size-4 shrink-0 text-[var(--color-fg-subtle)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={search.label}
            placeholder={search.placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            onKeyDown={onKeyDown}
            // 16 px en el teléfono: con menos, iOS hace zoom al enfocar.
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-[var(--color-fg)] outline-none! placeholder:text-[var(--color-fg-subtle)] sm:h-11 sm:text-sm"
          />
        </div>
      ) : null}

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-labelledby={labelledBy}
        aria-busy={busy || undefined}
        tabIndex={search ? -1 : 0}
        aria-activedescendant={activeId}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] outline-none! focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/40"
      >
        {items.length === 0 ? (
          <li
            role="presentation"
            className="px-3 py-8 text-center text-sm text-[var(--color-fg-muted)]"
          >
            {emptyText}
          </li>
        ) : (
          groups.map((group) => (
            <GroupBlock
              key={`${group.label ?? ''}-${group.start}`}
              label={group.label}
              first={group.start === 0}
            >
              {group.items.map((item, offset) => {
                const index = group.start + offset;
                return (
                  <li
                    key={item.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={item.disabled || undefined}
                    // Sin esto el clic le saca el foco al campo antes de elegir.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => {
                      if (index !== active) setActive(index);
                    }}
                    onClick={() => select(index)}
                  >
                    {item.render(index === active)}
                  </li>
                );
              })}
            </GroupBlock>
          ))
        )}
      </ul>
    </>
  );
}

function GroupBlock({
  label,
  first,
  children,
}: {
  label: string | undefined;
  first: boolean;
  children: ReactNode;
}) {
  const labelId = useId();
  if (!label) return <>{children}</>;
  return (
    <li role="presentation" className={cn('pb-1', !first && 'pt-2')}>
      <div
        id={labelId}
        className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--color-fg-subtle)]"
      >
        {label}
      </div>
      <ul role="group" aria-labelledby={labelId}>
        {children}
      </ul>
    </li>
  );
}

function groupItems(items: readonly ListItem[]) {
  const groups: { label: string | undefined; start: number; items: ListItem[] }[] = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.label === item.group) last.items.push(item);
    else groups.push({ label: item.group, start: index, items: [item] });
  });
  return groups;
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}
