'use client';

import {
  ArrowLeftRight,
  Building2,
  Car,
  FileText,
  Plane,
  Plus,
  Search,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { Fragment, useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { cn } from '../../../lib/cn';
import { AirportCombobox } from '../../../components/ui/airport-combobox';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import { PaxPicker } from '../../../components/ui/pax-picker';
import { searchFlightsAction, type Offer, type SearchResult } from './actions';
import { createQuotationAction } from './quotation-actions';
import { FlightRow, type FlightGroup } from './_components/flight-row';
import { ResultsHeader } from './_components/results-header';
import { SkeletonFlightRow } from './_components/skeleton-flight-row';
import type { SortKey } from './_components/sort-toggle';

const initialState: SearchResult = { ok: true, offers: [] };

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg" className="w-full gap-2 sm:w-auto">
      {pending ? (
        <>
          <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          Buscando…
        </>
      ) : (
        <>
          <Search className="size-4" />
          Buscar vuelos
        </>
      )}
    </Button>
  );
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
  const d = new Date(iso);
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Abre el calendario nativo al enfocar la fecha (donde el navegador lo permita). */
function openDatePicker(e: React.FocusEvent<HTMLInputElement>) {
  try {
    e.currentTarget.showPicker?.();
  } catch {
    /* showPicker requiere gesto del usuario en algunos navegadores; el campo igual queda enfocado. */
  }
}

/** Enter avanza al siguiente campo (si se indica); en el último, deja que el form se envíe. */
function advanceOnEnter(e: React.KeyboardEvent<HTMLElement>, nextId?: string) {
  if (e.key === 'Enter' && nextId) {
    e.preventDefault();
    document.getElementById(nextId)?.focus();
  }
}

function groupOffersByFlight(offers: Offer[]): FlightGroup[] {
  const groups = new Map<string, Offer[]>();

  for (const offer of offers) {
    if (!offer.itineraries?.length) continue;
    const key = offer.itineraries
      .map((it) =>
        it.segments.map((s) => `${s.carrier}${s.flightNumber}-${s.departureAt}`).join('|'),
      )
      .join('//');
    const existing = groups.get(key);
    if (existing) existing.push(offer);
    else groups.set(key, [offer]);
  }

  return Array.from(groups.entries()).map(([key, groupOffers]) => ({
    key,
    offers: groupOffers.sort((a, b) => a.total.amountMinor - b.total.amountMinor),
  }));
}

function sortGroups(groups: FlightGroup[], sort: SortKey): FlightGroup[] {
  const sorted = [...groups];
  sorted.sort((a, b) => {
    const offerA = a.offers[0]!;
    const offerB = b.offers[0]!;
    const itA = offerA.itineraries?.[0];
    const itB = offerB.itineraries?.[0];
    switch (sort) {
      case 'price':
        return offerA.total.amountMinor - offerB.total.amountMinor;
      case 'duration':
        return (itA?.totalDurationMinutes ?? 0) - (itB?.totalDurationMinutes ?? 0);
      case 'departure': {
        const depA = itA?.segments[0]?.departureAt ?? '';
        const depB = itB?.segments[0]?.departureAt ?? '';
        return depA.localeCompare(depB);
      }
      case 'best': {
        const priceScore =
          (offerA.total.amountMinor - offerB.total.amountMinor) /
          Math.max(offerA.total.amountMinor, 1);
        const durScore =
          ((itA?.totalDurationMinutes ?? 0) - (itB?.totalDurationMinutes ?? 0)) /
          Math.max(itA?.totalDurationMinutes ?? 1, 1);
        const stopScore = (itA?.stops ?? 0) - (itB?.stops ?? 0);
        return priceScore * 0.5 + durScore * 0.3 + stopScore * 0.2;
      }
      default:
        return 0;
    }
  });
  return sorted;
}

export default function CotizacionesPage() {
  const router = useRouter();
  const [result, formAction] = useActionState(searchFlightsAction, initialState);
  const today = useMemo(todayISO, []);
  const [hasSearched, setHasSearched] = useState(false);
  const [sort, setSort] = useState<SortKey>('best');
  const formRef = useRef<HTMLFormElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const [tripType, setTripType] = useState<'roundtrip' | 'oneway'>('roundtrip');
  const [departureDate, setDepartureDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [originCode, setOriginCode] = useState('');
  const [destinationCode, setDestinationCode] = useState('');
  const [comboKey, setComboKey] = useState(0);
  const [swapRotation, setSwapRotation] = useState(0);
  const [clientError, setClientError] = useState('');
  const [quoteSuccess, setQuoteSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (returnDate && departureDate && returnDate < departureDate) {
      setReturnDate(departureDate);
    }
  }, [departureDate, returnDate]);

  useEffect(() => {
    if (quoteSuccess) {
      const timer = setTimeout(() => setQuoteSuccess(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [quoteSuccess]);

  function handleSwap() {
    const tmpOrigin = originCode;
    const tmpDest = destinationCode;
    setOriginCode(tmpDest);
    setDestinationCode(tmpOrigin);
    setSwapRotation((r) => r + 180);
    setComboKey((k) => k + 1);
    setClientError('');
  }

  // UX: al completar un campo, llevamos el foco al siguiente (menos clicks, flujo más ágil).
  function focusField(id: string) {
    // Pequeño delay para que el combobox cierre su dropdown antes de mover el foco.
    setTimeout(() => document.getElementById(id)?.focus(), 10);
  }
  function handleOriginChange(code: string) {
    setOriginCode(code);
    if (/^[A-Z]{3}$/.test(code)) focusField('search-destination');
  }
  function handleDestinationChange(code: string) {
    setDestinationCode(code);
    if (/^[A-Z]{3}$/.test(code)) focusField('departureDate');
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    setClientError('');

    const formData = new FormData(e.currentTarget);
    const origin = ((formData.get('origin') as string) ?? '').toUpperCase().trim();
    const destination = ((formData.get('destination') as string) ?? '').toUpperCase().trim();

    if (!origin || !/^[A-Z]{3}$/.test(origin)) {
      e.preventDefault();
      setClientError('Selecciona un aeropuerto de origen.');
      return;
    }
    if (!destination || !/^[A-Z]{3}$/.test(destination)) {
      e.preventDefault();
      setClientError('Selecciona un aeropuerto de destino.');
      return;
    }
    if (origin === destination) {
      e.preventDefault();
      setClientError('Origen y destino deben ser distintos.');
      return;
    }

    setHasSearched(true);
    // El loader/resultados aparecen debajo del formulario (fuera del viewport): bajamos a esa zona.
    setTimeout(
      () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      60,
    );
  }

  const handleQuote = useCallback(
    async (offer: Offer) => {
      const formData = formRef.current ? new FormData(formRef.current) : null;
      const res = await createQuotationAction(offer, {
        origin: originCode,
        destination: destinationCode,
        departureDate,
        returnDate: returnDate || undefined,
        tripType,
        paxCount: {
          adults: Number(formData?.get('adults') ?? 1),
          children: Number(formData?.get('children') ?? 0),
          infants: Number(formData?.get('infants') ?? 0),
        },
        cabin: (formData?.get('cabin') as string) || 'economy',
        currency: offer.total.currency,
      });
      if (res.ok && res.quotationId) {
        setQuoteSuccess(`Cotización #${res.quoteNumber} guardada`);
        router.push(`/cotizaciones/${res.quotationId}`);
      } else {
        setClientError(res.error || 'Error al guardar cotización');
      }
    },
    [originCode, destinationCode, departureDate, returnDate, tripType],
  );

  const flightGroups = useMemo(
    () => sortGroups(groupOffersByFlight(result.offers), sort),
    [result.offers, sort],
  );

  const displayError = clientError || result.error;

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8 animate-fade-in-up">
      {/* Decorative top blurred background glow */}
      <div className="relative">
        <div className="absolute -top-10 left-1/4 -z-10 size-72 rounded-full bg-[var(--color-primary)]/4 opacity-40 blur-3xl" />
        <div className="absolute -top-20 right-1/4 -z-10 size-96 rounded-full bg-[var(--color-navy)]/6 opacity-30 blur-3xl" />
      </div>

      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-2 rounded-full bg-[var(--color-primary)] animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-primary)]">
              Módulo Comercial
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--color-fg)]">
            Buscar Vuelos
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Cotice y reserve vuelos para sus clientes en segundos a través de conexión directa NDC.
          </p>
        </div>
        <Link
          href="/cotizaciones/guardadas"
          className="flex w-fit items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-xs font-semibold text-[var(--color-fg-muted)] shadow-[var(--shadow-xs)] transition-all duration-200 hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)] hover:shadow-[var(--shadow-sm)] active:scale-[0.98]"
        >
          <FileText className="size-4 text-[var(--color-fg-subtle)]" />
          Ver cotizaciones guardadas
        </Link>
      </header>

      <form ref={formRef} action={formAction} onSubmit={handleSubmit}>
        <Card className="overflow-hidden border border-[var(--color-border)]/60 bg-[var(--color-surface)] shadow-[var(--shadow-md)] transition-all hover:shadow-[var(--shadow-lg)]">
          {/* Top orange brand highlight bar */}
          <div className="h-1 w-full bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-primary)]/70" />

          <CardContent className="p-0">
            <div className="space-y-6 p-6">
              {/* Trip type toggle */}
              <div className="flex w-fit gap-1 rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-surface-muted)]/80 p-1 backdrop-blur-sm">
                <input type="hidden" name="tripType" value={tripType} />
                {(['roundtrip', 'oneway'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      setTripType(type);
                      if (type === 'oneway') setReturnDate('');
                    }}
                    className={
                      tripType === type
                        ? 'rounded-lg bg-[var(--color-surface)] px-4 py-1.5 text-xs font-semibold text-[var(--color-fg)] shadow-[var(--shadow-sm)] border border-[var(--color-border)]/20 transition-all duration-200'
                        : 'rounded-lg px-4 py-1.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] cursor-pointer'
                    }
                  >
                    {type === 'roundtrip' ? 'Ida y vuelta' : 'Solo ida'}
                  </button>
                ))}
              </div>

              {/* Origin / swap / destination */}
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
                <div className="relative rounded-xl border border-[var(--color-border)]/65 bg-[var(--color-surface-muted)]/20 p-1.5 focus-within:border-[var(--color-primary)]/60 focus-within:ring-2 focus-within:ring-[var(--color-primary)]/10 transition-all">
                  <AirportCombobox
                    key={`origin-${comboKey}`}
                    name="origin"
                    inputId="search-origin"
                    label="Aeropuerto de Origen"
                    defaultValue={originCode}
                    onChange={handleOriginChange}
                    autoFocus
                    required
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSwap}
                  aria-label="Intercambiar origen y destino"
                  className="mx-auto flex size-11 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] shadow-[var(--shadow-sm)] transition-all duration-300 hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-primary)]/6 hover:text-[var(--color-primary)] hover:scale-105 active:scale-95 hover:shadow-[var(--shadow-md)] cursor-pointer"
                >
                  <ArrowLeftRight
                    className="size-4.5 transition-transform duration-500 ease-out"
                    style={{ transform: `rotate(${swapRotation}deg)` }}
                  />
                </button>

                <div className="relative rounded-xl border border-[var(--color-border)]/65 bg-[var(--color-surface-muted)]/20 p-1.5 focus-within:border-[var(--color-primary)]/60 focus-within:ring-2 focus-within:ring-[var(--color-primary)]/10 transition-all">
                  <AirportCombobox
                    key={`destination-${comboKey}`}
                    name="destination"
                    inputId="search-destination"
                    label="Aeropuerto de Destino"
                    defaultValue={destinationCode}
                    onChange={handleDestinationChange}
                    required
                  />
                </div>
              </div>

              {/* Dates / pax / cabin */}
              <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="departureDate"
                    className="text-xs font-semibold text-[var(--color-fg-muted)]"
                  >
                    Fecha de Ida
                  </Label>
                  <input
                    id="departureDate"
                    name="departureDate"
                    type="date"
                    required
                    min={today}
                    value={departureDate}
                    onFocus={openDatePicker}
                    onKeyDown={(e) =>
                      advanceOnEnter(e, tripType === 'roundtrip' ? 'returnDate' : 'cabin')
                    }
                    onChange={(e) => {
                      setDepartureDate(e.target.value);
                      // Ida elegida → foco a la vuelta (si es ida y vuelta y aún está vacía).
                      if (e.target.value && tripType === 'roundtrip' && !returnDate)
                        focusField('returnDate');
                    }}
                    className="flex h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/10 cursor-pointer hover:border-[var(--color-border-strong)]"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label
                    htmlFor="returnDate"
                    className="text-xs font-semibold text-[var(--color-fg-muted)]"
                  >
                    Fecha de Vuelta
                    {tripType === 'oneway' ? (
                      <span className="ml-1 font-normal text-[var(--color-fg-subtle)]">
                        (no aplica)
                      </span>
                    ) : null}
                  </Label>
                  <input
                    id="returnDate"
                    name="returnDate"
                    type="date"
                    min={departureDate || today}
                    disabled={tripType === 'oneway'}
                    required={tripType === 'roundtrip'}
                    value={returnDate}
                    onFocus={openDatePicker}
                    onKeyDown={(e) => advanceOnEnter(e, 'cabin')}
                    onChange={(e) => setReturnDate(e.target.value)}
                    className="flex h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/10 cursor-pointer hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-30 disabled:bg-[var(--color-surface-muted)]/50"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-[var(--color-fg-muted)]">
                    Pasajeros
                  </Label>
                  <PaxPicker />
                </div>

                <div className="space-y-1.5">
                  <Label
                    htmlFor="cabin"
                    className="text-xs font-semibold text-[var(--color-fg-muted)]"
                  >
                    Clase
                  </Label>
                  <select
                    id="cabin"
                    name="cabin"
                    defaultValue="economy"
                    className="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/10 cursor-pointer hover:border-[var(--color-border-strong)]"
                  >
                    <option value="economy">Económica</option>
                    <option value="premium_economy">Económica Premium</option>
                    <option value="business">Ejecutiva (Business)</option>
                    <option value="first">Primera Clase</option>
                  </select>
                </div>
              </div>

              {/* Error display */}
              {displayError ? (
                <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-4.5 py-3.5 text-sm text-[var(--color-danger)]">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="font-medium">{displayError}</span>
                </div>
              ) : null}

              <div className="flex justify-end border-t border-[var(--color-border)]/50 pt-4">
                <SubmitButton />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quote success toast */}
        {quoteSuccess && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl border border-[var(--color-success)]/20 bg-[var(--color-surface)] px-4.5 py-3.5 shadow-[var(--shadow-lg)] animate-fade-in-up">
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-success)] opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-[var(--color-success)]" />
            </span>
            <span className="text-sm font-semibold text-[var(--color-fg)]">{quoteSuccess}</span>
          </div>
        )}

        {/* Results */}
        <div ref={resultsRef} className="scroll-mt-6">
          <SearchResults
            hasSearched={hasSearched}
            result={result}
            flightGroups={flightGroups}
            sort={sort}
            onSortChange={setSort}
            onQuote={handleQuote}
          />
        </div>
      </form>
    </div>
  );
}

