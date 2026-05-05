'use client';

import { Clock, Plane, Search, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/cn';

interface Order {
  id: string;
  pnr: string | null;
  status: string;
  orderNumber: number;
  searchCriteria: {
    origin: string;
    destination: string;
    departureDate: string;
    tripType: string;
  };
  passengers: { givenName: string; surname: string; paxType: string }[];
  totalAmount: number;
  currency: string;
  createdAt: string;
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

  useEffect(() => {
    fetch('/api/orders')
      .then((res) => res.json() as Promise<{ orders: Order[] }>)
      .then((data) => setOrders(data.orders ?? []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
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

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">Reservas</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {orders.length} {orders.length === 1 ? 'reserva' : 'reservas'} en total
        </p>
      </div>

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
                {order.pnr && order.status !== 'cancelled' && order.status !== 'failed' && (
                  <div className="mt-3 flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
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
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={actionLoading === order.id}
                      onClick={() => void handleCancel(order)}
                      className="gap-1.5 text-xs text-red-600 hover:text-red-700"
                    >
                      <XCircle className="size-3.5" /> Cancelar
                    </Button>
                  </div>
                )}

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
    </div>
  );
}
