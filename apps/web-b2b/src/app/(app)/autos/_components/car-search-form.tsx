'use client';

import { Info, Loader2, Search, TriangleAlert } from 'lucide-react';
import { forwardRef, useEffect, useId, useState, type FormEvent } from 'react';
import { Select } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import { getRatesAction, type CarLocation, type PaymentType, type RateType } from '../actions';
import { CarLocationCombobox } from './location-combobox';
import {
  DEFAULT_HOUR,
  HOUR_SLOTS,
  PAYMENT_LABELS,
  buildSearchValues,
  daysLabel,
  rentalDays,
  type CarSearchCriteria,
  type CarSearchDraft,
  type SearchField,
} from './car-search-model';

/*
 * El formulario de búsqueda de autos, con la forma del de hoteles: lugares con autocompletado,
 * fechas y horas de recogida y devolución, forma de pago y tipo de tarifa. Queda montado aunque se
 * pliegue detrás de la barra de la búsqueda, así "Editar búsqueda" lo abre con los mismos datos.
 */

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
  'aria-[invalid=true]:border-[var(--color-danger)]',
  'transition-all duration-150',
);
const labelClass = 'block text-xs font-medium text-[var(--color-fg)]';

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const CarSearchForm = forwardRef<
  HTMLFormElement,
  {
    id?: string;
    hidden?: boolean;
    searching: boolean;
    onSearch: (criteria: CarSearchCriteria) => void;
  }
