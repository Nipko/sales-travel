'use client';

import { Car, RefreshCw, SearchX, Ticket, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { cn } from '../../../lib/cn';
import {
  bookCarAction,
  rateDetailAction,
  searchCarsAction,
  selectCarAction,
  type BookOptions,
  type CarBookResult,
  type CarOffer,
  type CarRateDetail,
  type CarSelection,
  type DriverValues,
} from './actions';
import { CarBookingDone } from './_components/car-booking-done';
import { CarCheckout } from './_components/car-checkout';
import { CarResultSkeleton } from './_components/car-result-card';
import { CarResults } from './_components/car-results';
import { CarSearchForm } from './_components/car-search-form';
import { rentalDays, type CarSearchCriteria } from './_components/car-search-model';
import { CarSearchSummaryBar } from './_components/car-search-summary-bar';
import { ReservationPanel } from './_components/reservation-panel';

/*
 * Autos (AgentCars), con el esquema de hoteles: buscador que se pliega detrás de la barra de la
 * búsqueda, resultados con filtros y orden, y después el paso del conductor y la confirmación.
 */

type Step = 'search' | 'checkout' | 'done';

interface Selected {
  readonly offer: CarOffer;
  readonly selection: CarSelection;
  readonly rateDetail: CarRateDetail | null;
  /** Cuándo se abrió la sesión de la tarifa: vale 15 minutos. */
  readonly at: number;
}

interface Booked {
  readonly result: CarBookResult;
  readonly driverName: string;
  readonly lastName: string;
}

/** Abre la sesión de la tarifa de un auto (GetSelection) y trae su detalle de precio. */
async function openRate(
  criteria: CarSearchCriteria,
  offer: CarOffer,
): Promise<{ ok: true; selected: Selected } | { ok: false; error: string }> {
  const res = await selectCarAction(criteria.values, {
    companyCode: offer.companyCode,
    sippCode: offer.sippCode,
    ...(offer.ccrc ? { ccrc: offer.ccrc } : {}),
    ...(offer.rateType ? { rateType: offer.rateType } : {}),
  });
  if (!res.ok || !res.selection) {
    return { ok: false, error: res.error ?? 'No se pudo abrir la tarifa de ese auto.' };
  }
  const detail = await rateDetailAction(
    res.selection.uniqid,
    criteria.values.paymentType ?? res.selection.paymentOption,
    res.selection.rateCode || criteria.values.rateType,
  ).catch(() => null);
  return {
    ok: true,
    selected: {
      offer,
      // La selección no trae el rateIdentifier: es el de la oferta de la matriz, y la confirmación
      // lo pide.
      selection: offer.rateIdentifier
        ? { ...res.selection, rateIdentifier: offer.rateIdentifier }
        : res.selection,
      rateDetail: detail?.ok && detail.detail ? detail.detail : null,
      at: Date.now(),
    },
  };
}

export default function AutosPage() {
  const [step, setStep] = useState<Step>('search');
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const summaryId = useId();
  const resultsHeadingId = useId();

  // ── Búsqueda ──
  const [searching, startSearch] = useTransition();
  const [criteria, setCriteria] = useState<CarSearchCriteria | null>(null);
  const [offers, setOffers] = useState<CarOffer[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [lastAttempt, setLastAttempt] = useState<CarSearchCriteria | null>(null);
  const [editing, setEditing] = useState(false);
  const [searchToken, setSearchToken] = useState(0);
  const focusResults = useRef(false);

  // ── Selección y reserva ──
  const [selectingKey, setSelectingKey] = useState<string | undefined>(undefined);
  const [selectError, setSelectError] = useState('');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [renewing, startRenew] = useTransition();
  const [booking, setBooking] = useState(false);
  const bookingLock = useRef(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [booked, setBooked] = useState<Booked | null>(null);
  const [manage, setManage] = useState<{
    lastName?: string;
    confirmationCode?: string;
    auto?: boolean;
  } | null>(null);

  const hasResults = criteria !== null && offers.length > 0;
  const collapsed = hasResults && !editing;

  // Con resultados nuevos el formulario se pliega y el foco pasa al título de los resultados, que
  // dice cuántos autos hay; la pantalla muestra desde la barra de la búsqueda.
  useEffect(() => {
    if (searchToken === 0) return;
    setEditing(false);
    if (!focusResults.current) return;
    focusResults.current = false;
    window.requestAnimationFrame(() => {
      const heading = document.getElementById(resultsHeadingId);
      if (heading === null) return;
      heading.focus({ preventScroll: true });
      (document.getElementById(summaryId) ?? heading).scrollIntoView({ block: 'nearest' });
    });
  }, [searchToken, resultsHeadingId, summaryId]);

  const runSearch = useCallback((next: CarSearchCriteria) => {
    setSearchError('');
    setSelectError('');
    setLastAttempt(next);
    startSearch(async () => {
      const res = await searchCarsAction(next.values).catch(() => ({
        ok: false as const,
        cars: [] as CarOffer[],
        error: 'No pudimos buscar autos. Prueba de nuevo en unos segundos.',
      }));
      setSearched(true);
      if (!res.ok) {
        setSearchError(res.error ?? 'No pudimos buscar autos.');
        setOffers([]);
        setCriteria(null);
        return;
      }
      focusResults.current = res.cars.length > 0;
      setCriteria(next);
      setOffers(res.cars);
      setSearchToken((t) => t + 1);
    });
  }, []);

  function toggleEditing() {
    const next = !editing;
    setEditing(next);
    if (next) {
      window.requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus(),
      );
    }
  }

  function selectCar(offer: CarOffer, key: string) {
    if (!criteria || selectingKey) return;
    setSelectError('');
    setSelectingKey(key);
    void openRate(criteria, offer).then((opened) => {
      setSelectingKey(undefined);
      if (!opened.ok) {
        setSelectError(opened.error);
        return;
      }
      setSelected(opened.selected);
      setCheckoutError('');
      setStep('checkout');
      window.scrollTo({ top: 0 });
    });
  }

  function renewRate() {
    if (!criteria || !selected) return;
    setCheckoutError('');
    startRenew(async () => {
      const opened = await openRate(criteria, selected.offer);
      if (!opened.ok) {
        setCheckoutError(opened.error);
        return;
      }
      setSelected(opened.selected);
    });
  }

  async function confirmBooking(driver: DriverValues, options: BookOptions) {
    // Candado síncrono: el segundo clic llega antes de que React pinte el botón deshabilitado, y
    // una confirmación repetida es una segunda reserva.
    if (!criteria || !selected || bookingLock.current) return;
    bookingLock.current = true;
    setBooking(true);
    setCheckoutError('');
    try {
      const res = await bookCarAction(criteria.values, selected.selection, driver, options);
      if (!res.ok || !res.result) {
        setCheckoutError(res.error ?? 'No se pudo confirmar la reserva.');
        return;
      }
      setBooked({
        result: res.result,
        driverName: `${driver.firstName} ${driver.lastName}`,
        lastName: driver.lastName,
      });
      setStep('done');
      window.scrollTo({ top: 0 });
    } catch {
      setCheckoutError(
        'No pudimos saber si la reserva se confirmó. Revísala en «Gestionar reserva» antes de intentar de nuevo.',
      );
    } finally {
      bookingLock.current = false;
      setBooking(false);
    }
  }

  /** Después de reservar: el formulario con los datos de antes, sin los resultados viejos. */
  function newSearch() {
    setStep('search');
    setSelected(null);
    setBooked(null);
    setCheckoutError('');
    setSelectError('');
    setCriteria(null);
    setOffers([]);
    setSearched(false);
    setEditing(true);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:space-y-5 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
            <Car aria-hidden="true" className="size-5 text-[var(--color-primary)]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">Autos</h1>
            <p className="truncate text-xs text-[var(--color-fg-muted)]">
              Renta de autos con AgentCars: busca, compara y reserva
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setManage({})}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          <Ticket aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Gestionar reserva</span>
          <span className="sm:hidden">Reservas</span>
        </button>
      </header>

      <div hidden={step !== 'search'} className="space-y-4 sm:space-y-5">
        {hasResults && criteria ? (
          <CarSearchSummaryBar
            id={summaryId}
            criteria={criteria}
            editing={editing}
            searching={searching}
            onToggleEdit={toggleEditing}
            formId={formId}
          />
        ) : null}

        <CarSearchForm
          ref={formRef}
          id={formId}
          hidden={collapsed}
          searching={searching}
          onSearch={(next) => {
            focusResults.current = true;
            runSearch(next);
          }}
        />

        {searchError ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="flex items-start gap-2.5">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
              />
              <span>{searchError}</span>
            </p>
            {lastAttempt ? (
              <button
                type="button"
                onClick={() => runSearch(lastAttempt)}
                disabled={searching}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={cn('size-3.5', searching && 'animate-spin')}
                />
                Buscar de nuevo
              </button>
            ) : null}
          </div>
        ) : null}

        {selectError ? (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
            />
            {selectError}
          </p>
        ) : null}

        {searching && !hasResults ? (
          <div role="status" aria-live="polite" className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
              <span className="size-3.5 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" />
              Buscando autos disponibles en AgentCars…
            </p>
            {[0, 1, 2].map((i) => (
              <CarResultSkeleton key={i} />
            ))}
          </div>
        ) : hasResults && criteria ? (
          <CarResults
            offers={offers}
            days={rentalDays(criteria.values)}
            searching={searching}
            selectingKey={selectingKey}
            onSelect={selectCar}
            headingId={resultsHeadingId}
          />
        ) : searched && !searching && !searchError ? (
          <NoCars />
        ) : null}
      </div>

      {step === 'checkout' && criteria && selected ? (
        <CarCheckout
          criteria={criteria}
          selection={selected.selection}
          rateDetail={selected.rateDetail}
          selectedAt={selected.at}
          booking={booking}
          renewing={renewing}
          error={checkoutError}
          onBack={() => {
            setStep('search');
            setCheckoutError('');
          }}
          onRenew={renewRate}
          onConfirm={(driver, options) => void confirmBooking(driver, options)}
        />
      ) : null}

      {step === 'done' && criteria && selected && booked ? (
        <CarBookingDone
          result={booked.result}
          criteria={criteria}
          selection={selected.selection}
          driverName={booked.driverName}
          onViewVoucher={() =>
            setManage({
              lastName: booked.lastName,
              confirmationCode: booked.result.confirmationCode,
              auto: true,
            })
          }
          onNewSearch={newSearch}
        />
      ) : null}

      {manage ? (
        <ReservationPanel
          prefill={manage}
          autoLookup={manage.auto ?? false}
          onClose={() => setManage(null)}
        />
      ) : null}
    </div>
  );
}

/** Sin autos: qué probar, dicho para que el vendedor se lo pueda repetir al cliente. */
function NoCars() {
  return (
    <div
      role="status"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center"
    >
      <SearchX aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
      <p className="text-sm font-medium text-[var(--color-fg)]">
        AgentCars no tiene autos para esta búsqueda
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
        Prueba con otro horario (muchas oficinas no atienden de noche), otras fechas o la ciudad en
        vez del aeropuerto.
      </p>
    </div>
  );
}
