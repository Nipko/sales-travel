'use client';

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Mail,
  Plane,
  Send,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';

interface Quotation {
  id: string;
  status: string;
  quoteNumber: number;
  searchCriteria: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    tripType: string;
    paxCount: { adults: number; children: number; infants: number };
    cabin: string;
    currency: string;
  };
  selectedOffer: {
    id: string;
    total: { amountMinor: number; currency: string };
    baseFare: { amountMinor: number; currency: string };
    taxes: { amountMinor: number; currency: string };
    itineraries?: {
      segments: {
        carrier: string;
        flightNumber: string;
        origin: string;
        destination: string;
        departureAt: string;
        arrivalAt: string;
        durationMinutes: number;
      }[];
      totalDurationMinutes: number;
      stops: number;
    }[];
    fareFamily?: { name: string; cabin: string };
    baggage?: {
      personalItem: number;
      carryOn: { qty: number; weightKg?: number };
      checked: { qty: number; weightKg?: number };
    };
    policies?: { changeable: boolean; refundable: boolean };
  };
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  notes: string | null;
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: {
    label: 'Borrador',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  },
  sent: {
    label: 'Enviada',
    className: 'bg-blue-50 text-blue-700',
  },
  accepted: {
    label: 'Aceptada',
    className: 'bg-green-50 text-green-700',
  },
  expired: {
    label: 'Expirada',
    className: 'bg-amber-50 text-amber-700',
  },
  cancelled: {
    label: 'Cancelada',
    className: 'bg-red-50 text-red-700',
  },
};