>(function CarSearchForm({ id, hidden = false, searching, onSearch }, ref) {
  const ids = {
    pickup: useId(),
    dropoff: useId(),
    pickUpDate: useId(),
    pickUpTime: useId(),
    dropOffDate: useId(),
    dropOffTime: useId(),
    rateType: useId(),
    error: useId(),
  };
  const today = todayISO();

  const [pickup, setPickup] = useState<CarLocation | null>(null);
  const [dropoff, setDropoff] = useState<CarLocation | null>(null);
  const [otherDropoff, setOtherDropoff] = useState(false);
  const [pickUpDate, setPickUpDate] = useState('');
  const [dropOffDate, setDropOffDate] = useState('');
  const [pickUpTime, setPickUpTime] = useState(DEFAULT_HOUR);
  const [dropOffTime, setDropOffTime] = useState(DEFAULT_HOUR);
  const [paymentType, setPaymentType] = useState<PaymentType>('ppd');
  const [problem, setProblem] = useState<{ field: SearchField; error: string } | null>(null);

  // Tipo de tarifa: 'best' siempre está; el resto sale de /cars/rates según el país de recogida.
  const [rateType, setRateType] = useState('best');
  const [rates, setRates] = useState<RateType[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const pickupCountry = pickup?.countryCode?.toUpperCase() ?? '';

  useEffect(() => {
    if (!pickupCountry) {
      setRates([]);
      setRateType('best');
      return;
    }
    let cancelled = false;
    setRatesLoading(true);
    void getRatesAction(pickupCountry)
      .catch(() => [])
      .then((result) => {
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

  const draft: CarSearchDraft = {
    pickup,
    dropoff,
    otherDropoff,
    pickUpDate,
    dropOffDate,
    pickUpTime,
    dropOffTime,
    paymentType,
    rateType,
  };
  const days =
    pickUpDate && dropOffDate && dropOffDate >= pickUpDate
      ? rentalDays({
          pickUpDate,
          dropOffDate,
          pickUpHour: pickUpTime,
          dropOffHour: dropOffTime,
        })
      : undefined;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildSearchValues(draft);
    if (!built.ok) {
      setProblem({ field: built.field, error: built.error });
      window.requestAnimationFrame(() => document.getElementById(ids[built.field])?.focus());
      return;
    }
    setProblem(null);
    onSearch({
      values: built.values,
      pickup: pickup as CarLocation,
      ...(otherDropoff && dropoff ? { dropoff } : {}),
    });
  }

  const invalid = (field: SearchField) => problem?.field === field;
  const describedBy = (field: SearchField) => (invalid(field) ? ids.error : undefined);

  return (
    <form
      ref={ref}
      id={id}
      hidden={hidden}
      noValidate
      aria-label="Búsqueda de autos"
      onSubmit={submit}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={cn(!otherDropoff && 'lg:col-span-2')}>
          <CarLocationCombobox
            label="Lugar de recogida"
            value={pickup}
            onSelect={(loc) => {
              setPickup(loc);
              if (problem?.field === 'pickup' && loc) setProblem(null);
            }}
            inputId={ids.pickup}
            invalid={invalid('pickup')}
            describedBy={describedBy('pickup')}
          />
        </div>
        {otherDropoff ? (
          <CarLocationCombobox
            label="Lugar de devolución"
            value={dropoff}
            onSelect={(loc) => {
              setDropoff(loc);
              if (problem?.field === 'dropoff' && loc) setProblem(null);
            }}
            inputId={ids.dropoff}
            invalid={invalid('dropoff')}
            describedBy={describedBy('dropoff')}
          />
        ) : null}
      </div>

      <label className="mt-2.5 inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--color-fg-muted)]">
        <input
          type="checkbox"
          checked={otherDropoff}
          onChange={(e) => setOtherDropoff(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        Devolver en otro lugar
      </label>

      <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 lg:grid-cols-4 lg:gap-x-4">
        <div className="space-y-1.5">
          <label htmlFor={ids.pickUpDate} className={labelClass}>
            Fecha de recogida
          </label>
          <input
            id={ids.pickUpDate}
            type="date"
            min={today}
            value={pickUpDate}
            aria-invalid={invalid('pickUpDate') || undefined}
            aria-describedby={describedBy('pickUpDate')}
            onChange={(e) => {
              setPickUpDate(e.target.value);
              if (dropOffDate && e.target.value > dropOffDate) setDropOffDate('');
            }}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.pickUpTime} className={labelClass}>
            Hora de recogida
          </label>
          <Select
            id={ids.pickUpTime}
            value={pickUpTime}
            aria-invalid={invalid('pickUpTime') || undefined}
            aria-describedby={describedBy('pickUpTime')}
            onChange={(e) => setPickUpTime(e.target.value)}
            className="h-10 shadow-[var(--shadow-xs)] tabular-nums"
          >
            {HOUR_SLOTS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.dropOffDate} className={labelClass}>
            Fecha de devolución
          </label>
          <input
            id={ids.dropOffDate}
            type="date"
            min={pickUpDate || today}
            value={dropOffDate}
            aria-invalid={invalid('dropOffDate') || undefined}
            aria-describedby={describedBy('dropOffDate')}
            onChange={(e) => setDropOffDate(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.dropOffTime} className={labelClass}>
            Hora de devolución
          </label>
          <Select
            id={ids.dropOffTime}
            value={dropOffTime}
            onChange={(e) => setDropOffTime(e.target.value)}
            className="h-10 shadow-[var(--shadow-xs)] tabular-nums"
          >
            {HOUR_SLOTS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
        <PaymentToggle value={paymentType} onChange={setPaymentType} />

        <div className="space-y-1.5 sm:w-52">
          <label htmlFor={ids.rateType} className={labelClass}>
            Tipo de tarifa
          </label>
          <Select
            id={ids.rateType}
            value={rateType}
            onChange={(e) => setRateType(e.target.value)}
            disabled={!pickupCountry || ratesLoading}
            className="h-10 shadow-[var(--shadow-xs)]"
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
          </Select>
        </div>

        <div className="flex flex-col gap-2 sm:ml-auto sm:flex-row sm:items-center sm:gap-3">
          {days !== undefined ? (
            <p className="text-xs text-[var(--color-fg-muted)] sm:text-right" aria-live="polite">
              Alquiler de{' '}
              <span className="font-semibold text-[var(--color-fg)]">{daysLabel(days)}</span>
            </p>
          ) : null}
          <SubmitButton searching={searching} />
        </div>
      </div>

      {problem ? (
        <p
          id={ids.error}
          role="alert"
          className="mt-3 flex items-start gap-2 text-sm font-medium text-[var(--color-danger)]"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {problem.error}
        </p>
      ) : null}

      <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-[11px] text-[var(--color-fg-muted)]">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
        />
        <span>
          Busca por aeropuerto (código IATA) o por ciudad. Los precios son de venta, por el alquiler
          completo. Clase, transmisión, pasajeros y arrendadora se filtran en los resultados, sin
          volver a buscar.
        </span>
      </div>
    </form>
  );
});

function SubmitButton({ searching }: { searching: boolean }) {
  return (
    <button
      type="submit"
      disabled={searching}
      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
    >
      {searching ? (
        <>
          <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Buscando…
        </>
      ) : (
        <>
          <Search aria-hidden="true" className="size-4" /> Buscar autos
        </>
      )}
    </button>
  );
}

/** Prepago o pago en destino: dos radios con aspecto de control segmentado. */
function PaymentToggle({
  value,
  onChange,
}: {
  value: PaymentType;
  onChange: (value: PaymentType) => void;
}) {
  const name = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className={cn(labelClass, 'mb-1.5')}>Forma de pago</legend>
      <div className="inline-flex h-10 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 shadow-[var(--shadow-xs)]">
        {(['ppd', 'pod'] as const).map((pt) => (
          <label
            key={pt}
            className={cn(
              'inline-flex h-full cursor-pointer items-center rounded-md px-3 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
              value === pt
                ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)]'
                : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            <input
              type="radio"
              name={name}
              value={pt}
              checked={value === pt}
              onChange={() => onChange(pt)}
              className="sr-only"
            />
            {PAYMENT_LABELS[pt]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
