'use client';

import {
  AlertTriangle,
  Clock,
  CreditCard,
  Eye,
  Package,
  Plane,
  RefreshCw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/cn';
import { PaymentForm, type PaymentData } from '../cotizaciones/[id]/payment-form';

interface Segment {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
}

interface Passenger {
  givenName: string;
  surname: string;
  paxType: string;
  birthdate?: string;
  identityDoc?: { type?: string; number?: string };
}

interface Order {
  id: string;
  pnr: string | null;
  status: string;
  orderNumber: number;
  provider?: string;
  searchCriteria: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    tripType: string;
  };
  selectedOffer?: {
    itineraries?: { segments: Segment[]; totalDurationMinutes: number; stops: number }[];
    fareFamily?: { name: string };
  };
  passengers: Passenger[];
  contactInfo?: { email?: string; phone?: string };
  totalAmount: number;
  currency: string;
  errorMessage?: string | null;
  createdAt: string;
}

interface ServiceItem {
  offerItemId: string;
  serviceId: string;
  description: string;
  journeyRefId?: string;
  paxRefIds: string[];
  price: { amount: number; currency: string };
  cancellable: boolean;
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function formatRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Hace un momento';
  if (minutes < 60) return `Hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Ayer';
  if (days < 7) return `Hace ${days} días`;
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pendiente', className: 'bg-amber-50 text-amber-700' },
  confirmed: { label: 'Confirmada', className: 'bg-blue-50 text-blue-700' },
  ticketed: { label: 'Emitida', className: 'bg-green-50 text-green-700' },
  cancelled: { label: 'Cancelada', className: 'bg-red-50 text-red-700' },
  failed: { label: 'Fallida', className: 'bg-red-50 text-red-700' },
};

const PAX_LABEL: Record<string, string> = { ADT: 'Adulto', CHD: 'Niño', INF: 'Infante' };

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
function fmtDuration(min: number): string {
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

export default function ReservasPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{
    orderId: string;
    type: string;
    message: string;
    success: boolean;
  } | null>(null);
  const [payingOrder, setPayingOrder] = useState<Order | null>(null);
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null);
  const [servicesOrder, setServicesOrder] = useState<Order | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/orders');
        const data = (await res.json()) as { orders?: Order[]; error?: string };
        if (!res.ok) {
          setLoadError(data.error ?? 'No se pudieron cargar las reservas.');
          setOrders([]);
        } else {
          setOrders(data.orders ?? []);
        }
      } catch {
        setLoadError('Error de conexión al cargar las reservas.');
        setOrders([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleRetrieve(order: Order) {
    if (!order.pnr) return;
    setActionLoading(order.id);
    setActionResult(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/retrieve`, { method: 'POST' });
      const data = (await res.json()) as {
        found?: boolean;
        status?: string;
        ticketNumbers?: string[];
        error?: string;
      };
      if (data.found) {
        const tickets = data.ticketNumbers?.join(', ');
        setActionResult({
          orderId: order.id,
          type: 'retrieve',
          success: true,
          message: `Estado: ${data.status}${tickets ? ` | Tickets: ${tickets}` : ''}`,
        });
      } else {
        setActionResult({
          orderId: order.id,
          type: 'retrieve',
          success: false,
          message: data.error ?? 'No se encontró la reserva en LATAM',
        });
      }
    } catch {
      setActionResult({
        orderId: order.id,
        type: 'retrieve',
        success: false,
        message: 'Error de conexión',
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCancel(order: Order) {
    if (!order.pnr) return;
    setActionLoading(order.id);
    setActionResult(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/cancel`, { method: 'POST' });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === order.id ? { ...o, status: 'cancelled' } : o)),
        );
        setActionResult({
          orderId: order.id,
          type: 'cancel',
          success: true,
          message: 'Reserva cancelada exitosamente',
        });
      } else {
        setActionResult({
          orderId: order.id,
          type: 'cancel',
          success: false,
          message: data.error ?? 'No se pudo cancelar',
        });
      }
    } catch {
      setActionResult({
        orderId: order.id,
        type: 'cancel',
        success: false,
        message: 'Error de conexión',
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePaySubmit() {
    if (!payingOrder || !paymentData) return;
    setActionLoading(payingOrder.id);
    setActionResult(null);
    try {
      const res = await fetch(`/api/orders/${payingOrder.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment: paymentData }),
      });
      const data = (await res.json()) as { success?: boolean; status?: string; error?: string };
      if (data.success) {
        setOrders((prev) =>
          prev.map((o) =>
            o.id === payingOrder.id ? { ...o, status: data.status ?? 'confirmed' } : o,
          ),
        );
        setActionResult({
          orderId: payingOrder.id,
          type: 'pay',
          success: true,
          message: 'Pago procesado exitosamente',
        });
        setPayingOrder(null);
        setPaymentData(null);
      } else {
        setActionResult({
          orderId: payingOrder.id,
          type: 'pay',
          success: false,
          message: data.error ?? 'No se pudo procesar el pago',
        });
      }
    } catch {
      setActionResult({
        orderId: payingOrder.id,
        type: 'pay',
        success: false,
        message: 'Error de conexión',
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleListServices(order: Order) {
    setServicesOrder(order);
    setServicesLoading(true);
    setServices([]);
    try {
      const res = await fetch(`/api/orders/${order.id}/services`, { method: 'POST' });
      const data = (await res.json()) as { services: ServiceItem[]; warnings: string[] };
      setServices(data.services ?? []);
      if (data.warnings?.length) {
        setActionResult({
          orderId: order.id,
          type: 'services',
          success: false,
          message: data.warnings.join(', '),
        });
        setServicesOrder(null);
      }
    } catch {
      setActionResult({
        orderId: order.id,
        type: 'services',
        success: false,
        message: 'Error de conexión',
      });
      setServicesOrder(null);
    } finally {
      setServicesLoading(false);
    }
  }

  async function handleReshop(order: Order) {
    setActionLoading(order.id);
    setActionResult(null);
    try {
      const retrieveRes = await fetch(`/api/orders/${order.id}/retrieve`, { method: 'POST' });
      const retrieveData = (await retrieveRes.json()) as {
        found?: boolean;
        ticketNumbers?: string[];
      };
      if (!retrieveData.found || !retrieveData.ticketNumbers?.length) {
        setActionResult({
          orderId: order.id,
          type: 'reshop',
          success: false,
          message: 'No se encontraron tickets para repricing',
        });
        return;
      }

      const res = await fetch(`/api/orders/${order.id}/reshop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paidOrderId: order.pnr,
          bnplOrderId: order.pnr,
          ticketDocIds: retrieveData.ticketNumbers,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        amountDue?: { amount: number; currency: string };
        isResidualValue?: boolean;
        error?: string;
      };
      if (data.success && data.amountDue) {
        const sign = data.isResidualValue ? 'Crédito residual' : 'Monto a pagar';
        setActionResult({
          orderId: order.id,
          type: 'reshop',
          success: true,
          message: `${sign}: ${formatMoney(Math.round(Math.abs(data.amountDue.amount) * 100), data.amountDue.currency)}`,
        });
      } else {
        setActionResult({
          orderId: order.id,
          type: 'reshop',
          success: false,
          message: data.error ?? 'No se pudo realizar el repricing',
        });
      }
    } catch {
      setActionResult({
        orderId: order.id,
        type: 'reshop',
        success: false,
        message: 'Error de conexión',
      });
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">Reservas</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {orders.length} {orders.length === 1 ? 'reserva' : 'reservas'} en total
        </p>
      </div>

      {loadError && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
            >
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-lg bg-[var(--color-surface-muted)]" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-[var(--color-surface-muted)]" />
                  <div className="h-3 w-48 rounded bg-[var(--color-surface-muted)]" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <Plane className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">No hay reservas aún</p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Las reservas aparecerán aquí cuando crees un PNR desde una cotización.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const statusInfo = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending!;
            const paxNames = (order.passengers as { givenName: string; surname: string }[])
              ?.map((p) => `${p.givenName} ${p.surname}`)
              .join(', ');

            return (
              <div
                key={order.id}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex items-center gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                    <Plane className="size-4" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[var(--color-fg)]">
                        #{order.orderNumber} · {order.searchCriteria.origin} →{' '}
                        {order.searchCriteria.destination}
                      </p>
                      {order.pnr && (
                        <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-[10px] font-bold text-[var(--color-fg)]">
                          {order.pnr}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
                      <span>{order.searchCriteria.departureDate}</span>
                      {paxNames && <span className="truncate">· {paxNames}</span>}
                    </div>
                  </div>

                  <div className="hidden text-right sm:block">
                    <p className="font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                      {formatMoney(order.totalAmount, order.currency)}
                    </p>
                    <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[var(--color-fg-subtle)]">
                      <Clock className="size-3" />
                      <span>{formatRelativeDate(order.createdAt)}</span>
                    </div>
                  </div>

                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium',
                      statusInfo.className,
                    )}
                  >
                    {statusInfo.label}
                  </span>
                </div>

                {/* Actions */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setDetailOrder(order)}
                    className="gap-1.5 text-xs"
                  >
                    <Eye className="size-3.5" /> Ver detalle
                  </Button>
                  {order.pnr && order.status !== 'cancelled' && order.status !== 'failed' && (
                    <>
                      {(order.status === 'pending' || order.status === 'confirmed') && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={actionLoading === order.id}
                          onClick={() => {
                            setPayingOrder(order);
                            setPaymentData(null);
                          }}
                          className="gap-1.5 text-xs"
                        >
                          <CreditCard className="size-3.5" /> Pagar / Emitir
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={actionLoading === order.id}
                        onClick={() => void handleRetrieve(order)}
                        className="gap-1.5 text-xs"
                      >
                        <Search className="size-3.5" />
                        {actionLoading === order.id ? 'Consultando…' : 'Consultar estado'}
                      </Button>
                      {(order.status === 'confirmed' || order.status === 'ticketed') && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionLoading === order.id}
                          onClick={() => void handleListServices(order)}
                          className="gap-1.5 text-xs"
                        >
                          <Package className="size-3.5" /> Servicios
                        </Button>
                      )}
                      {order.status === 'ticketed' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionLoading === order.id}
                          onClick={() => void handleReshop(order)}
                          className="gap-1.5 text-xs"
                        >
                          <RefreshCw className="size-3.5" /> Repricing
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={actionLoading === order.id}
                        onClick={() => setConfirmCancel(order)}
                        className="gap-1.5 text-xs text-red-600 hover:text-red-700"
                      >
                        <XCircle className="size-3.5" /> Cancelar
                      </Button>
                    </>
                  )}
                </div>

                {/* Action result */}
                {actionResult?.orderId === order.id && (
                  <div
                    className={cn(
                      'mt-2 rounded-lg border px-3 py-2 text-xs',
                      actionResult.success
                        ? 'border-green-200 bg-green-50 text-green-800'
                        : 'border-red-200 bg-red-50 text-red-800',
                    )}
                  >
                    {actionResult.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Payment modal */}
      {payingOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">
                Pagar reserva #{payingOrder.orderNumber}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setPayingOrder(null);
                  setPaymentData(null);
                }}
                className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--color-fg-muted)]">
                  {payingOrder.searchCriteria.origin} → {payingOrder.searchCriteria.destination}
                </span>
                <span className="font-mono font-semibold text-[var(--color-fg)]">
                  {formatMoney(payingOrder.totalAmount, payingOrder.currency)}
                </span>
              </div>
            </div>

            <PaymentForm
              totalAmountMinor={payingOrder.totalAmount}
              currency={payingOrder.currency}
              onPaymentChange={setPaymentData}
            />

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPayingOrder(null);
                  setPaymentData(null);
                }}
              >
                Cancelar
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!paymentData || actionLoading === payingOrder.id}
                onClick={() => void handlePaySubmit()}
                className="gap-1.5"
              >
                <CreditCard className="size-3.5" />
                {actionLoading === payingOrder.id ? 'Procesando…' : 'Confirmar pago'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Services modal */}
      {servicesOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">
                Servicios disponibles — Reserva #{servicesOrder.orderNumber}
              </h2>
              <button
                type="button"
                onClick={() => setServicesOrder(null)}
                className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <X className="size-4" />
              </button>
            </div>

            {servicesLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-primary)]" />
                <span className="ml-3 text-sm text-[var(--color-fg-muted)]">
                  Consultando servicios...
                </span>
              </div>
            ) : services.length === 0 ? (
              <div className="py-12 text-center">
                <Package className="mx-auto mb-2 size-8 text-[var(--color-fg-subtle)]" />
                <p className="text-sm text-[var(--color-fg-muted)]">
                  No hay servicios disponibles para esta reserva.
                </p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left">
                      <th className="pb-2 font-medium text-[var(--color-fg-muted)]">Servicio</th>
                      <th className="pb-2 font-medium text-[var(--color-fg-muted)]">Tramo</th>
                      <th className="pb-2 font-medium text-[var(--color-fg-muted)]">Pasajero(s)</th>
                      <th className="pb-2 text-right font-medium text-[var(--color-fg-muted)]">
                        Precio
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {services.map((svc) => (
                      <tr
                        key={svc.offerItemId}
                        className="border-b border-[var(--color-border)]/50"
                      >
                        <td className="py-2.5 font-medium text-[var(--color-fg)]">
                          {svc.description}
                        </td>
                        <td className="py-2.5 text-[var(--color-fg-muted)]">
                          {svc.journeyRefId ?? '—'}
                        </td>
                        <td className="py-2.5 text-[var(--color-fg-muted)]">
                          {svc.paxRefIds.join(', ')}
                        </td>
                        <td className="py-2.5 text-right font-mono font-semibold text-[var(--color-fg)]">
                          {formatMoney(Math.round(svc.price.amount * 100), svc.price.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setServicesOrder(null)}>
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Detalle de la reserva */}
      {detailOrder && (
        <OrderDetailModal
          order={detailOrder}
          onClose={() => setDetailOrder(null)}
          onCancelRequest={() => setConfirmCancel(detailOrder)}
          onPayRequest={() => {
            setPayingOrder(detailOrder);
            setPaymentData(null);
            setDetailOrder(null);
          }}
        />
      )}

      {/* Confirmación de cancelación (evita cancelaciones por error) */}
      {confirmCancel && (
        <ConfirmDialog
          title={`Cancelar reserva #${confirmCancel.orderNumber}`}
          message={`¿Seguro que querés cancelar esta reserva${
            confirmCancel.pnr ? ` (PNR ${confirmCancel.pnr})` : ''
          }? Esta acción no se puede deshacer.`}
          confirmLabel="Sí, cancelar reserva"
          danger
          loading={actionLoading === confirmCancel.id}
          onClose={() => setConfirmCancel(null)}
          onConfirm={async () => {
            await handleCancel(confirmCancel);
            setConfirmCancel(null);
            setDetailOrder(null);
          }}
        />
      )}
    </div>
  );
}

function OrderDetailModal({
  order,
  onClose,
  onCancelRequest,
  onPayRequest,
}: {
  order: Order;
  onClose: () => void;
  onCancelRequest: () => void;
  onPayRequest: () => void;
}) {
  const status = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending!;
  const itineraries = order.selectedOffer?.itineraries ?? [];
  const canCancel = !!order.pnr && order.status !== 'cancelled' && order.status !== 'failed';
  const canPay = !!order.pnr && (order.status === 'pending' || order.status === 'confirmed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              Reserva #{order.orderNumber}
            </h2>
            {order.pnr && (
              <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-[10px] font-bold text-[var(--color-fg)]">
                {order.pnr}
              </span>
            )}
            <span
              className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', status.className)}
            >
              {status.label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {order.status === 'failed' && order.errorMessage && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <span className="font-semibold">La reserva falló:</span> {order.errorMessage}
            </div>
          )}

          {itineraries.length > 0 ? (
            <section>
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Vuelo
              </h3>
              <div className="space-y-2">
                {itineraries.map((it, idx) => (
                  <div key={idx} className="rounded-lg border border-[var(--color-border)] p-3">
                    <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                      <span>
                        {itineraries.length > 1 ? (idx === 0 ? 'Ida' : 'Vuelta') : 'Vuelo'}
                      </span>
                      <span>
                        {it.stops === 0
                          ? 'Directo'
                          : `${it.stops} ${it.stops === 1 ? 'escala' : 'escalas'}`}
                      </span>
                    </div>
                    {it.segments.map((seg, si) => (
                      <div
                        key={si}
                        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 py-0.5 text-xs"
                      >
                        <span className="font-mono text-[var(--color-fg)]">
                          {seg.origin} {fmtTime(seg.departureAt)} → {seg.destination}{' '}
                          {fmtTime(seg.arrivalAt)}
                        </span>
                        <span className="text-[10px] text-[var(--color-fg-subtle)]">
                          {seg.carrier}
                          {seg.flightNumber} · {fmtDuration(seg.durationMinutes)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <section>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Ruta
              </h3>
              <p className="text-sm text-[var(--color-fg)]">
                {order.searchCriteria.origin} → {order.searchCriteria.destination} ·{' '}
                {order.searchCriteria.departureDate}
              </p>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Pasajeros ({order.passengers.length})
            </h3>
            <div className="space-y-1.5">
              {order.passengers.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"
                >
                  <span className="font-medium text-[var(--color-fg)]">
                    {p.givenName} {p.surname}
                  </span>
                  <span className="text-[var(--color-fg-muted)]">
                    {p.identityDoc?.type
                      ? `${p.identityDoc.type} ${p.identityDoc.number ?? ''}`
                      : ''}
                    {p.identityDoc?.type ? ' · ' : ''}
                    {PAX_LABEL[p.paxType] ?? p.paxType}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {(order.contactInfo?.email || order.contactInfo?.phone) && (
            <section>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Contacto
              </h3>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {order.contactInfo?.email}
                {order.contactInfo?.phone ? ` · ${order.contactInfo.phone}` : ''}
              </p>
            </section>
          )}

          <section className="flex items-center justify-between border-t border-[var(--color-border)] pt-3">
            <span className="text-xs text-[var(--color-fg-muted)]">
              Creada {formatRelativeDate(order.createdAt)}
            </span>
            <span className="font-mono text-sm font-semibold text-[var(--color-fg)]">
              {formatMoney(order.totalAmount, order.currency)}
            </span>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] p-4">
          {canCancel && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onCancelRequest}
              className="gap-1.5 text-xs text-red-600 hover:text-red-700"
            >
              <XCircle className="size-3.5" /> Cancelar reserva
            </Button>
          )}
          {canPay && (
            <Button variant="primary" size="sm" onClick={onPayRequest} className="gap-1.5 text-xs">
              <CreditCard className="size-3.5" /> Pagar / Emitir tiquete
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl">
        <div className="mb-2 flex items-center gap-2.5">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full',
              danger
                ? 'bg-red-50 text-red-600'
                : 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]',
            )}
          >
            <AlertTriangle className="size-4" />
          </span>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-[var(--color-fg-muted)]">{message}</p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={loading} onClick={onClose}>
            No, volver
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={loading}
            onClick={() => void onConfirm()}
            className={cn('gap-1.5', danger && 'bg-red-600 hover:bg-red-700')}
          >
            {loading ? 'Procesando…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
