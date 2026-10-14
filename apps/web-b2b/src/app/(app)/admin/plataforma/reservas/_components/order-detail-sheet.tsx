'use client';

import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NodeKindBadge } from '../../../../../../components/network/node-kind';
import { Button } from '../../../../../../components/ui/button';
import { ModalPortal, useModalBehavior } from '../../../../../../components/ui/dialog';
import { ToneBadge, ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import { formatMoney } from '../../../../../../lib/flight-format';
import { orderProviderLabel, orderVerticalOf } from '../../../../../../lib/order-vertical';
import {
  canRetryFromConsole,
  providerReadingLinesOf,
  type PlatformOrderAction,
  type ProviderReadingView,
} from '../../../../../../lib/platform-order-actions';
import { PLATFORM_TIME_ZONE } from '../../../../../../lib/platform-overview';
import {
  ORDER_STATUS_VIEW,
  RECONCILIATION_SEVERITY_VIEW,
  WALLET_HOLD_VIEW,
  eventText,
  formatOrderDate,
  orderSheetTitle,
  passengerLine,
  reconciliationActionLabel,
  reconciliationKindLabel,
  statusMismatch,
  walletHoldHint,
  type PlatformOrderDetail,
  type PlatformOrderRow,
} from '../../../../../../lib/platform-orders';
import { loadPlatformOrder } from '../../../../../../lib/platform-orders-client';
import type { OrderOperationView } from '../../../../reservas/cancel-retry-policy';
import { HotelOrderStatusChip } from '../../../../reservas/_components/hotel-order-status';
import {
  OrderOperationsHistory,
  type OrderOperationsState,
} from '../../../../reservas/_components/order-operations-history';
import {
  hcnViewOf,
  hotelOrderStateOf,
  parseHotelTracking,
  providerStatusViewOf,
} from '../../../../reservas/hotel-order-view';
import { OrderActionDialog, type OrderActionDone } from './order-action-dialog';
import { OrderActions } from './order-actions';
import { AttentionFlag } from './orders-table';

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly detail: PlatformOrderDetail };

export const AUDIT_FOOTNOTE =
  'Abriste esta reserva como superadmin: queda registrado en la auditoría.';

/**
 * La ficha de una reserva de cualquier nodo: panel a la derecha en el escritorio, pantalla completa
 * en el teléfono. Se cierra con la X, Escape o el fondo.
 *
 * Su pie tiene la post-venta del superadmin (OrderActions: consultar, reenviar, cancelar) y el
 * historial ofrece "Reintentar" en una cancelación que falló; cada una se confirma con su motivo
 * (OrderActionDialog). Después de una acción la ficha se relee sin volver al esqueleto, y la lista
 * de atrás se actualiza (`onChanged`): una cancelación cambia el estado de la fila.
 *
 * Mientras llega la ficha, el título sale de la fila que se tocó (`preview`); si se abrió desde un
 * enlace (`?orden=`), dice "Reserva" hasta que llega.
 */
