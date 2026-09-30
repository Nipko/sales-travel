'use client';

import { Info, TriangleAlert } from 'lucide-react';
import { forwardRef, useEffect, useId, useState, type FormEvent } from 'react';
import { DateRangePicker } from '../../../../components/ui/date-range-picker';
import { Select } from '../../../../components/ui/field';
import { SearchButtonLabel } from '../../../../components/ui/search-loading';
import { cn } from '../../../../lib/cn';
import { getRatesAction, type CarLocation, type PaymentType, type RateType } from '../actions';
import { CarLocationCombobox } from './location-combobox';
import {
  DEFAULT_HOUR,
  HOUR_SLOTS,
  PAYMENT_LABELS,
  buildSearchValues,
  daysLabel,
  nowAt,
  rentalDaysOf,
  rentalRangeLabel,
  type CarSearchCriteria,
  type CarSearchDraft,
  type SearchField,
} from './car-search-model';

/*
 * El formulario de búsqueda de autos, con la forma del de hoteles: lugares con autocompletado,
 * fechas de recogida y devolución en un solo calendario (como vuelos y hoteles) con sus horas al
 * lado, forma de pago y tipo de tarifa. Queda montado aunque se pliegue detrás de la barra de la
 * búsqueda, así "Editar búsqueda" lo abre con los mismos datos.
 */

const labelClass = 'block text-xs font-medium text-[var(--color-fg)]';

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
    dates: useId(),
    pickUpDate: useId(),
    pickUpTime: useId(),
    dropOffDate: useId(),
    dropOffTime: useId(),
    rateType: useId(),
    error: useId(),
  };

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

  // El primer día elegible es el de hoy EN EL MOSTRADOR, con el mismo reloj que
  // `buildSearchValues`: con la fecha del navegador el calendario ofrecía un día que después se
  // rechazaba (o escondía uno válido) cuando la recogida está en otro huso.
  const today = nowAt(new Date(), pickup?.timezone).date;

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
  const days = rentalDaysOf(
    { start: pickUpDate || null, end: dropOffDate || null },
    pickUpTime,
    dropOffTime,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // El botón sigue enfocable mientras se busca (`aria-disabled`): no se lanza otra encima.
    if (searching) return;
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

      <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-x-4">
        {/* Recogida y devolución en el mismo calendario: primer clic la recogida, segundo la
            devolución. Devolver el mismo día vale; lo decide la hora (`buildSearchValues`). */}
        <div className="col-span-2 space-y-1.5 lg:col-span-1">
          <span id={ids.dates} className={labelClass}>
            Fechas
          </span>
          <DateRangePicker
            mode="roundtrip"
            purpose="rental"
            size="md"
            value={{ start: pickUpDate || null, end: dropOffDate || null }}
            onChange={(range) => {
              setPickUpDate(range.start ?? '');
              setDropOffDate(range.end ?? '');
              if (problem?.field === 'pickUpDate' || problem?.field === 'dropOffDate') {
                setProblem(null);
              }
            }}
            min={today}
            startName="pickUpDate"
            endName="dropOffDate"
            triggerId={ids.pickUpDate}
            endTriggerId={ids.dropOffDate}
            labelledBy={ids.dates}
            invalid={invalid('pickUpDate') || invalid('dropOffDate')}
            describedBy={describedBy('pickUpDate') ?? describedBy('dropOffDate')}
            describeLength={(range) => rentalRangeLabel(range, pickUpTime, dropOffTime)}
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
          {/* La región viva queda montada siempre, fuera del flujo: una que aparece junto con su
              texto no se anuncia. Lo visible entra y sale sin `aria-live`. */}
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {days !== null ? `Alquiler de ${daysLabel(days)}` : ''}
          </p>
          {days !== null ? (
            <p aria-hidden="true" className="text-xs text-[var(--color-fg-muted)] sm:text-right">
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
    // `aria-disabled` y no `disabled`: el foco no se cae al `body` durante la espera y el
    // «Buscando…» se lee entero. `submit` frena el envío repetido.
    <button
      type="submit"
      aria-disabled={searching || undefined}
      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-[background-color,transform] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2 active:scale-[0.99] aria-disabled:cursor-progress aria-disabled:active:scale-100 motion-reduce:transform-none sm:w-auto"
    >
      <SearchButtonLabel searching={searching}>Buscar autos</SearchButtonLabel>
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
