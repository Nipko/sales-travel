'use client';

import { Clock, FileText, Mail, Phone, Receipt, RefreshCw, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/ui/button';
import { useModalBehavior } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';
import { readJson } from '../../../../lib/read-json';
import { hotelContentAction } from '../../hoteles/[hotelKey]/actions';
import {
  addressLine,
  type HotelContent,
} from '../../hoteles/[hotelKey]/_components/hotel-content-view';
import { formatMoney, rateBoardLabel } from '../../hoteles/_components/hotel-format';
import { encodeHotelKey } from '../../hoteles/_components/hotel-key';
import { RefundTag } from '../../hoteles/_components/hotel-rate-item';
import { atHotelCharges } from '../../hoteles/_components/hotel-rate-view';
import { CancelPolicy } from '../../hoteles/checkout/_components/cancel-policy';
import { NonRefundableNotice } from '../../hoteles/checkout/_components/non-refundable-notice';
import { RateConditions } from '../../hoteles/checkout/_components/rate-conditions';
import { directCancellationBlock } from '../cancel-retry-policy';
import { hotelCancellationBlock } from '../hotel-cancellation-view';
import {
  guestContactOf,
  hcnViewOf,
  hotelConditionsOf,
  hotelNonRefundableOf,
  hotelOrderStateOf,
  hotelPackOf,
  hotelReadResultOf,
  hotelRefOf,
  hotelRoomsOf,
  hotelStayOf,
  hotelVoucherAvailable,
  parseHotelTracking,
  providerStatusViewOf,
  type HotelOrderInput,
  type HotelOrderTracking,
  type HotelReadResult,
} from '../hotel-order-view';
import {
  supportsOrderCancellation,
  supportsOrderCapability,
  type OrderCapabilities,
} from '../order-capabilities';
import { HotelOrderNoticeBox, HotelOrderStatusChip } from './hotel-order-status';
import { OrderOperationsHistory, useOrderOperations } from './order-operations-history';

/*
 * El detalle de una reserva de hotel en Mis Reservas (docs/tbo/09 PR-6.5; U-15 a U-17): el estado
 * con su subestado, la reserva en el proveedor (localizador, estado leído y número de confirmación
 * del hotel) con "Actualizar estado", el hotel, las habitaciones con sus huéspedes, lo que se paga
 * en el hotel, la política y las condiciones que se aceptaron al reservar, el voucher, la
 * confirmación por correo y la cancelación. Una tarifa no reembolsable lo dice arriba, con el 100 %
 * y cuándo lo aceptó el vendedor (pedido del 2026-09-29, punto d).
 *
 * Todo sale de la orden guardada y del seguimiento, que trae sólo códigos: la única lectura al
 * proveedor es la que pide el vendedor con "Actualizar estado".
 */

export type HotelOrderDetailOrder = HotelOrderInput & {
  readonly capabilities?: Partial<OrderCapabilities>;
};

type ContentState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly content: HotelContent }
  | { readonly kind: 'none' };

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3
          id={id}
          className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]"
        >
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-[var(--color-fg)]">{children}</dd>
    </div>
  );
}