export function OrderDetailSheet({
  orderId,
  preview,
  onClose,
  onChanged,
}: {
  orderId: string;
  preview: Pick<PlatformOrderRow, 'orderNumber' | 'tenantName'> | null;
  onClose: () => void;
  /** Una acción cambió la reserva (o pudo cambiarla): la lista de atrás se relee. */
  onChanged?: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);
  const titleId = useId();
  const subtitleId = useId();

  const load = useCallback(async () => {
    const id = ++request.current;
    setState({ status: 'loading' });
    const res = await loadPlatformOrder(orderId);
    if (id !== request.current) return;
    setNow(Date.now());
    setState(
      res.ok ? { status: 'ready', detail: res.data } : { status: 'error', message: res.message },
    );
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Relee la ficha sin el esqueleto; si falla, deja la que había y lo avisa. */
  const refresh = useCallback(async () => {
    const id = ++request.current;
    const res = await loadPlatformOrder(orderId);
    if (id !== request.current) return;
    if (!res.ok) {
      toast.error(`No pudimos actualizar la ficha: ${res.message}`);
      return;
    }
    setNow(Date.now());
    setState({ status: 'ready', detail: res.data });
  }, [orderId]);

  const [action, setAction] = useState<PlatformOrderAction | null>(null);
  /** La última consulta al proveedor desde esta ficha (en vuelos no queda guardada en la reserva). */
  const [reading, setReading] = useState<{
    readonly orderId: string;
    readonly reading: ProviderReadingView;
  } | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const done = useCallback(
    (result: OrderActionDone) => {
      setAction(null);
      if (result.reading !== undefined) setReading({ orderId, reading: result.reading });
      if (result.detail !== undefined) {
        // La ficha que devolvió la acción es la más nueva: una lectura anterior en vuelo no la pisa.
        request.current += 1;
        setNow(Date.now());
        setState({ status: 'ready', detail: result.detail });
      } else {
        void refresh();
      }
      onChangedRef.current?.();
    },
    [orderId, refresh],
  );

  const panelRef = useModalBehavior(true, onClose);
  const detail = state.status === 'ready' ? state.detail : null;
  const title =
    detail !== null
      ? orderSheetTitle(detail.order.orderNumber, detail.tenant.name)
      : orderSheetTitle(preview?.orderNumber ?? null, preview?.tenantName ?? null);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex justify-end">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={onClose}
          aria-hidden
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={detail !== null ? subtitleId : undefined}
          aria-busy={state.status === 'loading' || undefined}
          className="relative flex w-full flex-col bg-[var(--color-surface)] shadow-[var(--shadow-xl)] motion-safe:animate-fade-in-up sm:max-w-[640px] sm:border-l sm:border-[var(--color-border)] motion-safe:sm:animate-sheet-in"
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-border)] px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
            <div className="min-w-0 flex-1 pt-0.5">
              <h2
                id={titleId}
                className="text-base font-semibold leading-snug text-[var(--color-fg)] [overflow-wrap:anywhere]"
              >
                {title}
              </h2>
              {detail !== null ? (
                <p
                  id={subtitleId}
                  className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-muted)]"
                >
                  <NodeKindBadge node={detail.tenant} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {detail.tenant.path.length > 1
                      ? detail.tenant.path.map((n) => n.name).join(' › ')
                      : detail.tenant.name}
                  </span>
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar la ficha"
              className="-mr-2 -mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          <div className="scroll-panel relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div
              className={cn(
                'px-5 pt-4',
                detail !== null ? 'pb-6' : 'pb-[max(1.5rem,env(safe-area-inset-bottom))]',
              )}
            >
              {state.status === 'loading' ? (
                <div className="space-y-4" aria-live="polite">
                  <span className="sr-only">Cargando la reserva…</span>
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-24 animate-pulse rounded-lg bg-[var(--color-surface-muted)]"
                    />
                  ))}
                </div>
              ) : state.status === 'error' ? (
                <div role="alert" className="py-8 text-center">
                  <p className="mx-auto max-w-sm text-sm font-medium text-[var(--color-fg)]">
                    {state.message}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-4"
                    onClick={() => void load()}
                  >
                    <RefreshCw aria-hidden="true" />
                    Reintentar
                  </Button>
                </div>
              ) : (
                <OrderDetailContent
                  detail={state.detail}
                  now={now}
                  onRetry={(op) => setAction({ kind: 'retry-cancel', operationId: op.id })}
                  {...(reading !== null && reading.orderId === orderId
                    ? { reading: reading.reading }
                    : {})}
                />
              )}
            </div>
          </div>
          {detail !== null ? <OrderActions detail={detail} onAction={setAction} /> : null}
        </div>
      </div>
      {action !== null && detail !== null ? (
        <OrderActionDialog
          action={action}
          detail={detail}
          onClose={() => setAction(null)}
          onDone={done}
        />
      ) : null}
    </ModalPortal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <h3
        id={id}
        className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-xs text-[var(--color-fg-muted)]">{children}</p>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm text-[var(--color-fg)] [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

/**
 * Lo que respondió el proveedor en la última consulta desde la ficha. `stored`: la reserva guarda
 * su lectura (hoteles); si no, se aclara que es sólo lo que se vio ahora.
 */
function ProviderReading({ reading, stored }: { reading: ProviderReadingView; stored: boolean }) {
  const view = providerReadingLinesOf(reading);
  return (
    <>
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[var(--color-fg)]">{view.headline}</span>
        {view.code !== null ? (
          <code className="text-[11px] text-[var(--color-fg-muted)]">{view.code}</code>
        ) : null}
      </p>
      {view.details.map((line) => (
        <p key={line} className="text-[11px] text-[var(--color-fg-muted)] [overflow-wrap:anywhere]">
          {line}
        </p>
      ))}
      {reading.readAt !== null ? (
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          Consultado <time dateTime={reading.readAt}>{formatOrderDate(reading.readAt)}</time>
          {stored ? '.' : '. Es una lectura en vivo: no queda guardada en la reserva.'}
        </p>
      ) : null}
    </>
  );
}

const noRetry = () => false;
const noop = () => undefined;
const reloadNothing = (): Promise<void> => Promise.resolve();

