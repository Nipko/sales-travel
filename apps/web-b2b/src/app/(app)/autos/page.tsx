'use client';

import {
  ArrowLeft,
  Car,
  CheckCircle2,
  DoorOpen,
  Loader2,
  Luggage,
  Search,
  Snowflake,
  Users,
} from 'lucide-react';
import { useState, useTransition } from 'react';
import { cn } from '../../../lib/cn';
import { CarLocationCombobox } from './_components/location-combobox';
import {
  bookCarAction,
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
} from './actions';

type Step = 'search' | 'results' | 'checkout' | 'done';

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

const AGE_OPTIONS: { value: 1 | 2 | 3; label: string }[] = [
  { value: 1, label: 'Mayor de 25' },
  { value: 2, label: 'Entre 21 y 24' },
  { value: 3, label: 'Menor de 21' },
];

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

  // Resultados / selección / reserva
  const [search, setSearch] = useState<CarSearchValues | null>(null);
  const [cars, setCars] = useState<CarOffer[]>([]);
  const [selection, setSelection] = useState<CarSelection | null>(null);
  const [rateDetail, setRateDetail] = useState<CarRateDetail | null>(null);
  const [driver, setDriver] = useState<DriverValues>({
    firstName: '',
    lastName: '',
    email: '',
    age: 1,
  });
  const [booking, setBooking] = useState<CarBookResult | null>(null);

  function runSearch() {
    setError('');
    const dest = pickup?.countryCode?.toUpperCase() ?? '';
    const pickIata = pickup?.iata ?? '';
    const dropIata = sameDropoff ? pickIata : (dropoff?.iata ?? '');
    if (!pickIata) {
      setError('Elegí un lugar de recogida con código de aeropuerto (IATA).');
      return;
    }
    if (!sameDropoff && !dropIata) {
      setError('Elegí un lugar de devolución con código de aeropuerto (IATA).');
      return;
    }
    const values: CarSearchValues = {
      pickUpLocation: pickIata,
      dropOffLocation: dropIata,
      country: dest,
      pickUpDate,
      dropOffDate,
      pickUpHour: pickUpTime,
      dropOffHour: dropOffTime,
      rateType: 'best',
      paymentType,
    };
    startTransition(async () => {
      const res = await searchCarsAction(values);
      if (!res.ok) {
        setError(res.error ?? 'No se pudo buscar.');
        return;
      }
      setSearch(values);
      setCars(res.cars);
      setStep('results');
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
        search.rateType,
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
    setSelection(null);
    setRateDetail(null);
    setBooking(null);
    setError('');
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
          <Car className="size-5 text-[var(--color-primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">Autos</h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Renta de autos vía AgentCars · búsqueda, selección y reserva
          </p>
        </div>
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

      {/* ─────────── Paso 2: Resultados ─────────── */}
      {step === 'results' ? (
        <div className="space-y-3">
          <BackButton onClick={() => setStep('search')} label="Modificar búsqueda" />
          {cars.length === 0 ? (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
              <Car className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
              <p className="text-sm text-[var(--color-fg-muted)]">
                Sin autos disponibles para esos lugares y fechas.
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {cars.length} {cars.length === 1 ? 'auto disponible' : 'autos disponibles'}
              </p>
              {cars.map((car, i) => (
                <CarCard
                  key={`${car.companyCode}-${car.sippCode}-${i}`}
                  car={car}
                  pending={isPending}
                  onSelect={() => selectCar(car)}
                />
              ))}
            </>
          )}
        </div>
      ) : null}

      {/* ─────────── Paso 3: Checkout ─────────── */}
      {step === 'checkout' && selection ? (
        <div className="space-y-4">
          <BackButton onClick={() => setStep('results')} label="Volver a resultados" />
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
                  <select
                    id="age"
                    value={driver.age}
                    onChange={(e) =>
                      setDriver({ ...driver, age: Number(e.target.value) as 1 | 2 | 3 })
                    }
                    className={inputClass}
                  >
                    {AGE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
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
          <button
            type="button"
            onClick={reset}
            className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)]"
          >
            Nueva búsqueda
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'search', label: 'Búsqueda' },
    { key: 'results', label: 'Resultados' },
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
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--color-fg-muted)]">
            {car.sippCode}
          </span>
          <h3 className="truncate text-sm font-semibold text-[var(--color-fg)]">{car.category}</h3>
        </div>
        <p className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)]">
          {car.carModel} · {car.companyName}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Spec icon={Users} value={car.passengers} />
          <Spec icon={DoorOpen} value={car.doors} />
          <Spec icon={Luggage} value={car.bags} />
          <span className="inline-flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
            {car.trans}
          </span>
          {car.air ? <Spec icon={Snowflake} value="A/C" /> : null}
          {car.kmIncluded ? (
            <span className="text-xs text-[var(--color-fg-muted)]">{car.kmIncluded}</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end">
        <div className="text-right">
          <p className="text-base font-semibold text-[var(--color-fg)]">{money(car.rateAmount)}</p>
          <p className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {car.paymentOption === 'ppd' ? 'Prepago' : 'En destino'}
          </p>
        </div>
        <button
          type="button"
          onClick={onSelect}
          disabled={pending}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Seleccionar
        </button>
      </div>
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
        <div className="flex justify-between border-t border-[var(--color-border)] pt-2 text-sm">
          <dt className="font-medium text-[var(--color-fg)]">Total</dt>
          <dd className="font-semibold text-[var(--color-fg)]">{money(selection.rateAmount)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-[10px] text-[var(--color-fg-subtle)]">
        Sesión válida 15 min. Si expira, volvé a seleccionar el auto.
      </p>
    </div>
  );
}