export default function QuotationDetailPage() {
  const params = useParams<{ id: string }>();
  const [quotation, setQuotation] = useState<Quotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/quotations/${params.id}`)
      .then((res) => res.json() as Promise<{ quotation: Quotation }>)
      .then((data) => {
        setQuotation(data.quotation);
        setCustomerName(data.quotation.customerName ?? '');
        setCustomerEmail(data.quotation.customerEmail ?? '');
        setCustomerPhone(data.quotation.customerPhone ?? '');
        setNotes(data.quotation.notes ?? '');
      })
      .catch(() => setError('No se pudo cargar la cotización.'))
      .finally(() => setLoading(false));
  }, [params.id]);

  function handleCopyLink() {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleSaveCustomer() {
    if (!quotation) return;
    setSaving(true);
    try {
      await fetch(`/api/quotations/${quotation.id}/customer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: customerName || null,
          customerEmail: customerEmail || null,
          customerPhone: customerPhone || null,
          notes: notes || null,
        }),
      });
      setQuotation({
        ...quotation,
        customerName: customerName || null,
        customerEmail: customerEmail || null,
        customerPhone: customerPhone || null,
        notes: notes || null,
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-5 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-64 rounded-xl bg-[var(--color-surface-muted)]" />
          <div className="h-48 rounded-xl bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    );
  }

  if (error || !quotation) {
    return (
      <div className="mx-auto max-w-4xl px-5 py-8">
        <p className="text-sm text-[var(--color-danger)]">{error || 'Cotización no encontrada.'}</p>
        <Link
          href="/cotizaciones"
          className="mt-4 inline-flex items-center gap-1 text-sm text-[var(--color-primary)] hover:underline"
        >
          <ArrowLeft className="size-4" /> Volver a búsqueda
        </Link>
      </div>
    );
  }

  const { searchCriteria, selectedOffer } = quotation;
  const statusInfo = STATUS_LABELS[quotation.status] ?? STATUS_LABELS.draft!;
  const isExpired = new Date(quotation.expiresAt) < new Date();
  const totalPax =
    searchCriteria.paxCount.adults +
    searchCriteria.paxCount.children +
    searchCriteria.paxCount.infants;

  return (
    <div className="mx-auto max-w-4xl px-5 py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/cotizaciones"
            className="flex size-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">
              Cotización #{quotation.quoteNumber}
            </h1>
            <p className="text-xs text-[var(--color-fg-muted)]">
              Creada {formatDate(quotation.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusInfo.className}`}>
            {statusInfo.label}
          </span>
          {isExpired && quotation.status === 'draft' && (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
              Precio expirado
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Main column */}
        <div className="space-y-5">
          {/* Flight details */}
          <Card>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Plane className="size-4 text-[var(--color-primary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">Vuelo</h2>
                {selectedOffer.fareFamily && (
                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
                    {selectedOffer.fareFamily.name}
                  </span>
                )}
              </div>

              <div className="space-y-4">
                {selectedOffer.itineraries?.map((it, idx) => {
                  const first = it.segments[0]!;
                  const last = it.segments[it.segments.length - 1]!;
                  return (
                    <div key={idx} className="rounded-lg border border-[var(--color-border)] p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                          {selectedOffer.itineraries!.length > 1
                            ? idx === 0
                              ? 'Ida'
                              : 'Vuelta'
                            : 'Vuelo'}
                        </span>
                        <span className="text-[10px] text-[var(--color-fg-subtle)]">
                          {first.carrier} {first.flightNumber}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <div>
                          <p className="font-mono text-base font-semibold tabular-nums text-[var(--color-fg)]">
                            {formatTime(first.departureAt)}
                          </p>
                          <p className="text-xs text-[var(--color-fg-muted)]">{first.origin}</p>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {formatDate(first.departureAt)}
                          </p>
                        </div>
                        <div className="flex flex-1 flex-col items-center gap-0.5">
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {formatDuration(it.totalDurationMinutes)}
                          </p>
                          <div className="flex w-full items-center">
                            <span className="h-px flex-1 bg-[var(--color-border-strong)]" />
                            <ArrowRight className="mx-1 size-3 text-[var(--color-fg-subtle)]" />
                            <span className="h-px flex-1 bg-[var(--color-border-strong)]" />
                          </div>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {it.stops === 0
                              ? 'Directo'
                              : `${it.stops} escala${it.stops > 1 ? 's' : ''}`}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-base font-semibold tabular-nums text-[var(--color-fg)]">
                            {formatTime(last.arrivalAt)}
                          </p>
                          <p className="text-xs text-[var(--color-fg-muted)]">{last.destination}</p>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {formatDate(last.arrivalAt)}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Baggage & policies */}
              {(selectedOffer.baggage || selectedOffer.policies) && (
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-4 sm:grid-cols-4">
                  {selectedOffer.baggage && (
                    <>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Carry-on
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {selectedOffer.baggage.carryOn.qty > 0
                            ? `${selectedOffer.baggage.carryOn.qty}x${selectedOffer.baggage.carryOn.weightKg ?? ''}kg`
                            : '—'}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Maleta
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {selectedOffer.baggage.checked.qty > 0
                            ? `${selectedOffer.baggage.checked.qty}x${selectedOffer.baggage.checked.weightKg ?? ''}kg`
                            : '—'}
                        </p>
                      </div>
                    </>
                  )}
                  {selectedOffer.policies && (
                    <>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Cambios
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {selectedOffer.policies.changeable ? 'Sí' : 'No'}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Reembolso
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {selectedOffer.policies.refundable ? 'Sí' : 'No'}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Customer info form */}
          <Card>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <User className="size-4 text-[var(--color-primary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">Datos del cliente</h2>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="customerName">Nombre</Label>
                  <input
                    id="customerName"
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Juan Pérez"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="customerEmail">Email</Label>
                  <input
                    id="customerEmail"
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    placeholder="juan@example.com"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="customerPhone">Teléfono</Label>
                  <input
                    id="customerPhone"
                    type="tel"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="+57 300 123 4567"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="notes">Notas</Label>
                  <input
                    id="notes"
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Preferencias, observaciones..."
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving}
                  onClick={() => void handleSaveCustomer()}
                >
                  {saving ? 'Guardando…' : 'Guardar cliente'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right sidebar */}
        <div className="space-y-5">
          {/* Price summary */}
          <Card>
            <CardContent className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Resumen</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Ruta</span>
                  <span className="font-medium text-[var(--color-fg)]">
                    {searchCriteria.origin} → {searchCriteria.destination}
                    {searchCriteria.tripType === 'roundtrip' ? ' (ida y vuelta)' : ''}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Pasajeros</span>
                  <span className="font-medium text-[var(--color-fg)]">{totalPax}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Cabina</span>
                  <span className="font-medium capitalize text-[var(--color-fg)]">
                    {searchCriteria.cabin.replace('_', ' ')}
                  </span>
                </div>
              </div>

              <div className="my-3 border-t border-[var(--color-border)]" />

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Base</span>
                  <span>
                    {formatMoney(
                      selectedOffer.baseFare.amountMinor,
                      selectedOffer.baseFare.currency,
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Impuestos</span>
                  <span>
                    {formatMoney(selectedOffer.taxes.amountMinor, selectedOffer.taxes.currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2 text-sm font-semibold text-[var(--color-fg)]">
                  <span>Total</span>
                  <span className="font-mono tabular-nums">
                    {formatMoney(selectedOffer.total.amountMinor, selectedOffer.total.currency)}
                  </span>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-1.5 text-[10px] text-[var(--color-fg-subtle)]">
                <Clock className="size-3" />
                <span>
                  Expira{' '}
                  {new Date(quotation.expiresAt).toLocaleString('es-CO', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardContent className="space-y-2 p-5">
              <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Acciones</h3>
              <Button
                variant="primary"
                size="sm"
                className="w-full gap-2"
                disabled={!customerEmail}
                onClick={() => {
                  if (customerEmail) {
                    window.open(
                      `mailto:${customerEmail}?subject=${encodeURIComponent(`Cotización #${quotation.quoteNumber} - ${searchCriteria.origin}→${searchCriteria.destination}`)}&body=${encodeURIComponent(`Hola ${customerName || ''},\n\nTe envío la cotización de vuelo:\n\nRuta: ${searchCriteria.origin} → ${searchCriteria.destination}\nFecha: ${searchCriteria.departureDate}\nTotal: ${formatMoney(selectedOffer.total.amountMinor, selectedOffer.total.currency)}\nTarifa: ${selectedOffer.fareFamily?.name ?? 'Standard'}\n\nQuedo atento.\nSaludos.`)}`,
                    );
                  }
                }}
              >
                <Mail className="size-4" /> Enviar por email
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                disabled={!customerPhone}
                onClick={() => {
                  if (customerPhone) {
                    const phone = customerPhone.replace(/\D/g, '');
                    const text = `Hola ${customerName || ''}! Te envío cotización #${quotation.quoteNumber}:\n\n✈️ ${searchCriteria.origin} → ${searchCriteria.destination}\n📅 ${searchCriteria.departureDate}\n💰 ${formatMoney(selectedOffer.total.amountMinor, selectedOffer.total.currency)}\n🎫 ${selectedOffer.fareFamily?.name ?? 'Standard'}\n\n¿Te interesa?`;
                    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`);
                  }
                }}
              >
                <Send className="size-4" /> Enviar por WhatsApp
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                onClick={handleCopyLink}
              >
                {copied ? (
                  <>
                    <CheckCircle2 className="size-4" /> Copiado
                  </>
                ) : (
                  <>
                    <Copy className="size-4" /> Copiar enlace
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
