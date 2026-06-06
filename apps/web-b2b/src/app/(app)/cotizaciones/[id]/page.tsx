'use client';

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Mail,
  Plane,
  RefreshCw,
  Send,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';
import { PassengerForm } from './passenger-form';
import type { PaymentData } from './payment-form';

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
    pricing?: { finalMinor: number; totalMarkupMinor: number; currency: string };
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

/** Traduce errores técnicos del proveedor (LATAM NDC) a mensajes claros y accionables. */
function humanizeBookingError(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes('passport') && (msg.includes('mandatory') || msg.includes('required'))) {
    return 'La aerolínea exige pasaporte para todos los pasajeros en esta reserva (habitual en rutas internacionales). En "Pasajeros", cambiá el tipo de documento a "Pasaporte", completá el número y la fecha de vencimiento, y volvé a reservar.';
  }
  if (msg.includes('price') && (msg.includes('changed') || msg.includes('mismatch'))) {
    return 'El precio cambió desde la cotización. Usá "Verificar precio" para actualizarlo y reintentá.';
  }
  if (msg.includes('sold out') || msg.includes('no availability') || msg.includes('unavailable')) {
    return 'La tarifa ya no está disponible. Volvé a buscar para ver opciones vigentes.';
  }
  // Fallback: mostramos el mensaje del proveedor pero sin el ruido del código técnico al inicio.
  return raw.replace(/^LATAM\s+\w+\s+error\s+\d+:\s*/i, '').trim() || raw;
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
  const [customerSaved, setCustomerSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [priceStatus, setPriceStatus] = useState<{
    verified: true;
    changed: boolean;
    newTotal?: string;
  } | null>(null);
  const [bookingResult, setBookingResult] = useState<{
    success: boolean;
    pnr?: string;
    error?: string;
  } | null>(null);

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
    setSaveError(null);
    setCustomerSaved(false);
    try {
      const res = await fetch(`/api/quotations/${quotation.id}/customer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: customerName || null,
          customerEmail: customerEmail || null,
          customerPhone: customerPhone || null,
          notes: notes || null,
        }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string; message?: string };
        setSaveError(d.error ?? d.message ?? 'No se pudo guardar el cliente.');
        return;
      }
      setQuotation({
        ...quotation,
        customerName: customerName || null,
        customerEmail: customerEmail || null,
        customerPhone: customerPhone || null,
        notes: notes || null,
      });
      setCustomerSaved(true);
      setTimeout(() => setCustomerSaved(false), 2500);
    } catch {
      setSaveError('Error de conexión.');
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateOrder(
    passengers: {
      paxId: string;
      paxType: 'ADT' | 'CHD' | 'INF';
      title: 'Mr' | 'Mrs' | 'Miss' | 'Dr';
      givenName: string;
      surname: string;
      birthdate: string;
      gender: 'M' | 'F';
      citizenshipCountryCode: string;
      identityDoc: {
        type: 'P' | 'DNI' | 'CC' | 'CE';
        number: string;
        issuingCountryCode: string;
        issueDate?: string;
        expiryDate: string;
      };
    }[],
    contactInfo: {
      email: string;
      phone: string;
      countryDialingCode: string;
      areaCode: string;
    },
    payment?: PaymentData,
  ) {
    if (!quotation) return;
    const body: Record<string, unknown> = {
      offer: quotation.selectedOffer,
      searchCriteria: quotation.searchCriteria,
      passengers,
      contactInfo,
      quotationId: quotation.id,
    };
    if (payment) {
      body.payment = payment;
    }
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      providerResult?: { success: boolean; pnr?: string; error?: string };
      error?: string;
    };
    if (data.providerResult?.success) {
      setBookingResult({ success: true, pnr: data.providerResult.pnr });
    } else {
      setBookingResult({
        success: false,
        error: humanizeBookingError(
          data.providerResult?.error ?? data.error ?? 'Error desconocido',
        ),
      });
    }
  }

  async function handleVerifyPrice() {
    if (!quotation) return;
    setVerifying(true);
    setPriceStatus(null);
    try {
      const res = await fetch('/api/search/offer-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer: quotation.selectedOffer,
          searchCriteria: quotation.searchCriteria,
        }),
      });
      const data = (await res.json()) as {
        offer?: { total: { amountMinor: number; currency: string } };
        priceChanged?: boolean;
      };
      if (data.priceChanged && data.offer) {
        setPriceStatus({
          verified: true,
          changed: true,
          newTotal: formatMoney(data.offer.total.amountMinor, data.offer.total.currency),
        });
      } else {
        setPriceStatus({ verified: true, changed: false });
      }
    } catch {
      setPriceStatus(null);
    } finally {
      setVerifying(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
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
      <div className="mx-auto max-w-6xl px-5 py-8">
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
    <div className="mx-auto max-w-6xl px-5 py-8">
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
                  const stopAirports = it.segments.slice(0, -1).map((s) => s.destination);
                  return (
                    <div key={idx} className="rounded-lg border border-[var(--color-border)] p-4">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
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
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            it.stops === 0
                              ? 'bg-green-50 text-green-700'
                              : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {it.stops === 0
                            ? 'Directo'
                            : `${it.stops} escala${it.stops > 1 ? 's' : ''}${
                                stopAirports.length ? ` · ${stopAirports.join(', ')}` : ''
                              }`}
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

                      {/* Detalle de tramos y escalas */}
                      {it.stops > 0 && (
                        <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                          {it.segments.map((seg, sIdx) => {
                            const next = it.segments[sIdx + 1];
                            const layoverMin = next
                              ? Math.max(
                                  0,
                                  Math.round(
                                    (new Date(next.departureAt).getTime() -
                                      new Date(seg.arrivalAt).getTime()) /
                                      60000,
                                  ),
                                )
                              : null;
                            return (
                              <div key={sIdx}>
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-medium text-[var(--color-fg)]">
                                      {seg.origin}
                                    </span>
                                    <span className="text-[var(--color-fg-subtle)]">
                                      {formatTime(seg.departureAt)}
                                    </span>
                                    <ArrowRight className="size-3 text-[var(--color-fg-subtle)]" />
                                    <span className="font-mono font-medium text-[var(--color-fg)]">
                                      {seg.destination}
                                    </span>
                                    <span className="text-[var(--color-fg-subtle)]">
                                      {formatTime(seg.arrivalAt)}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-[var(--color-fg-subtle)]">
                                    {seg.carrier} {seg.flightNumber} ·{' '}
                                    {formatDuration(seg.durationMinutes)}
                                  </span>
                                </div>
                                {layoverMin != null && (
                                  <div className="my-1 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800">
                                    <Clock className="size-3" />
                                    Escala en {seg.destination} · {formatDuration(layoverMin)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
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

          {/* Cliente y contacto (única sección: sirve para enviar la cotización y como contacto de la reserva) */}
          <Card>
            <CardContent className="p-5">
              <div className="mb-1 flex items-center gap-2">
                <User className="size-4 text-[var(--color-primary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">Cliente y contacto</h2>
              </div>
              <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                Se usa para enviar la cotización y como contacto de la reserva. Email y teléfono son
                obligatorios para reservar.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="customerName">
                    Nombre<span className="text-red-500"> *</span>
                  </Label>
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
                  <Label htmlFor="customerEmail">
                    Email<span className="text-red-500"> *</span>
                  </Label>
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
                  <Label htmlFor="customerPhone">
                    Teléfono<span className="text-red-500"> *</span>
                  </Label>
                  <input
                    id="customerPhone"
                    type="tel"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="3001234567"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="notes">
                    Notas
                    <span className="font-normal text-[var(--color-fg-subtle)]"> (opcional)</span>
                  </Label>
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
              <div className="mt-4 flex items-center justify-end gap-3">
                {customerSaved && (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="size-3.5" /> Guardado
                  </span>
                )}
                {saveError && <span className="text-xs font-medium text-red-600">{saveError}</span>}
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
                {(selectedOffer.pricing?.totalMarkupMinor ?? 0) > 0 && (
                  <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                    <span>Markup</span>
                    <span className="text-emerald-600">
                      {formatMoney(
                        selectedOffer.pricing!.totalMarkupMinor,
                        selectedOffer.total.currency,
                      )}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2 text-sm font-semibold text-[var(--color-fg)]">
                  <span>Total</span>
                  <span className="font-mono tabular-nums">
                    {formatMoney(
                      selectedOffer.pricing?.finalMinor ?? selectedOffer.total.amountMinor,
                      selectedOffer.total.currency,
                    )}
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
                disabled={verifying}
                onClick={() => void handleVerifyPrice()}
              >
                <RefreshCw className={`size-4 ${verifying ? 'animate-spin' : ''}`} />{' '}
                {verifying ? 'Verificando…' : 'Verificar precio'}
              </Button>
              {priceStatus && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    priceStatus.changed
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-green-200 bg-green-50 text-green-800'
                  }`}
                >
                  {priceStatus.changed
                    ? `Precio actualizado: ${priceStatus.newTotal}`
                    : 'Precio confirmado — sin cambios'}
                </div>
              )}
              <div className="my-1 border-t border-[var(--color-border)]" />
              <Button
                variant="secondary"
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
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                onClick={() => window.open(`/api/quotations/${quotation.id}/pdf`, '_blank')}
              >
                <Download className="size-4" /> Descargar PDF
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Reserva — ancho completo para dar más espacio a los datos de pasajeros */}
      {bookingResult && (
        <div
          className={`mt-5 rounded-xl border p-4 ${
            bookingResult.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
          }`}
        >
          {bookingResult.success ? (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-green-800">Reserva creada exitosamente</p>
              {bookingResult.pnr && (
                <p className="font-mono text-lg font-bold text-green-900">
                  PNR: {bookingResult.pnr}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-red-800">{bookingResult.error}</p>
          )}
        </div>
      )}

      {!bookingResult?.success && (
        <div className="mt-5">
          <PassengerForm
            paxCount={searchCriteria.paxCount}
            totalAmountMinor={selectedOffer.pricing?.finalMinor ?? selectedOffer.total.amountMinor}
            currency={selectedOffer.total.currency}
            customerName={customerName || undefined}
            contactEmail={customerEmail || undefined}
            contactPhone={customerPhone || undefined}
            onSubmit={handleCreateOrder}
          />
        </div>
      )}
    </div>
  );
}