/**
 * Loader conceptual del viaje: avión → hotel → auto → asistencia (cruz). Los nodos laten en
 * secuencia (delays escalonados) unidos por líneas a trazos, evocando un itinerario armándose.
 */
function TravelLoader() {
  const steps = [
    {
      Icon: Plane,
      label: 'Vuelo',
      color: 'text-[var(--color-primary)]',
      bg: 'bg-sky-50',
      ring: 'ring-[var(--color-primary)]/20/70',
    },
    {
      Icon: Building2,
      label: 'Hotel',
      color: 'text-violet-500',
      bg: 'bg-violet-50',
      ring: 'ring-violet-200/70',
    },
    {
      Icon: Car,
      label: 'Traslado',
      color: 'text-amber-500',
      bg: 'bg-amber-50',
      ring: 'ring-amber-200/70',
    },
    {
      Icon: Plus,
      label: 'Asistencia',
      color: 'text-red-500',
      bg: 'bg-red-50',
      ring: 'ring-red-200/70',
    },
  ];
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="flex items-center">
        {steps.map((s, i) => (
          <Fragment key={s.label}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={cn(
                  'flex size-12 items-center justify-center rounded-2xl ring-1 animate-pulse',
                  s.bg,
                  s.ring,
                )}
                style={{ animationDelay: `${i * 0.35}s`, animationDuration: '1.5s' }}
              >
                <s.Icon className={cn('size-6', s.color)} strokeWidth={1.75} />
              </span>
              <span className="text-[10px] font-semibold text-[var(--color-fg-subtle)]">
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span className="mx-1.5 mb-5 w-6 border-t border-dashed border-[var(--color-border-strong)] sm:w-10" />
            )}
          </Fragment>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-fg-muted)]">
        <span className="size-3.5 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" />
        Armando el viaje… buscando las mejores tarifas en tiempo real
      </div>
    </div>
  );
}

