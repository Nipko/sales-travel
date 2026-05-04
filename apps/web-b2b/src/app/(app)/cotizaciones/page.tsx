'use client';

import {
  ArrowLeftRight,
  ArrowRight,
  Plane,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { AirportCombobox } from '../../../components/ui/airport-combobox';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import { PaxPicker } from '../../../components/ui/pax-picker';
import { searchFlightsAction, type SearchResult } from './actions';

const initialState: SearchResult = { ok: true, offers: [] };

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      size="lg"
      className="w-full gap-2 sm:w-auto"
    >
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

export default function CotizacionesPage() {
  const [result, formAction] = useActionState(searchFlightsAction, initialState);
  const today = useMemo(todayISO, []);
  const [hasSearched, setHasSearched] = useState(false);

  const [tripType, setTripType] = useState<'roundtrip' | 'oneway'>('roundtrip');
  const [departureDate, setDepartureDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [originCode, setOriginCode] = useState('');
  const [destinationCode, setDestinationCode] = useState('');
  const [comboKey, setComboKey] = useState(0);
  const [swapRotation, setSwapRotation] = useState(0);
  const [clientError, setClientError] = useState('');

  useEffect(() => {
    if (returnDate && departureDate && returnDate < departureDate) {
      setReturnDate(departureDate);
    }
  }, [departureDate, returnDate]);

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

  const displayError = clientError || result.error;

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
          Cotizaciones
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Buscá vuelos y armá ofertas para tus clientes.
        </p>
      </header>

      <Card className="mb-6 overflow-hidden">
        <CardContent className="p-0">
          <form action={formAction} onSubmit={handleSubmit} className="space-y-5 p-5">
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
          </form>
        </CardContent>
      </Card>

      {/* Results */}
      {result.offers.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            {result.offers.length} {result.offers.length === 1 ? 'oferta' : 'ofertas'}
          </h2>
          <div className="space-y-3">
            {result.offers.map((offer) => (
              <Card key={offer.id} className="overflow-hidden transition-shadow hover:shadow-md">
                <CardContent className="p-0">
                  <div className="flex flex-col lg:flex-row">
                    <div className="flex-1 divide-y divide-[var(--color-border)]">
                      {(offer.itineraries ?? []).map((it, idx) => {
                        const first = it.segments[0];
                        const last = it.segments[it.segments.length - 1];
                        if (!first || !last) return null;
                        return (
                          <div key={idx} className="flex items-center gap-4 px-5 py-4">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                              <Plane className="size-4" />
                            </div>
                            <div className="grid flex-1 grid-cols-3 items-center gap-4">
                              <div className="text-left">
                                <p className="font-mono text-base font-semibold tabular-nums text-[var(--color-fg)]">
                                  {formatTime(first.departureAt)}
                                </p>
                                <p className="text-xs text-[var(--color-fg-muted)]">
                                  {first.origin} · {formatDate(first.departureAt)}
                                </p>
                              </div>
                              <div className="text-center">
                                <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                                  {formatDuration(it.totalDurationMinutes)}
                                </p>
                                <div className="my-1 flex items-center justify-center text-[var(--color-fg-subtle)]">
                                  <span className="h-px w-8 bg-[var(--color-border-strong)]" />
                                  <ArrowRight className="mx-1 size-3" />
                                  <span className="h-px w-8 bg-[var(--color-border-strong)]" />
                                </div>
                                <p className="text-[10px] text-[var(--color-fg-subtle)]">
                                  {it.stops === 0
                                    ? 'directo'
                                    : `${it.stops} escala${it.stops > 1 ? 's' : ''}`}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="font-mono text-base font-semibold tabular-nums text-[var(--color-fg)]">
                                  {formatTime(last.arrivalAt)}
                                </p>
                                <p className="text-xs text-[var(--color-fg-muted)]">
                                  {last.destination} · {formatDate(last.arrivalAt)}
                                </p>
                              </div>
                            </div>
                            <div className="hidden text-right md:block">
                              <p className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                                {first.carrier}
                                {first.flightNumber}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-col items-stretch justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-5 py-4 lg:w-56 lg:border-l lg:border-t-0">
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                          Total
                        </p>
                        <p className="font-mono text-xl font-semibold tabular-nums text-[var(--color-fg)]">
                          {formatMoney(offer.total.amountMinor, offer.total.currency)}
                        </p>
                        <p className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">
                          ref {offer.provider.offerRef.slice(0, 12)}…
                        </p>
                      </div>
                      <Button variant="primary" size="sm" disabled>
                        Cotizar firme
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : hasSearched && result.ok && !result.error ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <Search className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            No se encontraron vuelos
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Probá con otras fechas, rutas flexibles o diferente cabina.
          </p>
        </div>
      ) : !hasSearched ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <Plane className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Buscá vuelos para empezar
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Seleccioná origen, destino y fechas para ver ofertas disponibles.
          </p>
        </div>
      ) : null}
    </div>
  );
}
