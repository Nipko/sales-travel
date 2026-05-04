'use client';

import { ArrowLeftRight, ArrowRight, Plane, Search } from 'lucide-react';
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
    <Button type="submit" disabled={pending} size="lg" className="w-full sm:w-auto">
      <Search className="size-4" />
      {pending ? 'Buscando…' : 'Buscar vuelos'}
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

  const [tripType, setTripType] = useState<'roundtrip' | 'oneway'>('roundtrip');
  const [departureDate, setDepartureDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [originDefault, setOriginDefault] = useState('');
  const [destinationDefault, setDestinationDefault] = useState('');
  const [comboKey, setComboKey] = useState(0);

  useEffect(() => {
    if (returnDate && departureDate && returnDate < departureDate) {
      setReturnDate(departureDate);
    }
  }, [departureDate, returnDate]);

  function handleSwap() {
    const tmp = originDefault;
    setOriginDefault(destinationDefault);
    setDestinationDefault(tmp);
    setComboKey((k) => k + 1);
  }

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
          Cotizaciones
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Buscá vuelos LATAM y armá ofertas para tus clientes.
        </p>
      </header>

      <Card className="mb-6">
        <CardContent className="p-5">
          <form action={formAction} className="space-y-4">
            {/* Trip type toggle */}
            <div className="flex w-fit gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
              <input type="hidden" name="tripType" value={tripType} />
              <button
                type="button"
                onClick={() => setTripType('roundtrip')}
                className={
                  tripType === 'roundtrip'
                    ? 'rounded-sm bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                    : 'rounded-sm px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }
              >
                Ida y vuelta
              </button>
              <button
                type="button"
                onClick={() => {
                  setTripType('oneway');
                  setReturnDate('');
                }}
                className={
                  tripType === 'oneway'
                    ? 'rounded-sm bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                    : 'rounded-sm px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }
              >
                Solo ida
              </button>
            </div>

            {/* Origin / swap / destination */}
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
              <AirportCombobox
                key={`origin-${comboKey}`}
                name="origin"
                label="Origen"
                defaultValue={originDefault}
                required
              />
              <button
                type="button"
                onClick={handleSwap}
                aria-label="Intercambiar origen y destino"
                className="hidden h-9 size-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] sm:flex"
              >
                <ArrowLeftRight className="size-4" />
              </button>
              <AirportCombobox
                key={`destination-${comboKey}`}
                name="destination"
                label="Destino"
                defaultValue={destinationDefault}
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
                  className="flex h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
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
                  className="flex h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <PaxPicker />

              <div className="space-y-1.5">
                <Label htmlFor="cabin">Cabina</Label>
                <select
                  id="cabin"
                  name="cabin"
                  defaultValue="economy"
                  className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none"
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
                  className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none"
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

            <div className="flex justify-end pt-1">
              <SubmitButton />
            </div>
          </form>
        </CardContent>
      </Card>

      {result.error ? (
        <div className="mb-4 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/8 px-4 py-3 text-sm text-[var(--color-danger)]">
          {result.error}
        </div>
      ) : null}

      {result.offers.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            {result.offers.length} {result.offers.length === 1 ? 'oferta' : 'ofertas'}
          </h2>
          <div className="space-y-3">
            {result.offers.map((offer) => (
              <Card key={offer.id} className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="flex flex-col lg:flex-row">
                    <div className="flex-1 divide-y divide-[var(--color-border)]">
                      {(offer.itineraries ?? []).map((it, idx) => {
                        const first = it.segments[0];
                        const last = it.segments[it.segments.length - 1];
                        if (!first || !last) return null;
                        return (
                          <div key={idx} className="flex items-center gap-4 px-5 py-4">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
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
                                  <ArrowRight className="size-3 mx-1" />
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
      ) : result.ok && !result.error ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Completá el form y buscá vuelos para empezar.
          </p>
        </div>
      ) : null}
    </div>
  );
}
