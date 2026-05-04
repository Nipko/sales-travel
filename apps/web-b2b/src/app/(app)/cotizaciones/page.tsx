'use client';

import { ArrowLeftRight, CheckCircle2, FileText, Plane, Search, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
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

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    setClientError('');

    const formData = new FormData(e.currentTarget);
    const origin = ((formData.get('origin') as string) ?? '').toUpperCase().trim();
    const destination = ((formData.get('destination') as string) ?? '').toUpperCase().trim();

    if (!origin || !/^[A-Z]{3}$/.test(origin)) {
      e.preventDefault();
      setClientError('Seleccioná un aeropuerto de origen.');
      return;
    }
    if (!destination || !/^[A-Z]{3}$/.test(destination)) {
      e.preventDefault();
      setClientError('Seleccioná un aeropuerto de destino.');
      return;
    }
    if (origin === destination) {
      e.preventDefault();
      setClientError('Origen y destino deben ser distintos.');
      return;
    }

    setHasSearched(true);
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
        currency: (formData?.get('currency') as string) || 'USD',
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
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
            Cotizaciones
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Buscá vuelos y armá ofertas para tus clientes.
          </p>
        </div>
        <Link
          href="/cotizaciones/guardadas"
          className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
        >
          <FileText className="size-3.5" />
          Ver guardadas
        </Link>
      </header>

      <form ref={formRef} action={formAction} onSubmit={handleSubmit}>
        <Card className="mb-6">
          <CardContent className="p-0">
            <div className="space-y-5 p-5">
              {/* Trip type toggle */}
              <div className="flex w-fit gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
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
                        ? 'rounded-md bg-[var(--color-surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--color-fg)] shadow-sm transition-all duration-150'
                        : 'rounded-md px-3.5 py-1.5 text-xs text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]'
                    }
                  >
                    {type === 'roundtrip' ? 'Ida y vuelta' : 'Solo ida'}
                  </button>
                ))}
              </div>

              {/* Origin / swap / destination */}
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
                <AirportCombobox
                  key={`origin-${comboKey}`}
                  name="origin"
                  label="Origen"
                  defaultValue={originCode}
                  onChange={setOriginCode}
                  required
                />

                <button
                  type="button"
                  onClick={handleSwap}
                  aria-label="Intercambiar origen y destino"
                  className="mx-auto flex size-10 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] shadow-sm transition-all duration-200 hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-primary)] active:scale-90"
                >
                  <ArrowLeftRight
                    className="size-4 transition-transform duration-300 ease-out"
                    style={{ transform: `rotate(${swapRotation}deg)` }}
                  />
                </button>

                <AirportCombobox
                  key={`destination-${comboKey}`}
                  name="destination"
                  label="Destino"
                  defaultValue={destinationCode}
                  onChange={setDestinationCode}
                  required
                />
              </div>

              {/* Dates / pax / cabin / currency */}
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-1.5">
                  <Label htmlFor="departureDate">Fecha ida</Label>
                  <input
                    id="departureDate"
                    name="departureDate"
                    type="date"
                    required
                    min={today}
                    value={departureDate}
                    onChange={(e) => setDepartureDate(e.target.value)}
                    className="flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="returnDate">
                    Fecha vuelta
                    {tripType === 'oneway' ? (
                      <span className="ml-1 text-[var(--color-fg-subtle)]">(no aplica)</span>
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
                    onChange={(e) => setReturnDate(e.target.value)}
                    className="flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>

                <PaxPicker />

                <div className="space-y-1.5">
                  <Label htmlFor="cabin">Cabina</Label>
                  <select
                    id="cabin"
                    name="cabin"
                    defaultValue="economy"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  >
                    <option value="economy">Economy</option>
                    <option value="premium_economy">Premium Economy</option>
                    <option value="business">Business</option>
                    <option value="first">First</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="currency">Moneda</Label>
                  <select
                    id="currency"
                    name="currency"
                    defaultValue="USD"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-all focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
                  >
                    <option value="USD">USD</option>
                    <option value="COP">COP</option>
                    <option value="BRL">BRL</option>
                    <option value="CLP">CLP</option>
                    <option value="PEN">PEN</option>
                    <option value="MXN">MXN</option>
                  </select>
                </div>
              </div>

              {/* Error display */}
              {displayError ? (
                <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/6 px-4 py-3 text-sm text-[var(--color-danger)]">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <span>{displayError}</span>
                </div>
              ) : null}

              <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
                <SubmitButton />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quote success toast */}
        {quoteSuccess && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-[var(--color-success)]/25 bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-lg)]">
            <CheckCircle2 className="size-5 text-[var(--color-success)]" />
            <span className="text-sm font-medium text-[var(--color-fg)]">{quoteSuccess}</span>
          </div>
        )}

        {/* Results */}
        <SearchResults
          hasSearched={hasSearched}
          result={result}
          flightGroups={flightGroups}
          sort={sort}
          onSortChange={setSort}
          onQuote={handleQuote}
        />
      </form>
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
      <section>
        <div className="mb-4 flex items-center gap-3">
          <Plane className="size-5 animate-bounce text-[var(--color-primary)]" />
          <p className="text-sm font-medium text-[var(--color-fg-muted)]">
            Buscando vuelos disponibles…
          </p>
        </div>
        <div className="space-y-3">
          <SkeletonFlightRow />
          <SkeletonFlightRow />
          <SkeletonFlightRow />
        </div>
      </section>
    );
  }

  if (flightGroups.length > 0) {
    return (
      <section>
        <ResultsHeader count={flightGroups.length} sort={sort} onSortChange={onSortChange} />
        <div className="space-y-3">
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
      <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
        <Search className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
        <p className="text-sm font-medium text-[var(--color-fg)]">No se encontraron vuelos</p>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Probá con otras fechas, rutas flexibles o diferente cabina.
        </p>
      </div>
    );
  }

  if (!hasSearched) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
        <Plane className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
        <p className="text-sm font-medium text-[var(--color-fg)]">Buscá vuelos para empezar</p>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Seleccioná origen, destino y fechas para ver ofertas disponibles.
        </p>
      </div>
    );
  }

  return null;
}
