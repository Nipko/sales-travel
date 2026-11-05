'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  CreditCard,
  FileText,
  History,
  IdCard,
  Loader2,
  Luggage,
  Mail,
  MoreHorizontal,
  Plane,
  Receipt,
  Search,
  ShieldCheck,
  Ticket,
  User,
  Users,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useViewer } from '../../../../components/layout/viewer-context';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/cn';
import { formatMoney } from '../../../../lib/flight-format';
import { isCarOrder, isHotelOrder } from '../../../../lib/order-vertical';
import { readJson } from '../../../../lib/read-json';
import { isTestOrder, TEST_ORDER_EMAIL_NOTICE } from '../../../../lib/test-content';
import { canSell } from '../../../../lib/viewer';
import {
  ItineraryTimeline,
  ItineraryTimelineSkeleton,
} from '../../cotizaciones/_components/itinerary-timeline';
import {
  buildTimeline,
  routeTitle,
  travelDates,
} from '../../cotizaciones/_components/itinerary-timeline-view';
import { OfferConditions, PriceBreakdown } from '../../cotizaciones/[id]/booking-summary';
import {
  canRetryCancelOperation,
  directCancellationBlock,
  type OrderOperationView,
} from '../cancel-retry-policy';
import { ISSUE_MESSAGES } from '../issue-ticket-view';
import { orderTotalMinor } from '../issue-ticket-view';
import {
  cancelOrder,
  checkCancellation,
  retrieveOrder,
  retryCancelOperation,
  sendOrderConfirmation,
} from '../order-actions';
import { capabilitiesForViewer, supportsOrderCancellation } from '../order-capabilities';
import { PAX_TYPE_LABEL, flightOfferOf, formatRelativeDate, type Order } from '../order-model';
import {
  ACTION_LABELS,
  billingView,
  chargeSummary,
  deadlineCountdown,
  maskedDocument,
  reservationActions,
  reservationHero,
  reservationLocator,
  type HeroTone,
  type ReservationAction,
} from '../reservation-detail-view';
import { useIssueTracker, type IssueSettlement } from '../use-issue-tracker';
import { walletReleaseNote } from '../wallet-hold-view';
import { AddServicesSheet } from '../_components/add-services-sheet';
import { ConfirmDialog } from '../_components/confirm-dialog';
import { EditTravelersSheet } from '../_components/edit-travelers-sheet';
import { FlightOrderTracking } from '../_components/flight-order-tracking';
import { IssueTicketDialog } from '../_components/issue-ticket-dialog';
import {
  OrderOperationsHistory,
  useOrderOperations,
} from '../_components/order-operations-history';
import { OrderPaymentDialog } from '../_components/order-payment-dialog';
import { TestOrderTag } from '../_components/test-order-tag';
import { TicketConditions } from '../_components/ticket-conditions';

/*
 * El detalle de una reserva de vuelo, en su propia página: lo que se abre al reservar y lo que se
 * comparte por enlace. Arriba, el estado, el código que se le da al pasajero y la acción que el
 * estado pide; debajo, todo lo reservado —itinerario, pasajeros, facturación, precio, condiciones
 * e historial—. Las acciones son las mismas de la lista de Reservas, con las mismas reglas
 * (`reservation-detail-view.ts`, `order-actions.ts`) y los mismos diálogos.
 *
 * Hotel y auto tienen su propio detalle en la lista: esta página los manda ahí.
 */

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly notFound: boolean }
  | { readonly kind: 'ready'; readonly order: Order };

interface QuotationBilling {
  readonly billing?: unknown;
  readonly customerName?: string | null;
  readonly customerEmail?: string | null;
  readonly customerPhone?: string | null;
}

type Notice = { readonly tone: 'ok' | 'error'; readonly text: string } | null;

const TONE_PILL: Readonly<Record<HeroTone, string>> = {
  success: 'bg-[var(--color-success)]/12 ring-[var(--color-success)]/30',
  warning: 'bg-[var(--color-warning)]/15 ring-[var(--color-warning)]/40',
  danger: 'bg-[var(--color-danger)]/10 ring-[var(--color-danger)]/30',
  info: 'bg-[var(--color-primary)]/10 ring-[var(--color-primary)]/25',
};

