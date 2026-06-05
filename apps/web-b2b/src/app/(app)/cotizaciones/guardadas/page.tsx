'use client';

import { ArrowRight, Clock, FileText, Plane, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/cn';

interface QuotationSummary {
  id: string;
  status: string;
  quoteNumber: number;
  searchCriteria: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    tripType: string;
    cabin: string;
    currency: string;
  };
  selectedOffer: {
    total: { amountMinor: number; currency: string };
    pricing?: { finalMinor: number };
    fareFamily?: { name: string };
    itineraries?: { segments: { carrier: string; flightNumber: string }[] }[];
  };
  customerName: string | null;
  customerEmail: string | null;
  expiresAt: string;
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
  draft: {
    label: 'Borrador',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  },
  sent: { label: 'Enviada', className: 'bg-blue-50 text-blue-700' },
  accepted: { label: 'Aceptada', className: 'bg-green-50 text-green-700' },
  expired: { label: 'Expirada', className: 'bg-amber-50 text-amber-700' },
  cancelled: { label: 'Cancelada', className: 'bg-red-50 text-red-700' },
};

export default function QuotationsListPage() {
  const [quotations, setQuotations] = useState<QuotationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetch('/api/quotations')
      .then((res) => res.json() as Promise<{ quotations: QuotationSummary[] }>)
      .then((data) => setQuotations(data.quotations ?? []))
      .catch(() => setQuotations([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? quotations : quotations.filter((q) => q.status === filter);

  const counts = quotations.reduce(
    (acc, q) => {
      acc[q.status] = (acc[q.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
            Cotizaciones guardadas
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {quotations.length} {quotations.length === 1 ? 'cotización' : 'cotizaciones'} en total
          </p>
        </div>
        <Link href="/cotizaciones">
          <Button variant="primary" size="sm" className="gap-2">
            <Plus className="size-4" /> Nueva búsqueda
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
        {[
          { key: 'all', label: 'Todas' },
          { key: 'draft', label: 'Borrador' },
          { key: 'sent', label: 'Enviadas' },
          { key: 'accepted', label: 'Aceptadas' },
          { key: 'expired', label: 'Expiradas' },
        ].map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-all',
              filter === key
                ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            {label}
            {key !== 'all' && counts[key] ? (
              <span className="ml-1 text-[10px] opacity-60">({counts[key]})</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* List */}
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
                <div className="h-6 w-20 rounded-full bg-[var(--color-surface-muted)]" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <FileText className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            {filter === 'all' ? 'No hay cotizaciones aún' : 'No hay cotizaciones con este estado'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Busca vuelos y cotiza para empezar.
          </p>
          <Link href="/cotizaciones" className="mt-4 inline-block">
            <Button variant="primary" size="sm" className="gap-2">
              <Search className="size-4" /> Buscar vuelos
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((q) => {
            const statusInfo = STATUS_CONFIG[q.status] ?? STATUS_CONFIG.draft!;
            const isExpired = new Date(q.expiresAt) < new Date() && q.status === 'draft';
            const carrier = q.selectedOffer.itineraries?.[0]?.segments[0]?.carrier;

            return (
              <Link
                key={q.id}
                href={`/cotizaciones/${q.id}`}
                className="group flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-all hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)]"
              >
                {/* Icon */}
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                  {carrier ? (
                    <span className="font-mono text-xs font-bold">{carrier}</span>
                  ) : (
                    <Plane className="size-4" />
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[var(--color-fg)]">
                      #{q.quoteNumber} · {q.searchCriteria.origin} → {q.searchCriteria.destination}
                    </p>
                    {q.searchCriteria.tripType === 'roundtrip' && (
                      <span className="rounded-full bg-[var(--color-primary)]/8 px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-primary)]">
                        I/V
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
                    <span>{q.searchCriteria.departureDate}</span>
                    {q.customerName && <span className="truncate">· {q.customerName}</span>}
                    {q.selectedOffer.fareFamily && <span>· {q.selectedOffer.fareFamily.name}</span>}
                  </div>
                </div>

                {/* Price */}
                <div className="hidden text-right sm:block">
                  <p className="font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                    {formatMoney(
                      q.selectedOffer.pricing?.finalMinor ?? q.selectedOffer.total.amountMinor,
                      q.selectedOffer.total.currency,
                    )}
                  </p>
                  <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[var(--color-fg-subtle)]">
                    <Clock className="size-3" />
                    <span>{formatRelativeDate(q.createdAt)}</span>
                  </div>
                </div>

                {/* Status */}
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium',
                    isExpired ? 'bg-amber-50 text-amber-700' : statusInfo.className,
                  )}
                >
                  {isExpired ? 'Expirada' : statusInfo.label}
                </span>

                {/* Arrow */}
                <ArrowRight className="size-4 shrink-0 text-[var(--color-fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
