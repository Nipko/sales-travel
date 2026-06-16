'use client';

import {
  ArrowLeft,
  Car,
  CheckCircle2,
  DoorOpen,
  Info,
  Loader2,
  Luggage,
  Search,
  Snowflake,
  Ticket,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { cn } from '../../../lib/cn';
import { CarLocationCombobox } from './_components/location-combobox';
import { ReservationPanel } from './_components/reservation-panel';
import {
  bookCarAction,
  getRatesAction,
  rateDetailAction,
  searchCarsAction,
  selectCarAction,
  type CarLocation,
  type CarOffer,
  type CarRateDetail,
  type CarSearchValues,
  type CarSelection,
  type CarBookResult,
  type DriverValues,
  type Money,
  type PaymentType,
  type RateType,
} from './actions';

type Step = 'search' | 'checkout' | 'done';

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
  'transition-all duration-150',
);
const labelClass = 'block text-xs font-medium text-[var(--color-fg)]';

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function money(m: Money): string {
  return `${(m.amountMinor / 100).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}`;
}

function moneyMinor(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** Precio de venta (neto + markup del consolidador si hay reglas); si no, el neto del proveedor. */
function salePrice(o: CarOffer): { minor: number; currency: string } {
  return o.pricing
    ? { minor: o.pricing.finalMinor, currency: o.pricing.currency }
    : { minor: o.rateAmount.amountMinor, currency: o.rateAmount.currency };
}

export default function AutosPage() {
  const today = todayISO();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>('search');
  const [error, setError] = useState('');

  // Form de búsqueda
  const [pickup, setPickup] = useState<CarLocation | null>(null);
  const [dropoff, setDropoff] = useState<CarLocation | null>(null);
  const [sameDropoff, setSameDropoff] = useState(true);
  const [pickUpDate, setPickUpDate] = useState('');
  const [dropOffDate, setDropOffDate] = useState('');
  const [pickUpTime, setPickUpTime] = useState('10:00');
  const [dropOffTime, setDropOffTime] = useState('10:00');
  const [paymentType, setPaymentType] = useState<PaymentType>('ppd');

  // Tipo de tarifa: 'best' siempre disponible; el resto se trae de /cars/rates según país.
  const [rateType, setRateType] = useState('best');
  const [rates, setRates] = useState<RateType[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const pickupCountry = pickup?.countryCode?.toUpperCase() ?? '';

  // Resultados / selección / reserva
  const [search, setSearch] = useState<CarSearchValues | null>(null);
  const [cars, setCars] = useState<CarOffer[]>([]);
  const [selection, setSelection] = useState<CarSelection | null>(null);
  const [rateDetail, setRateDetail] = useState<CarRateDetail | null>(null);
  const [driver, setDriver] = useState<DriverValues>({
    firstName: '',
    lastName: '',
    email: '',
    age: 30,
  });
  const [booking, setBooking] = useState<CarBookResult | null>(null);
  const [manage, setManage] = useState<{
    lastName?: string;
    confirmationCode?: string;
    auto?: boolean;
  } | null>(null);
  // Resultados inline (el buscador NO se oculta) + filtros/orden del lado del cliente.
  const [searched, setSearched] = useState(false);
  const [sortBy, setSortBy] = useState<'price-asc' | 'price-desc'>('price-asc');
  const [fCompany, setFCompany] = useState('all');
  const [fTrans, setFTrans] = useState<'all' | 'auto' | 'manual'>('all');
  const [fAir, setFAir] = useState(false);

  const companies = useMemo(
    () => Array.from(new Set(cars.map((c) => c.companyName).filter(Boolean))).sort(),
    [cars],
  );

  const filteredCars = useMemo(() => {
    const out = cars.filter((c) => {
      if (fCompany !== 'all' && c.companyName !== fCompany) return false;
      if (fTrans === 'auto' && !/autom/i.test(c.trans)) return false;
      if (fTrans === 'manual' && !/manual|mec/i.test(c.trans)) return false;
      if (fAir && !c.air) return false;
      return true;
    });
    out.sort((a, b) => {
      const pa = salePrice(a).minor;
      const pb = salePrice(b).minor;
      return sortBy === 'price-asc' ? pa - pb : pb - pa;
    });
    return out;
  }, [cars, fCompany, fTrans, fAir, sortBy]);

  // Trae el catálogo de tarifas cuando hay país de recogida; resetea rateType si ya no es válido.
  useEffect(() => {
    if (!pickupCountry) {
      setRates([]);
      setRateType('best');
      return;
    }
    let cancelled = false;
    setRatesLoading(true);
    void getRatesAction(pickupCountry).then((result) => {
      if (cancelled) return;
      setRates(result);
      setRateType((current) =>
        current === 'best' || result.some((r) => r.id === current) ? current : 'best',
      );
      setRatesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pickupCountry]);

  function runSearch() {
    setError('');
    const dest = pickupCountry;
    if (!pickup) {
      setError('Elegí un lugar de recogida.');
      return;
    }
    if (!sameDropoff && !dropoff) {
      setError('Elegí un lugar de devolución.');
      return;
    }
    // Si la ubicación tiene IATA usamos el código; si es ciudad usamos "City"/"City2" + coordenadas.
    const dropLoc = sameDropoff ? pickup : dropoff;
    const pickUpLocation = pickup.iata ?? 'City';
    const dropOffLocation = sameDropoff ? pickUpLocation : (dropLoc?.iata ?? 'City2');

    const values: CarSearchValues = {
      pickUpLocation,
      dropOffLocation,
      country: dest,
      pickUpDate,
      dropOffDate,
      pickUpHour: pickUpTime,
      dropOffHour: dropOffTime,
      rateType: rateType || 'best',
      paymentType,
    };
    if (pickUpLocation === 'City') {
      values.lat = pickup.latitude;
      values.lng = pickup.longitude;
    }
    if (dropOffLocation === 'City2' && dropLoc) {
      values.latDropOff = dropLoc.latitude;
      values.lngDropOff = dropLoc.longitude;
    }
    setSearched(true);
    startTransition(async () => {
      const res = await searchCarsAction(values);
      if (!res.ok) {
        setError(res.error ?? 'No se pudo buscar.');
        setCars([]);
        return;
      }
      setSearch(values);
      setCars(res.cars);
    });
  }

  function selectCar(car: CarOffer) {
    if (!search) return;
    setError('');
    startTransition(async () => {
      const res = await selectCarAction(search, {
        companyCode: car.companyCode,
        sippCode: car.sippCode,
        ...(car.ccrc ? { ccrc: car.ccrc } : {}),
        ...(car.rateType ? { rateType: car.rateType } : {}),
      });
      if (!res.ok || !res.selection) {
        setError(res.error ?? 'No se pudo seleccionar el auto.');
        return;
      }
      setSelection(res.selection);
      setRateDetail(null);
      const detail = await rateDetailAction(
        res.selection.uniqid,
        search.paymentType ?? res.selection.paymentOption,
        res.selection.rateCode || search.rateType,
      );
      if (detail.ok && detail.detail) setRateDetail(detail.detail);
      setStep('checkout');
    });
  }

  function confirmBooking() {
    if (!search || !selection) return;
    setError('');
    startTransition(async () => {
      const res = await bookCarAction(search, selection, driver);
      if (!res.ok || !res.result) {
        setError(res.error ?? 'No se pudo confirmar la reserva.');
        return;
      }
      setBooking(res.result);
      setStep('done');
    });
  }

  function reset() {
    setStep('search');
    setSearch(null);
    setCars([]);
    setSearched(false);
    setSelection(null);
    setRateDetail(null);
    setBooking(null);
    setError('');
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
            <Car className="size-5 text-[var(--color-primary)]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">Autos</h1>
            <p className="text-xs text-[var(--color-fg-muted)]">
              Renta de autos vía AgentCars · búsqueda, selección y reserva
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setManage({})}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <Ticket className="size-3.5" />
          Gestionar reserva
        </button>
      </header>

      <Stepper step={step} />

      {error ? (
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}

      {/* ─────────── Paso 1: Búsqueda ─────────── */}
      {step === 'search' ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <CarLocationCombobox label="Recogida" value={pickup} onSelect={setPickup} />
            {sameDropoff ? null : (
              <CarLocationCombobox label="Devolución" value={dropoff} onSelect={setDropoff} />
            )}
            <div className={cn('space-y-1.5', sameDropoff ? '' : 'sm:col-span-2')}>
              <label className="flex h-10 items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                <input
                  type="checkbox"
                  checked={sameDropoff}
                  onChange={(e) => setSameDropoff(e.target.checked)}
                  className="size-4 accent-[var(--color-primary)]"
                />
                Devolver en el mismo lugar
              </label>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <label htmlFor="puDate" className={labelClass}>
                Fecha recogida
              </label>
              <input
                id="puDate"
                type="date"
                min={today}
                value={pickUpDate}
                onChange={(e) => {
                  setPickUpDate(e.target.value);
                  if (dropOffDate && e.target.value > dropOffDate) setDropOffDate('');
                }}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="puTime" className={labelClass}>
                Hora recogida
              </label>
              <input
                id="puTime"
                type="time"
                value={pickUpTime}
                onChange={(e) => setPickUpTime(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="doDate" className={labelClass}>
                Fecha devolución
              </label>
              <input
                id="doDate"
                type="date"
                min={pickUpDate || today}
                value={dropOffDate}
                onChange={(e) => setDropOffDate(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="doTime" className={labelClass}>
                Hora devolución
              </label>
              <input
                id="doTime"
                type="time"
                value={dropOffTime}
                onChange={(e) => setDropOffTime(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <span className={labelClass}>Pago</span>
                <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5">
                  {(['ppd', 'pod'] as PaymentType[]).map((pt) => (
                    <button
                      key={pt}
                      type="button"
                      onClick={() => setPaymentType(pt)}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                        paymentType === pt
                          ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
                      )}
                    >
                      {pt === 'ppd' ? 'Prepago' : 'En destino'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="rateType" className={labelClass}>
                  Tipo de tarifa
                </label>
                <select
                  id="rateType"
                  value={rateType}
                  onChange={(e) => setRateType(e.target.value)}
                  disabled={!pickupCountry || ratesLoading}
                  className={cn(inputClass, 'w-48 disabled:cursor-not-allowed disabled:opacity-60')}
                >
                  <option value="best">
                    {ratesLoading ? 'Mejor tarifa (cargando…)' : 'Mejor tarifa'}
                  </option>
                  {rates
                    .filter((r) => r.id !== 'best')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={runSearch}
              disabled={isPending}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Buscando…
                </>
              ) : (
                <>
                  <Search className="size-4" /> Buscar autos
                </>
              )}
            </button>
          </div>
        </div>
      ) : null}

      {/* ─────────── Resultados (inline, debajo del buscador) ─────────── */}
      {step === 'search' && isPending ? <CarSearchLoader /> : null}

      {step === 'search' && !isPending && searched ? (
        cars.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-12 text-center">
            <Car className="mx-auto mb-2 size-7 text-[var(--color-fg-subtle)]" />
            <p className="text-sm font-medium text-[var(--color-fg)]">Sin autos disponibles</p>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Probá con otras fechas, ubicación o tipo de tarifa.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <ResultsFilters
              total={cars.length}
              shown={filteredCars.length}
              companies={companies}
              fCompany={fCompany}
              setFCompany={setFCompany}
              fTrans={fTrans}
              setFTrans={setFTrans}
              fAir={fAir}
              setFAir={setFAir}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />
            {filteredCars.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-10 text-center text-xs text-[var(--color-fg-muted)]">
                Ningún auto coincide con los filtros. Ajustalos para ver más opciones.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredCars.map((car, i) => (
                  <CarCard
                    key={`${car.companyCode}-${car.sippCode}-${car.rateType ?? i}`}
                    car={car}
                    pending={isPending}
                    onSelect={() => selectCar(car)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      ) : null}

      {/* ─────────── Paso 3: Checkout ─────────── */}
      {step === 'checkout' && selection ? (
        <div className="space-y-4">
          <BackButton onClick={() => setStep('search')} label="Volver a resultados" />
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-xs text-[var(--color-fg-muted)]">
            <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" />
            <span>
              {(search?.paymentType ?? selection.paymentOption) === 'ppd' ? (
                <>
                  <strong className="text-[var(--color-fg)]">Prepago (PPD):</strong> el cliente paga
                  ahora el monto de la reserva y al confirmar se genera un <strong>voucher</strong>{' '}
                  con número que presenta en el mostrador. El cobro al cliente lo hace tu
                  plataforma; AgentCars no toma datos de tarjeta.
                </>
              ) : (
                <>
                  <strong className="text-[var(--color-fg)]">Pago en destino (POD):</strong> el
                  cliente paga el total en el mostrador al retirar el auto. Acá solo se confirma la
                  reserva.
                </>
              )}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]">
              <h2 className="mb-4 text-sm font-semibold text-[var(--color-fg)]">
                Datos del conductor
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="fn" className={labelClass}>
                    Nombre
                  </label>
                  <input
                    id="fn"
                    value={driver.firstName}
                    onChange={(e) => setDriver({ ...driver, firstName: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="ln" className={labelClass}>
                    Apellido
                  </label>
                  <input
                    id="ln"
                    value={driver.lastName}
                    onChange={(e) => setDriver({ ...driver, lastName: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="em" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="em"
                    type="email"
                    value={driver.email}
                    onChange={(e) => setDriver({ ...driver, email: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="age" className={labelClass}>
                    Edad del conductor
                  </label>
                  <input
                    id="age"
                    type="number"
                    min={18}
                    max={99}
                    value={driver.age}
                    onChange={(e) => setDriver({ ...driver, age: Number(e.target.value) })}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={confirmBooking}
                  disabled={isPending}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Confirmando…
                    </>
                  ) : (
                    'Confirmar reserva'
                  )}
                </button>
              </div>
            </div>

            <SelectionSummary selection={selection} rateDetail={rateDetail} />
          </div>
        </div>
      ) : null}

      {/* ─────────── Paso 4: Confirmación ─────────── */}
      {step === 'done' && booking ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-10 text-emerald-600" />
          <h2 className="text-base font-semibold text-emerald-900">
            {booking.status === 'on_hold'
              ? 'Reserva en espera (ON HOLD)'
              : booking.status === 'on_request'
                ? 'Reserva on request'
                : 'Reserva confirmada'}
          </h2>
          <p className="mt-1 text-sm text-emerald-800">
            Código de confirmación:{' '}
            <span className="font-mono font-semibold">{booking.confirmationCode}</span>
          </p>
          <p className="mt-0.5 text-xs text-emerald-700">
            {booking.sippCode} · tarifa {booking.rateCode}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() =>
                setManage({
                  lastName: driver.lastName,
                  confirmationCode: booking.confirmationCode,
                  auto: true,
                })
              }
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)]"
            >
              <Ticket className="size-4" /> Ver voucher
            </button>
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              Nueva búsqueda
            </button>
          </div>
        </div>
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

function Stepper({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'search', label: 'Búsqueda y resultados' },
    { key: 'checkout', label: 'Conductor' },
    { key: 'done', label: 'Confirmación' },
  ];
  const idx = steps.findIndex((s) => s.key === step);
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              i <= idx
                ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
            )}
          >
            <span
              className={cn(
                'flex size-4 items-center justify-center rounded-full text-[10px]',
                i <= idx
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : 'bg-[var(--color-border)] text-[var(--color-fg-subtle)]',
              )}
            >
              {i + 1}
            </span>
            {s.label}
          </span>
          {i < steps.length - 1 ? (
            <span className="h-px w-4 bg-[var(--color-border)]" aria-hidden />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </button>
  );
}

function Spec({ icon: Icon, value }: { icon: typeof Users; value: string | number }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
      <Icon className="size-3.5 text-[var(--color-fg-subtle)]" />
      {value}
    </span>
  );
}

function CarCard({
  car,
  pending,
  onSelect,
}: {
  car: CarOffer;
  pending: boolean;
  onSelect: () => void;
}) {
  const sp = salePrice(car);
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-shadow hover:shadow-md">
      <div className="relative flex h-36 items-center justify-center bg-[var(--color-surface-muted)]">
        {car.imageUrl ? (
          <img
            src={car.imageUrl}
            alt={car.carModel || car.category}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <Car className="size-10 text-[var(--color-fg-subtle)]" />
        )}
        <span className="absolute left-2 top-2 rounded-md bg-[var(--color-surface)]/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--color-fg-muted)] shadow-sm">
          {car.sippCode}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-[var(--color-fg)]">{car.category}</h3>
          <p className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)]">
            {car.carModel} · {car.companyName}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Spec icon={Users} value={car.passengers} />
          <Spec icon={DoorOpen} value={car.doors} />
          <Spec icon={Luggage} value={car.bags} />
          {car.trans ? (
            <span className="text-xs text-[var(--color-fg-muted)]">{car.trans}</span>
          ) : null}
          {car.air ? <Spec icon={Snowflake} value="A/C" /> : null}
        </div>
        {car.kmIncluded ? (
          <p className="text-[11px] text-[var(--color-fg-subtle)]">{car.kmIncluded}</p>
        ) : null}

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div>
            <p className="text-base font-semibold text-[var(--color-fg)]">
              {moneyMinor(sp.minor, sp.currency)}
            </p>
            {car.pricing && car.pricing.totalMarkupMinor > 0 ? (
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                neto {moneyMinor(car.pricing.netMinor, car.pricing.currency)}
              </p>
            ) : null}
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {car.paymentOption === 'ppd' ? 'Prepago' : 'En destino'}
            </p>
          </div>
          <button
            type="button"
            onClick={onSelect}
            disabled={pending}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Seleccionar
          </button>
        </div>
      </div>
    </div>
  );
}

/** Animación de carga de la búsqueda de autos (estilo del loader de vuelos) + grilla de skeletons. */
function CarSearchLoader() {
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[var(--color-primary)]/15 bg-gradient-to-b from-[var(--color-primary)]/5 to-transparent py-6">
        <div className="flex items-center gap-2">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="flex size-12 animate-pulse items-center justify-center rounded-2xl bg-amber-50 ring-1 ring-amber-200/70"
              style={{ animationDelay: `${i * 0.35}s`, animationDuration: '1.5s' }}
            >
              <Car className="size-6 text-amber-500" strokeWidth={1.75} />
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-fg-muted)]">
          <span className="size-3.5 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" />
          Buscando autos disponibles… comparando tarifas en tiempo real
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonCarCard key={i} />
        ))}
      </div>
    </div>
  );
}

function SkeletonCarCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="h-36 animate-pulse bg-[var(--color-surface-muted)]" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        <div className="flex justify-between pt-3">
          <div className="h-5 w-20 animate-pulse rounded bg-[var(--color-surface-muted)]" />
          <div className="h-9 w-24 animate-pulse rounded-lg bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    </div>
  );
}

/** Barra de filtros/orden de resultados (client-side sobre las ofertas ya cargadas). */
function ResultsFilters({
  total,
  shown,
  companies,
  fCompany,
  setFCompany,
  fTrans,
  setFTrans,
  fAir,
  setFAir,
  sortBy,
  setSortBy,
}: {
  total: number;
  shown: number;
  companies: string[];
  fCompany: string;
  setFCompany: (v: string) => void;
  fTrans: 'all' | 'auto' | 'manual';
  setFTrans: (v: 'all' | 'auto' | 'manual') => void;
  fAir: boolean;
  setFAir: (v: boolean) => void;
  sortBy: 'price-asc' | 'price-desc';
  setSortBy: (v: 'price-asc' | 'price-desc') => void;
}) {
  const selectCls = cn(
    'h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-fg)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30',
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs text-[var(--color-fg-muted)]">
        {shown} de {total} {total === 1 ? 'auto' : 'autos'}
      </span>
      <select value={fCompany} onChange={(e) => setFCompany(e.target.value)} className={selectCls}>
        <option value="all">Todas las arrendadoras</option>
        {companies.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        value={fTrans}
        onChange={(e) => setFTrans(e.target.value as 'all' | 'auto' | 'manual')}
        className={selectCls}
      >
        <option value="all">Transmisión: todas</option>
        <option value="auto">Automática</option>
        <option value="manual">Manual</option>
      </select>
      <label className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-fg-muted)]">
        <input
          type="checkbox"
          checked={fAir}
          onChange={(e) => setFAir(e.target.checked)}
          className="size-3.5 accent-[var(--color-primary)]"
        />
        A/C
      </label>
      <select
        value={sortBy}
        onChange={(e) => setSortBy(e.target.value as 'price-asc' | 'price-desc')}
        className={cn(selectCls, 'ml-auto')}
      >
        <option value="price-asc">Precio: menor a mayor</option>
        <option value="price-desc">Precio: mayor a menor</option>
      </select>
    </div>
  );
}

function SelectionSummary({
  selection,
  rateDetail,
}: {
  selection: CarSelection;
  rateDetail: CarRateDetail | null;
}) {
  return (
    <div className="h-fit rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
      {selection.imageUrl ? (
        <img
          src={selection.imageUrl}
          alt={selection.carModel || selection.category}
          className="mb-3 h-28 w-full rounded-md bg-[var(--color-surface-muted)] object-cover"
          loading="lazy"
        />
      ) : null}
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">{selection.category}</h3>
      <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
        {selection.carModel} · {selection.companyName}
      </p>
      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex justify-between">
          <dt className="text-[var(--color-fg-muted)]">Pago ahora</dt>
          <dd className="font-medium text-[var(--color-fg)]">
            {money(rateDetail?.base ?? selection.base)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[var(--color-fg-muted)]">En mostrador</dt>
          <dd className="font-medium text-[var(--color-fg)]">
            {money(rateDetail?.tax ?? selection.tax)}
          </dd>
        </div>
        {(rateDetail?.charges ?? []).map((c) => (
          <div key={c.code} className="flex justify-between text-[var(--color-fg-muted)]">
            <dt className="truncate pr-2">{c.name}</dt>
            <dd>{money(c.amount)}</dd>
          </div>
        ))}
        {selection.pricing && selection.pricing.totalMarkupMinor > 0 ? (
          <div className="flex justify-between text-emerald-700">
            <dt>Tu markup</dt>
            <dd>+{moneyMinor(selection.pricing.totalMarkupMinor, selection.pricing.currency)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-[var(--color-border)] pt-2 text-sm">
          <dt className="font-medium text-[var(--color-fg)]">Total de venta</dt>
          <dd className="font-semibold text-[var(--color-fg)]">
            {moneyMinor(salePrice(selection).minor, salePrice(selection).currency)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[10px] text-[var(--color-fg-subtle)]">
        Sesión válida 15 min. Si expira, volvé a seleccionar el auto.
      </p>
    </div>
  );
}