const TONE_ICON: Readonly<Record<HeroTone, LucideIcon>> = {
  success: CheckCircle2,
  warning: Clock,
  danger: XCircle,
  info: ShieldCheck,
};

const ACTION_ICON: Readonly<Record<ReservationAction, LucideIcon>> = {
  pay: CreditCard,
  issue: Ticket,
  retrieve: Search,
  services: Luggage,
  travelers: IdCard,
  resend: Mail,
  cancel: XCircle,
};

const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-[var(--color-fg)] outline-none transition-colors data-[highlighted]:bg-[var(--color-surface-muted)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Una sección del detalle: título con icono y su contenido, en una tarjeta. */
function Section({
  id,
  title,
  icon: Icon,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5"
    >
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2
          id={id}
          className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]"
        >
          <Icon aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** El código grande con su «Copiar». El aviso de copiado también se anuncia. */
function CopyCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Sin permiso de portapapeles el código sigue a la vista para copiarlo a mano.
    }
  }
  return (
    <div>
      <p className="text-xs font-medium text-[var(--color-fg-muted)]">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="select-all font-mono text-3xl font-bold tracking-[0.12em] text-[var(--color-fg)] sm:text-4xl">
          {code}
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copiar ${label.toLowerCase()} ${code}`}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
        <span className="sr-only" aria-live="polite">
          {copied ? `${code} copiado` : ''}
        </span>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8" aria-busy="true">
      <span className="sr-only" role="status">
        Cargando la reserva…
      </span>
      <div className="mb-4 h-4 w-24 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      <div className="mb-5 animate-pulse rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6">
        <div className="h-6 w-40 rounded-full bg-[var(--color-surface-muted)]" />
        <div className="mt-5 h-3 w-32 rounded bg-[var(--color-surface-muted)]" />
        <div className="mt-2 h-9 w-56 rounded bg-[var(--color-surface-muted)]" />
        <div className="mt-5 h-4 w-72 max-w-full rounded bg-[var(--color-surface-muted)]" />
        <div className="mt-5 flex gap-2">
          <div className="h-10 w-32 rounded-lg bg-[var(--color-surface-muted)]" />
          <div className="h-10 w-36 rounded-lg bg-[var(--color-surface-muted)]" />
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ItineraryTimelineSkeleton legs={2} />
        <div className="h-64 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
      </div>
    </div>
  );
}

export default function ReservationDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const router = useRouter();
  // El superadmin no vende: consulta y cancela lo vendido, sin Pagar/Emitir ni Servicios.
  const sells = canSell(useViewer());
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [quotation, setQuotation] = useState<QuotationBilling | null>(null);
  const [quotationLoading, setQuotationLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<ReservationAction | null>(null);
  const [paying, setPaying] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [travelersOpen, setTravelersOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [retryOp, setRetryOp] = useState<OrderOperationView | null>(null);
  const [retrying, setRetrying] = useState(false);
  const pendingAction = useRef<ReservationAction | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  const order = load.kind === 'ready' ? load.order : null;

  /** Relee la reserva. Una relectura que falla no borra lo que ya se veía. */
  const reload = useCallback(
    async (initial = false): Promise<void> => {
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
          cache: 'no-store',
        });
        const read = await readJson<{ order?: Order | null; error?: string }>(res);
        const fresh = read.ok && res.ok ? read.data.order : null;
        if (!fresh) {
          if (initial) {
            setLoad({
              kind: 'error',
              notFound: res.status === 404,
              message:
                res.status === 404
                  ? 'No encontramos esta reserva. Puede que sea de otra agencia o que el enlace esté mal.'
                  : ((read.ok ? read.data.error : undefined) ??
                    'No se pudo cargar la reserva. Inténtalo de nuevo.'),
            });
          }
          return;
        }
        setLoad({
          kind: 'ready',
          order: { ...fresh, capabilities: capabilitiesForViewer(fresh.capabilities, sells) },
        });
      } catch {
        if (initial) {
          setLoad({
            kind: 'error',
            notFound: false,
            message: 'Error de conexión al cargar la reserva.',
          });
        }
      }
    },
    [orderId, sells],
  );

  useEffect(() => {
    void reload(true);
  }, [reload]);

  // El reloj de la cuenta regresiva del plazo.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Hotel y auto tienen su detalle en la lista de Reservas.
  const nonFlight = order !== null && (isHotelOrder(order) || isCarOrder(order));
  useEffect(() => {
    if (nonFlight) router.replace(`/reservas?orden=${encodeURIComponent(orderId)}`);
  }, [nonFlight, orderId, router]);

  // La facturación vive en la cotización de la que salió la reserva.
  const quotationId = order?.quotationId ?? null;
  useEffect(() => {
    if (!quotationId) return;
    let alive = true;
    setQuotationLoading(true);
    void fetch(`/api/quotations/${encodeURIComponent(quotationId)}`)
      .then(async (res) => {
        const read = await readJson<{ quotation?: QuotationBilling | null }>(res);
        if (alive) setQuotation(read.ok && res.ok ? (read.data.quotation ?? null) : null);
      })
      .catch(() => {
        if (alive) setQuotation(null);
      })
      .finally(() => {
        if (alive) setQuotationLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [quotationId]);

  const ops = useOrderOperations(orderId, `${order?.status ?? ''}|${order?.updatedAt ?? ''}`);

  const say = useCallback((next: Notice) => {
    setNotice(next);
    if (next !== null) {
      // El aviso queda arriba, junto a las acciones: se lleva la vista hasta ahí.
      requestAnimationFrame(() =>
        noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      );
    }
  }, []);

  const onIssueSettled = useCallback(
    (_orderId: string, settlement: IssueSettlement) => {
      const issued = settlement.kind === 'settled' && settlement.outcome.kind === 'issued';
      const message =
        settlement.kind === 'timeout' ? settlement.message : settlement.outcome.message;
      if (issued) toast.success(message);
      else if (settlement.kind === 'timeout') toast.message(message);
      else toast.error(message);
      say({ tone: issued ? 'ok' : 'error', text: message });
      void reload();
      void ops.reload();
    },
    [reload, ops, say],
  );
  const { tracked: issuesInFlight, track: trackIssue } = useIssueTracker(onIssueSettled);

  const offer = useMemo(() => (order ? flightOfferOf(order) : null), [order]);
  const legs = useMemo(() => (offer ? buildTimeline(offer, formatMoney) : []), [offer]);

  if (load.kind === 'loading' || nonFlight) return <DetailSkeleton />;

  if (load.kind === 'error') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-5">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-[var(--color-danger)]/10">
          <AlertTriangle aria-hidden="true" className="size-5 text-[var(--color-danger)]" />
        </span>
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          {load.notFound ? 'Reserva no encontrada' : 'No pudimos abrir la reserva'}
        </h1>
        <p role="alert" className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {load.message}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {load.notFound ? null : (
            <Button
              variant="primary"
              onClick={() => {
                setLoad({ kind: 'loading' });
                void reload(true);
              }}
            >
              Reintentar
            </Button>
          )}
          <Button asChild variant="secondary">
            <Link href="/reservas">
              <ArrowLeft aria-hidden="true" /> Ir a Reservas
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const current = load.order;
  const hero = reservationHero(current, now);
  const HeroIcon = TONE_ICON[hero.tone];
  const countdown = deadlineCountdown(current, now);
  const locator = reservationLocator(current);
  const issueInFlight = current.id in issuesInFlight;
  const cancelBlock = directCancellationBlock(ops.operations);
  const cancelBlocked = ops.loading || ops.error !== null || cancelBlock !== null;
  const actions = reservationActions(current, { issueInFlight, cancelBlocked });
  const billing = billingView(quotation, current.passengers[0]);
  const totalMinor = orderTotalMinor(current);
  const route =
    routeTitle(legs) ||
    `${current.searchCriteria.origin ?? '—'} → ${current.searchCriteria.destination ?? '—'}`;
  const dates = travelDates(legs) || current.searchCriteria.departureDate || '';
  const canCancelByStatus =
    !!current.pnr &&
    current.status !== 'cancelled' &&
    current.status !== 'failed' &&
    supportsOrderCancellation(current.capabilities, current.status);

  async function run(action: ReservationAction) {
    setNotice(null);
    switch (action) {
      case 'pay':
        setPaying(true);
        return;
      case 'issue':
        setIssuing(true);
        return;
      case 'services':
        setServicesOpen(true);
        return;
      case 'travelers':
        setTravelersOpen(true);
        return;
      case 'retrieve': {
        setBusy('retrieve');
        try {
          const result = await retrieveOrder(current);
          if (result.found) await reload();
          say({ tone: result.success ? 'ok' : 'error', text: result.message });
        } finally {
          setBusy(null);
        }
        return;
      }
      case 'resend': {
        setBusy('resend');
        try {
          const result = await sendOrderConfirmation(current.id);
          say({ tone: result.success ? 'ok' : 'error', text: result.message });
        } finally {
          setBusy(null);
        }
        return;
      }
      case 'cancel': {
        setBusy('cancel');
        try {
          const check = await checkCancellation(current.id);
          if (check.allowed) setConfirmCancel(true);
          else say({ tone: 'error', text: check.message });
        } finally {
          setBusy(null);
        }
        return;
      }
    }
  }

  async function confirmCancellation() {
    setBusy('cancel');
    try {
      const result = await cancelOrder(current.id);
      setConfirmCancel(false);
      say({ tone: result.success ? 'ok' : 'error', text: result.message });
      if (result.success) toast.success('Reserva cancelada');
      await Promise.all([reload(), ops.reload()]);
    } finally {
      setBusy(null);
    }
  }

  async function confirmRetry() {
    if (retryOp === null) return;
    setRetrying(true);
    try {
      const result = await retryCancelOperation(current.id, retryOp.id);
      say({ tone: result.success ? 'ok' : 'error', text: result.message });
      setRetryOp(null);
      await Promise.all([reload(), ops.reload()]);
    } finally {
      setRetrying(false);
    }
  }

  const primary = actions.primary;
  const PrimaryIcon = primary ? ACTION_ICON[primary] : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <Link
        href="/reservas"
        className="mb-4 inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" /> Reservas
      </Link>

      {/* Hero: el estado, el código para el pasajero y lo que hay que hacer ahora. */}
      <header
        aria-labelledby={headingId}
        className="mb-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
      >
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span
              role="status"
              aria-live="polite"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-[var(--color-fg)] ring-1 ring-inset',
                TONE_PILL[hero.tone],
              )}
            >
              <HeroIcon aria-hidden="true" className="size-3.5" />
              {hero.label}
            </span>
            {countdown ? (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-[var(--color-fg)]',
                  countdown.expired
                    ? 'bg-[var(--color-danger)]/10'
                    : countdown.urgent
                      ? 'bg-[var(--color-warning)]/15'
                      : 'bg-[var(--color-surface-muted)]',
                )}
              >
                <CalendarClock aria-hidden="true" className="size-3.5" />
                {countdown.text}
              </span>
            ) : null}
            {/* El proveedor no se nombra: es un dato interno del consolidador (ver
                `lib/provider-disclosure.ts`). Lo que sí se marca es una reserva de pruebas. */}
            <TestOrderTag order={current} detail />
          </div>

          <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              {locator ? (
                <CopyCode code={locator.code} label={locator.label} />
              ) : (
                <div>
                  <p className="text-xs font-medium text-[var(--color-fg-muted)]">
                    Código de reserva
                  </p>
                  <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                    Todavía no hay código del proveedor.
                  </p>
                </div>
              )}
              {locator?.secondary || (locator?.others.length ?? 0) > 0 ? (
                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-fg-muted)]">
                  {locator?.secondary ? (
                    <span>
                      {locator.secondary.label}:{' '}
                      <span className="select-all font-mono font-semibold text-[var(--color-fg)]">
                        {locator.secondary.code}
                      </span>
                    </span>
                  ) : null}
                  {locator?.others.map((other) => (
                    <span key={other.code}>
                      {other.label}:{' '}
                      <span className="select-all font-mono font-semibold text-[var(--color-fg)]">
                        {other.code}
                      </span>
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
            <div className="min-w-0 sm:text-right">
              <h1 id={headingId} className="text-lg font-semibold text-[var(--color-fg)]">
                {route}
              </h1>
              <p className="text-sm text-[var(--color-fg-muted)]">
                {[dates, `Reserva #${current.orderNumber}`].filter(Boolean).join(' · ')}
              </p>
              <p className="text-xs text-[var(--color-fg-subtle)]">
                Creada {formatCreatedAt(current.createdAt)}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-sm text-[var(--color-fg-muted)]">{hero.description}</p>
          {primary || actions.secondary.length > 0 ? (
            <div
              role="group"
              aria-label="Acciones de la reserva"
              className="flex shrink-0 flex-wrap gap-2"
            >
              {primary && PrimaryIcon ? (
                <Button
                  variant="primary"
                  size="lg"
                  className="h-11 flex-1 sm:h-10 sm:flex-none"
                  disabled={busy !== null}
                  onClick={() => void run(primary)}
                >
                  {busy === primary ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <PrimaryIcon aria-hidden="true" />
                  )}
                  {busy === 'retrieve' && primary === 'retrieve'
                    ? 'Consultando…'
                    : ACTION_LABELS[primary]}
                </Button>
              ) : null}
              {issueInFlight ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-[var(--color-fg-muted)]">
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  Emitiendo…
                </span>
              ) : null}
              {actions.secondary.length > 0 ? (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button
                      variant="secondary"
                      size="lg"
                      className="h-11 flex-1 sm:h-10 sm:flex-none"
                      disabled={busy !== null}
                    >
                      {busy !== null && busy !== primary ? (
                        <Loader2 aria-hidden="true" className="animate-spin" />
                      ) : (
                        <MoreHorizontal aria-hidden="true" />
                      )}
                      Más acciones
                      <ChevronDown aria-hidden="true" className="!size-3.5 opacity-60" />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={6}
                      className="z-50 min-w-[230px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
                      onCloseAutoFocus={(event) => {
                        // Lo elegido corre con el menú ya cerrado: un diálogo que se abre después
                        // se queda con el foco, en vez de devolvérselo al botón del menú.
                        const action = pendingAction.current;
                        if (action === null) return;
                        pendingAction.current = null;
                        event.preventDefault();
                        void run(action);
                      }}
                    >
                      {actions.secondary.map((action) => {
                        const Icon = ACTION_ICON[action];
                        const danger = action === 'cancel';
                        return (
                          <Fragment key={action}>
                            {danger ? (
                              <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-border)]" />
                            ) : null}
                            <DropdownMenu.Item
                              className={cn(MENU_ITEM, danger && 'text-[var(--color-danger)]')}
                              onSelect={() => {
                                pendingAction.current = action;
                              }}
                            >
                              <Icon
                                aria-hidden="true"
                                className={cn(
                                  'size-4',
                                  danger
                                    ? 'text-[var(--color-danger)]'
                                    : 'text-[var(--color-fg-muted)]',
                                )}
                              />
                              {ACTION_LABELS[action]}
                            </DropdownMenu.Item>
                          </Fragment>
                        );
                      })}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              ) : null}
            </div>
          ) : null}
        </div>

        <div ref={noticeRef} role="status" aria-live="polite">
          {notice ? (
            <p
              className={cn(
                'flex items-start gap-2 border-t px-5 py-3 text-sm text-[var(--color-fg)] sm:px-6',
                notice.tone === 'ok'
                  ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/10'
                  : 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/8',
              )}
            >
              {notice.tone === 'ok' ? (
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              ) : (
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              <span>{notice.text}</span>
            </p>
          ) : null}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="min-w-0 space-y-5">
          <Section id="reserva-itinerario" title="Itinerario" icon={Plane}>
            {offer ? (
              <ItineraryTimeline legs={legs} />
            ) : (
              <p className="text-sm text-[var(--color-fg-muted)]">
                {route}
                {dates ? ` · ${dates}` : ''}. El proveedor no guardó el detalle de los vuelos.
              </p>
            )}
            <div className="mt-4 space-y-4 empty:hidden">
              <FlightOrderTracking order={current} sections={['tickets']} />
            </div>
          </Section>

          <Section
            id="reserva-pasajeros"
            title={`Pasajeros (${current.passengers.length})`}
            icon={Users}
          >
            {current.passengers.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)]">
                La reserva no tiene pasajeros guardados.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {current.passengers.map((passenger, index) => {
                  const document = maskedDocument(passenger.identityDoc);
                  return (
                    <li
                      key={`${passenger.surname}-${index}`}
                      className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-xs font-semibold text-[var(--color-fg)]"
                      >
                        {(passenger.givenName?.[0] ?? '').toUpperCase()}
                        {(passenger.surname?.[0] ?? '').toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                          {passenger.givenName} {passenger.surname}
                        </p>
                        <p className="text-xs text-[var(--color-fg-muted)]">
                          {PAX_TYPE_LABEL[passenger.paxType] ?? passenger.paxType}
                          {document ? ` · ${document}` : ''}
                        </p>
                      </div>
                      {index === 0 ? (
                        <span className="shrink-0 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
                          Titular
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {current.contactInfo?.email || current.contactInfo?.phone ? (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-fg-muted)]">
                <span className="font-medium text-[var(--color-fg)]">Contacto</span>
                {current.contactInfo?.email ? <span>{current.contactInfo.email}</span> : null}
                {current.contactInfo?.phone ? <span>{current.contactInfo.phone}</span> : null}
              </p>
            ) : null}
            {isTestOrder(current) && actions.secondary.includes('resend') ? (
              <p className="mt-2 text-xs text-[var(--color-fg-muted)]">{TEST_ORDER_EMAIL_NOTICE}</p>
            ) : null}
          </Section>

          <Section id="reserva-facturacion" title="Facturación" icon={Receipt}>
            {quotationLoading ? (
              <div className="animate-pulse space-y-2" aria-hidden="true">
                <div className="h-4 w-48 rounded bg-[var(--color-surface-muted)]" />
                <div className="h-3 w-64 rounded bg-[var(--color-surface-muted)]" />
              </div>
            ) : billing ? (
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]"
                >
                  {billing.company ? <Building2 className="size-4" /> : <User className="size-4" />}
                </span>
                <dl className="min-w-0 space-y-0.5 text-sm">
                  <dt className="sr-only">A nombre de</dt>
                  <dd className="font-medium text-[var(--color-fg)]">{billing.name}</dd>
                  {billing.document ? (
                    <>
                      <dt className="sr-only">Documento</dt>
                      <dd className="text-xs text-[var(--color-fg-muted)]">{billing.document}</dd>
                    </>
                  ) : null}
                  {billing.email || billing.phone ? (
                    <>
                      <dt className="sr-only">Contacto</dt>
                      <dd className="text-xs text-[var(--color-fg-muted)]">
                        {[billing.email, billing.phone].filter(Boolean).join(' · ')}
                      </dd>
                    </>
                  ) : null}
                  {billing.address ? (
                    <>
                      <dt className="sr-only">Dirección</dt>
                      <dd className="text-xs text-[var(--color-fg-muted)]">{billing.address}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-fg-muted)]">
                {quotationId
                  ? 'La cotización no tiene datos de facturación guardados.'
                  : 'Esta reserva no salió de una cotización: no hay datos de facturación.'}
              </p>
            )}
            {quotationId ? (
              <Link
                href={`/cotizaciones/${encodeURIComponent(quotationId)}`}
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
              >
                <FileText aria-hidden="true" className="size-3.5" /> Ver la cotización
              </Link>
            ) : null}
          </Section>

          <Section id="reserva-condiciones" title="Condiciones" icon={ShieldCheck}>
            {offer ? (
              <OfferConditions offer={offer} />
            ) : (
              <p className="text-sm text-[var(--color-fg-muted)]">
                El proveedor no informó las condiciones de la tarifa.
              </p>
            )}
            {legs.some((leg) => leg.inclusionsSource === 'leg') ? (
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                Lo que incluye cada trayecto está en su tarjeta del itinerario.
              </p>
            ) : null}
            <div className="mt-4 space-y-4 empty:hidden">
              <TicketConditions
                order={current}
                operations={ops.operations}
                opsLoading={ops.loading}
                opsError={ops.error !== null}
                onVoidAttempted={() => {
                  void ops.reload();
                  void reload();
                }}
              />
            </div>
          </Section>

          <Section id="reserva-historial" title="Historial" icon={History}>
            <div className="mb-3 flex items-start gap-3 text-xs">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10"
              >
                <Check className="size-3.5 text-[var(--color-primary)]" />
              </span>
              <div>
                <p className="font-medium text-[var(--color-fg)]">Reserva creada</p>
                <p className="text-[var(--color-fg-muted)]">
                  {formatCreatedAt(current.createdAt)} · {formatRelativeDate(current.createdAt)}
                </p>
              </div>
            </div>
            {!ops.error && cancelBlock && canCancelByStatus ? (
              <p className="mb-3 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/12 px-3 py-2 text-xs text-[var(--color-fg)]">
                {cancelBlock}
              </p>
            ) : null}
            <OrderOperationsHistory
              state={ops}
              canRetry={(op) => canCancelByStatus && canRetryCancelOperation(op)}
              onRetry={(op) => setRetryOp(op)}
            />
            {!ops.loading && !ops.error && ops.operations.length === 0 ? (
              <p className="text-xs text-[var(--color-fg-muted)]">
                Todavía no hay otras operaciones: consultas, pagos, emisiones y cancelaciones
                aparecen aquí.
              </p>
            ) : null}
          </Section>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-6" aria-label="Precio de la reserva">
          <Section id="reserva-precio" title="Precio" icon={CreditCard}>
            <p className="font-mono text-2xl font-bold tabular-nums text-[var(--color-fg)]">
              {formatMoney(totalMinor, current.currency)}
            </p>
            <p className="mb-4 text-xs text-[var(--color-fg-muted)]">{chargeSummary(current)}</p>
            {offer ? (
              <PriceBreakdown
                offer={offer}
                totalLabel="Total reservado"
                totalMinorOverride={totalMinor}
              />
            ) : null}
            <div className="mt-4 space-y-3 border-t border-[var(--color-border)] pt-4 empty:hidden">
              <FlightOrderTracking order={current} sections={['deadline']} />
            </div>
          </Section>
        </aside>
      </div>

      {paying ? (
        <OrderPaymentDialog
          key={current.id}
          order={current}
          onClose={() => setPaying(false)}
          onPaid={(status) => {
            setPaying(false);
            setLoad({ kind: 'ready', order: { ...current, status: status ?? 'confirmed' } });
            say({ tone: 'ok', text: 'Pago procesado exitosamente' });
            toast.success('Pago procesado');
            void reload();
            void ops.reload();
          }}
          onLinkSent={(message) => {
            say({ tone: 'ok', text: message });
            void ops.reload();
          }}
        />
      ) : null}

      {issuing ? (
        <IssueTicketDialog
          key={current.id}
          order={current}
          onClose={() => setIssuing(false)}
          onRequested={(operationId) => {
            trackIssue(current.id, operationId);
            toast.message(ISSUE_MESSAGES.started);
            say({ tone: 'ok', text: ISSUE_MESSAGES.started });
            setIssuing(false);
            void ops.reload();
          }}
        />
      ) : null}

      {servicesOpen ? (
        <AddServicesSheet
          key={current.id}
          order={current}
          onClose={() => setServicesOpen(false)}
          onChanged={() => void reload()}
        />
      ) : null}

      {travelersOpen ? (
        <EditTravelersSheet
          key={current.id}
          order={current}
          onClose={() => setTravelersOpen(false)}
          onChanged={() => void reload()}
        />
      ) : null}

      {confirmCancel ? (
        <ConfirmDialog
          title={`Cancelar reserva #${current.orderNumber}`}
          message={`¿Seguro que quieres cancelar esta reserva${
            current.pnr ? ` (PNR ${current.pnr})` : ''
          }? Esta acción no se puede deshacer.`}
          note={walletReleaseNote(current)}
          confirmLabel="Sí, cancelar reserva"
          danger
          loading={busy === 'cancel'}
          onClose={() => setConfirmCancel(false)}
          onConfirm={confirmCancellation}
        />
      ) : null}

      {retryOp ? (
        <ConfirmDialog
          title="Reintentar la cancelación"
          message="La cancelación anterior falló antes de llegar al proveedor. ¿Reintentarla ahora?"
          note={walletReleaseNote(current)}
          confirmLabel="Sí, reintentar"
          danger
          loading={retrying}
          onClose={() => setRetryOp(null)}
          onConfirm={confirmRetry}
        />
      ) : null}
    </div>
  );
}