export function HotelOrderDetail({
  order,
  suspended,
  onClose,
  onCancelRequest,
  onTrackingChange,
}: {
  order: HotelOrderDetailOrder;
  /** Hay otro diálogo encima (la cancelación): éste suelta el foco y el teclado mientras tanto. */
  suspended: boolean;
  onClose: () => void;
  /**
   * Abre la cancelación con su penalidad estimada; con `retryOperationId`, para reintentar ese
   * intento fallido del historial.
   */
  onCancelRequest: (retryOperationId?: string) => void;
  /** "Actualizar estado" trajo el seguimiento nuevo. */
  onTrackingChange: (tracking: HotelOrderTracking) => void;
}) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // Estable: si cambiara en cada render del padre, el modal volvería a tomar el foco cada vez.
  const close = useCallback(() => onCloseRef.current(), []);
  const panelRef = useModalBehavior(!suspended, close);
  const titleId = useId();

  const state = hotelOrderStateOf(order);
  const tracking = parseHotelTracking(order.providerTracking);
  const providerStatus = providerStatusViewOf(tracking);
  const hcn = hcnViewOf(order);
  const stay = hotelStayOf(order);
  const rooms = hotelRoomsOf(order);
  const pack = hotelPackOf(order);
  const conditions = hotelConditionsOf(order);
  const contact = guestContactOf(order);
  const atHotel = pack ? atHotelCharges(pack) : [];
  const voucher = hotelVoucherAvailable(order);
  const nonRefundable = hotelNonRefundableOf(order);
  const showNonRefundable =
    nonRefundable !== undefined && order.status !== 'failed' && order.status !== 'cancelled';
  const ops = useOrderOperations(
    order.id,
    `${order.status}|${JSON.stringify(order.providerTracking ?? null)}`,
  );

  const canCancelByStatus =
    !!order.pnr &&
    order.status !== 'cancelled' &&
    order.status !== 'failed' &&
    supportsOrderCancellation(order.capabilities, order.status, tracking);
  const cancelBlock = directCancellationBlock(ops.operations);
  const canCancel = canCancelByStatus && !ops.loading && !ops.error && !cancelBlock;
  const canRefresh = !!order.pnr && supportsOrderCapability(order.capabilities, 'retrieve');

  // Al cerrar la cancelación se relee el historial aunque la orden no haya cambiado: un reintento
  // que vuelve a fallar antes de enviarse suma un intento a la misma fila.
  const reloadOps = ops.reload;
  const wasSuspended = useRef(suspended);
  useEffect(() => {
    if (wasSuspended.current && !suspended) void reloadOps();
    wasSuspended.current = suspended;
  }, [suspended, reloadOps]);

  // ── La ficha del hotel: nombre, dirección y horarios. El detalle se ve igual sin ella.
  const [content, setContent] = useState<ContentState>({ kind: 'loading' });
  const ref = hotelRefOf(order);
  const hotelKey = ref === undefined ? undefined : encodeHotelKey([ref]);
  useEffect(() => {
    if (hotelKey === undefined) {
      setContent({ kind: 'none' });
      return;
    }
    let alive = true;
    setContent({ kind: 'loading' });
    hotelContentAction(hotelKey)
      .then((result) => {
        const found = result.outcomes[0]?.content;
        if (alive) setContent(found ? { kind: 'ok', content: found } : { kind: 'none' });
      })
      .catch(() => {
        if (alive) setContent({ kind: 'none' });
      });
    return () => {
      alive = false;
    };
  }, [hotelKey]);

  // ── "Actualizar estado": BookingDetail a pedido (U-16).
  const [reading, setReading] = useState(false);
  const [readResult, setReadResult] = useState<HotelReadResult | null>(null);
  async function refresh() {
    setReading(true);
    setReadResult(null);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}/retrieve`, {
        method: 'POST',
      });
      const read = await readJson<unknown>(res);
      const result: HotelReadResult = read.ok
        ? hotelReadResultOf(res.status, read.data)
        : { ok: false, message: read.message };
      setReadResult(result);
      if (result.ok && result.tracking) onTrackingChange(result.tracking);
    } catch {
      setReadResult({ ok: false, message: 'Error de conexión. Prueba de nuevo en unos segundos.' });
    } finally {
      setReading(false);
    }
  }

  // ── La confirmación por correo al huésped (la misma ruta que vuelos, con la plantilla de hotel).
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  async function sendConfirmation() {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}/send-confirmation`, {
        method: 'POST',
      });
      const read = await readJson<{ sent?: boolean; to?: string; error?: string }>(res);
      if (!read.ok || !res.ok) {
        setSendResult({
          ok: false,
          text: (read.ok ? read.data.error : read.message) ?? 'No se pudo enviar la confirmación.',
        });
        return;
      }
      setSendResult(
        read.data.sent
          ? { ok: true, text: `Confirmación enviada a ${read.data.to ?? contact.email ?? ''}.` }
          : { ok: false, text: 'La agencia no tiene un correo de salida configurado.' },
      );
    } catch {
      setSendResult({ ok: false, text: 'Error de conexión. Prueba de nuevo en unos segundos.' });
    } finally {
      setSending(false);
    }
  }

  const hotel = content.kind === 'ok' ? content.content : undefined;
  const address = hotel ? addressLine(hotel) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
                Reserva #{order.orderNumber}
              </h2>
              <HotelOrderStatusChip state={state} />
              {nonRefundable ? (
                <RefundTag badge={{ tone: 'warning', label: 'No reembolsable' }} />
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
              Hotel{stay ? ` · ${stay.dates}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <HotelOrderNoticeBox state={state} />
          {showNonRefundable ? (
            <NonRefundableNotice nonRefundable={nonRefundable} headingLevel={3}>
              {nonRefundable.acknowledgedAt ? (
                <p className="text-xs text-[var(--color-fg-muted)]">
                  El vendedor lo confirmó al reservar, el {nonRefundable.acknowledgedAt}.
                </p>
              ) : null}
            </NonRefundableNotice>
          ) : null}

          <Section
            title="Reserva en el proveedor"
            aside={
              canRefresh ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={reading}
                  onClick={() => void refresh()}
                  className="gap-1.5 text-xs"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn('size-3.5', reading && 'animate-spin')}
                  />
                  {reading ? 'Consultando…' : 'Actualizar estado'}
                </Button>
              ) : null
            }
          >
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-[var(--color-border)] p-3 sm:grid-cols-2">
              <Fact label="Localizador del proveedor">
                {order.pnr ? (
                  <span className="font-mono font-semibold">{order.pnr}</span>
                ) : (
                  <span className="text-[var(--color-fg-muted)]">Todavía sin localizador</span>
                )}
              </Fact>
              <Fact label="Confirmación del hotel (HCN)">
                {hcn ? (
                  <>
                    <span className={cn(hcn.value ? 'font-mono font-semibold' : 'font-medium')}>
                      {hcn.label}
                    </span>
                    {hcn.detail ? (
                      <span className="mt-0.5 block text-[11px] text-[var(--color-fg-muted)]">
                        {hcn.detail}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[var(--color-fg-muted)]">—</span>
                )}
              </Fact>
              <Fact label="Estado en el proveedor">
                {providerStatus ? (
                  <>
                    <span className="font-medium">{providerStatus.label}</span>{' '}
                    <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                      {providerStatus.code}
                    </span>
                    {providerStatus.seen ? (
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
                        <Clock aria-hidden="true" className="size-3" />
                        {providerStatus.seen}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[var(--color-fg-muted)]">Todavía sin lecturas</span>
                )}
              </Fact>
              <Fact label="Total">
                <span className="font-mono font-semibold tabular-nums">
                  {formatMoney({ amountMinor: order.totalAmount, currency: order.currency })}
                </span>
              </Fact>
            </dl>
            <div aria-live="polite">
              {readResult ? (
                <p
                  className={cn(
                    'mt-2 rounded-md border px-2.5 py-2 text-[11px]',
                    readResult.ok
                      ? 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                      : 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 text-[var(--color-fg)]',
                  )}
                >
                  {readResult.message}
                </p>
              ) : null}
            </div>
          </Section>

          <Section title="Hotel">
            {content.kind === 'loading' ? (
              <div className="space-y-1.5" aria-hidden>
                <div className="h-4 w-48 animate-pulse rounded bg-[var(--color-surface-muted)]" />
                <div className="h-3 w-64 animate-pulse rounded bg-[var(--color-surface-muted)]" />
              </div>
            ) : hotel ? (
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-[var(--color-fg)]">
                  {hotel.name ?? 'Hotel'}
                  {hotel.stars ? (
                    <span className="ml-1.5 text-xs font-normal text-[var(--color-fg-muted)]">
                      {hotel.stars} estrellas
                    </span>
                  ) : null}
                </p>
                {address ? <p className="text-xs text-[var(--color-fg-muted)]">{address}</p> : null}
                {hotel.phone ? (
                  <p className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
                    <Phone aria-hidden="true" className="size-3" />
                    {hotel.phone}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-[var(--color-fg-muted)]">
                No pudimos cargar la ficha del hotel. La reserva no cambia: el voucher sale igual.
              </p>
            )}
            {stay ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                <Fact label="Entrada">
                  {stay.checkinLabel}
                  {hotel?.checkInTime ? (
                    <span className="block text-[11px] text-[var(--color-fg-muted)]">
                      desde las {hotel.checkInTime}
                    </span>
                  ) : null}
                </Fact>
                <Fact label="Salida">
                  {stay.checkoutLabel}
                  {hotel?.checkOutTime ? (
                    <span className="block text-[11px] text-[var(--color-fg-muted)]">
                      hasta las {hotel.checkOutTime}
                    </span>
                  ) : null}
                </Fact>
                {pack ? <Fact label="Régimen">{rateBoardLabel(pack)}</Fact> : null}
              </dl>
            ) : null}
            {stay ? (
              <p className="mt-2 text-[11px] text-[var(--color-fg-muted)]">{stay.summary}</p>
            ) : null}
          </Section>

          <Section title={`Habitaciones y huéspedes (${rooms.length})`}>
            <ul className="space-y-2">
              {rooms.map((room) => (
                <li
                  key={room.number}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2.5"
                >
                  <p className="text-xs font-medium text-[var(--color-fg)]">
                    Habitación {room.number} · {room.name}
                  </p>
                  {room.occupancy ? (
                    <p className="text-[11px] text-[var(--color-fg-muted)]">{room.occupancy}</p>
                  ) : null}
                  {room.guests.length > 0 ? (
                    <ul className="mt-1.5 space-y-1">
                      {room.guests.map((g, i) => (
                        <li key={i} className="flex items-start justify-between gap-3 text-xs">
                          <span className="min-w-0 text-[var(--color-fg)]">
                            {g.name}
                            {g.registeredAs ? (
                              <span className="block text-[11px] text-[var(--color-fg-muted)]">
                                En la reserva del hotel: {g.registeredAs}
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[11px] text-[var(--color-fg-muted)]">
                            {g.type}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>

          {atHotel.length > 0 ? (
            <div className="rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-3 py-2 text-[11px] text-[var(--color-fg)]">
              <p className="flex items-center gap-1 font-medium">
                <Receipt aria-hidden="true" className="size-3 shrink-0" />A pagar en el hotel,
                aparte del total
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {atHotel.map((c, i) => (
                  <li key={i}>
                    {c.description}
                    {c.room === undefined ? '' : ` (habitación ${c.room})`}:{' '}
                    <span className="font-medium tabular-nums">{c.amount}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pack ? <CancelPolicy pack={pack} nonRefundable={nonRefundable !== undefined} /> : null}
          {pack ? <RateConditions conditions={conditions} defaultOpen={false} /> : null}

          {contact.email || contact.phone ? (
            <Section title="Contacto del huésped">
              <p className="text-xs text-[var(--color-fg-muted)]">
                {[contact.email, contact.phone].filter(Boolean).join(' · ')}
              </p>
            </Section>
          ) : null}

          {!ops.error && cancelBlock && canCancelByStatus ? (
            <p className="rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-2.5 py-2 text-[11px] text-[var(--color-fg)]">
              {cancelBlock}
            </p>
          ) : null}
          <OrderOperationsHistory
            state={ops}
            canRetry={(op) =>
              canCancelByStatus && hotelCancellationBlock(ops.operations, op.id) === null
            }
            onRetry={(op) => onCancelRequest(op.id)}
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] p-4">
          {sendResult ? (
            <p
              role={sendResult.ok ? 'status' : 'alert'}
              className={cn(
                'mr-auto text-[11px]',
                sendResult.ok ? 'text-[var(--color-fg-muted)]' : 'text-[var(--color-danger)]',
              )}
            >
              {sendResult.text}
            </p>
          ) : null}
          {voucher && contact.email ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={sending}
              onClick={() => void sendConfirmation()}
              className="gap-1.5 text-xs"
            >
              <Mail aria-hidden="true" className="size-3.5" />
              {sending ? 'Enviando…' : 'Enviar confirmación'}
            </Button>
          ) : null}
          {voucher ? (
            <Button asChild variant="secondary" size="sm" className="gap-1.5 text-xs">
              <a
                href={`/api/orders/${encodeURIComponent(order.id)}/voucher`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText aria-hidden="true" className="size-3.5" /> Voucher (PDF)
                <span className="sr-only"> (se abre en otra pestaña)</span>
              </a>
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onCancelRequest()}
              className="gap-1.5 text-xs text-red-600 hover:text-red-700"
            >
              <XCircle aria-hidden="true" className="size-3.5" /> Cancelar reserva
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={close}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