/**
 * Lo que se ve con la ficha ya leída. Sin estado propio: se prueba renderizándolo. Con `onRetry`, el
 * historial ofrece "Reintentar" en la cancelación que falló antes de enviarse (la regla de la agencia).
 * `reading`: la última consulta al proveedor desde la ficha; se muestra si la reserva no tiene una
 * lectura guardada (los vuelos no la guardan).
 */
export function OrderDetailContent({
  detail,
  now,
  onRetry,
  reading,
}: {
  detail: PlatformOrderDetail;
  now: number;
  onRetry?: (operation: OrderOperationView) => void;
  reading?: ProviderReadingView;
}) {
  const { order } = detail;
  const hotel = orderVerticalOf(order) === 'hotels';
  const tracking = parseHotelTracking(order.providerTracking);
  const providerView = providerStatusViewOf(tracking, PLATFORM_TIME_ZONE);
  const hcn = hotel ? hcnViewOf(order) : undefined;
  const mismatch = statusMismatch(order);
  const platformStatus = ORDER_STATUS_VIEW[order.status];
  // El historial de las Reservas de la agencia; el reintento lo confirma OrderActionDialog.
  const operations: OrderOperationsState = {
    operations: detail.operations,
    loading: false,
    error: null,
    reload: reloadNothing,
  };
  const hold = detail.walletHold;
  const holdHint = hold === null ? null : walletHoldHint(hold);

  return (
    <div className="space-y-7">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label="Producto">{orderProviderLabel(order)}</Fact>
        <Fact label="Localizador">
          {order.pnr !== null ? <span className="font-mono">{order.pnr}</span> : 'Sin localizador'}
        </Fact>
        {order.providerBookingRef !== null ? (
          <Fact label="Referencia">
            <span className="font-mono text-xs">{order.providerBookingRef}</span>
          </Fact>
        ) : null}
        <Fact label="Creada">{formatOrderDate(order.createdAt)}</Fact>
        <Fact label="Vendedor">
          {detail.seller === null
            ? 'Usuario eliminado'
            : detail.seller.name !== null
              ? `${detail.seller.name} · ${detail.seller.email}`
              : detail.seller.email}
        </Fact>
      </dl>

      <Section title="Estado">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <dt className="text-[11px] text-[var(--color-fg-muted)]">En la plataforma</dt>
            <dd className="mt-1.5">
              {hotel ? (
                <HotelOrderStatusChip state={hotelOrderStateOf(order)} />
              ) : (
                <ToneBadge tone={platformStatus.tone}>{platformStatus.label}</ToneBadge>
              )}
            </dd>
          </div>
          <div
            className={cn(
              'rounded-lg border p-3',
              mismatch !== null
                ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5'
                : 'border-[var(--color-border)]',
            )}
          >
            <dt className="text-[11px] text-[var(--color-fg-muted)]">En el proveedor</dt>
            <dd className="mt-1.5 space-y-1">
              {providerView !== undefined ? (
                <>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]">
                      {providerView.label}
                    </span>
                    <code className="text-[11px] text-[var(--color-fg-muted)]">
                      {providerView.code}
                    </code>
                  </p>
                  {providerView.seen !== undefined ? (
                    <p className="text-[11px] text-[var(--color-fg-muted)]">
                      Leído {providerView.seen}
                    </p>
                  ) : null}
                </>
              ) : reading !== undefined ? (
                <ProviderReading reading={reading} stored={hotel} />
              ) : (
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Sin lectura guardada del proveedor.
                </p>
              )}
            </dd>
          </div>
        </dl>
        {mismatch !== null ? (
          <ToneNotice tone="danger" role="status">
            {mismatch}
          </ToneNotice>
        ) : null}
        {hcn !== undefined ? (
          <p className="text-xs text-[var(--color-fg-muted)]">
            Confirmación del hotel (HCN):{' '}
            <span className="font-medium text-[var(--color-fg)]">
              {hcn.value !== undefined ? <span className="font-mono">{hcn.value}</span> : hcn.label}
            </span>
          </p>
        ) : null}
        {detail.attention.length > 0 ? (
          <ul className="flex flex-col items-start gap-1.5" aria-label="Por qué requiere atención">
            {detail.attention.map((a) => (
              <li key={a.reason}>
                <AttentionFlag attention={a} now={now} />
              </li>
            ))}
          </ul>
        ) : null}
        {order.status === 'failed' && order.errorMessage !== null ? (
          <p className="break-words text-xs text-[var(--color-fg-muted)]">
            Error registrado: <span className="text-[var(--color-fg)]">{order.errorMessage}</span>
          </p>
        ) : null}
      </Section>

      <Section title="Cliente y pasajeros">
        {order.passengers.length > 0 ? (
          <ul className="space-y-1 text-sm text-[var(--color-fg)]">
            {order.passengers.map((p, i) => (
              <li key={`${i}-${p.givenName}-${p.surname}`}>{passengerLine(p)}</li>
            ))}
          </ul>
        ) : (
          <Quiet>Sin pasajeros registrados.</Quiet>
        )}
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          <Fact label="Correo de contacto">{order.contact.email ?? 'Sin correo'}</Fact>
          <Fact label="Teléfono">{order.contact.phone ?? 'Sin teléfono'}</Fact>
        </dl>
      </Section>

      <Section title="Importe">
        <p className="text-xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
          {formatMoney(order.totalAmount, order.currency)}
        </p>
        <Quiet>Precio de venta al cliente, en {order.currency}.</Quiet>
      </Section>

      {detail.operations.length > 0 ? (
        <OrderOperationsHistory
          state={operations}
          canRetry={
            onRetry === undefined
              ? noRetry
              : (op: OrderOperationView) => canRetryFromConsole(detail, op)
          }
          onRetry={onRetry ?? noop}
        />
      ) : (
        <Section title="Historial de operaciones">
          <Quiet>Sin operaciones de post-venta.</Quiet>
        </Section>
      )}

      <Section title="Cartera">
        {hold === null ? (
          <Quiet>Sin retención de cartera para esta reserva.</Quiet>
        ) : (
          <div className="space-y-1.5">
            <p className="flex flex-wrap items-center gap-2">
              <ToneBadge tone={WALLET_HOLD_VIEW[hold.status].tone}>
                {WALLET_HOLD_VIEW[hold.status].label}
              </ToneBadge>
              <span className="font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                {formatMoney(hold.saleAmountMinor, hold.currency)}
              </span>
            </p>
            {holdHint !== null ? <Quiet>{holdHint}</Quiet> : null}
            <Quiet>
              {[
                // Exenta (vendió con su cuenta propia) no bloqueó saldo en ninguna cartera.
                `${hold.status === 'exempt' ? 'Registrada' : 'Retenida'} el ${formatOrderDate(hold.createdAt)}`,
                hold.capturedAt !== null ? `cobrada el ${formatOrderDate(hold.capturedAt)}` : null,
                hold.closedAt !== null ? `cerrada el ${formatOrderDate(hold.closedAt)}` : null,
              ]
                .filter((p): p is string => p !== null)
                .join(' · ')}
            </Quiet>
          </div>
        )}
      </Section>

      <Section title="Conciliación">
        {detail.reconciliation.length === 0 ? (
          <Quiet>Sin diferencias con el proveedor.</Quiet>
        ) : (
          <ul className="space-y-1.5">
            {detail.reconciliation.map((item, i) => {
              const severity = RECONCILIATION_SEVERITY_VIEW[item.severity];
              return (
                <li
                  key={`${item.kind}-${item.createdAt}-${i}`}
                  className="flex flex-col gap-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[var(--color-fg)]">
                        {reconciliationKindLabel(item.kind)}
                      </span>
                      <ToneBadge tone={severity.tone}>{severity.label}</ToneBadge>
                    </p>
                    <p className="text-[var(--color-fg-muted)]">
                      {reconciliationActionLabel(item.action)}
                    </p>
                  </div>
                  <time dateTime={item.createdAt} className="shrink-0 text-[var(--color-fg-muted)]">
                    {formatOrderDate(item.createdAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Actividad">
        {detail.events.length === 0 ? (
          <Quiet>Sin actividad registrada.</Quiet>
        ) : (
          <ol className="space-y-2 border-l border-[var(--color-border)] pl-3">
            {detail.events.map((e) => (
              <li key={e.id} className="text-xs">
                <p className="font-medium text-[var(--color-fg)]">{eventText(e)}</p>
                <p className="text-[var(--color-fg-muted)]">
                  <time dateTime={e.occurredAt}>{formatOrderDate(e.occurredAt)}</time>
                  {e.actorEmail !== null ? ` · ${e.actorEmail}` : ''}
                </p>
                {e.adminAction?.reason ? (
                  <p className="mt-0.5 break-words text-[var(--color-fg-muted)]">
                    Motivo: <span className="text-[var(--color-fg)]">{e.adminAction.reason}</span>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <p className="flex items-start gap-2 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-fg-muted)]">
        <ShieldCheck aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        {AUDIT_FOOTNOTE}
      </p>
    </div>
  );
}