function SearchResults({
  hasSearched,
  result,
  flightGroups,
  sort,
  onSortChange,
  onQuote,
}: {
  hasSearched: boolean;
  result: SearchResult;
  flightGroups: FlightGroup[];
  sort: SortKey;
  onSortChange: (key: SortKey) => void;
  onQuote: (offer: Offer) => Promise<void>;
}) {
  const { pending } = useFormStatus();

  if (pending) {
    return (
      <section className="animate-fade-in-up mt-8">
        <div className="mb-5 rounded-2xl border border-[var(--color-primary)]/15 bg-gradient-to-b from-[var(--color-primary)]/5 to-transparent">
          <TravelLoader />
        </div>
        <div className="space-y-4">
          <SkeletonFlightRow />
          <SkeletonFlightRow />
        </div>
      </section>
    );
  }

  if (flightGroups.length > 0) {
    return (
      <section className="animate-fade-in-up mt-8">
        <ResultsHeader count={flightGroups.length} sort={sort} onSortChange={onSortChange} />
        <div className="space-y-4">
          {flightGroups.map((group) => (
            <FlightRow
              key={group.key}
              group={group}
              formatMoney={formatMoney}
              formatTime={formatTime}
              formatDate={formatDate}
              formatDuration={formatDuration}
              onQuote={onQuote}
            />
          ))}
        </div>
      </section>
    );
  }

  if (hasSearched && result.ok && !result.error) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border-strong)]/60 bg-[var(--color-surface)] px-6 py-16 text-center shadow-[var(--shadow-xs)] mt-8 animate-fade-in-up">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-[var(--color-fg-subtle)]/5 text-[var(--color-fg-subtle)]">
          <Search className="size-6" />
        </div>
        <p className="text-base font-bold text-[var(--color-fg)]">
          No se encontraron vuelos disponibles
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-[var(--color-fg-muted)]">
          Pruebe seleccionando otras fechas, aeropuertos alternativos o cambie el tipo de cabina
          solicitado.
        </p>
      </div>
    );
  }

  if (!hasSearched) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border-strong)]/60 bg-[var(--color-surface)] px-6 py-16 text-center shadow-[var(--shadow-xs)] mt-8 animate-fade-in-up">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
          <Plane className="size-6 animate-pulse" />
        </div>
        <p className="text-base font-bold text-[var(--color-fg)]">Comience su consulta comercial</p>
        <p className="mx-auto mt-1.5 max-w-sm text-xs text-[var(--color-fg-muted)]">
          Seleccione las ciudades de origen, destino y las fechas estimadas de viaje para buscar las
          mejores ofertas disponibles.
        </p>
      </div>
    );
  }

  return null;
}
