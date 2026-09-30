'use client';

import {
  ArrowLeft,
  Baby,
  CalendarClock,
  Clock,
  Loader2,
  MapPin,
  Mountain,
  Navigation,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  TimerOff,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Card } from '../../../../components/ui/card';
import { Field, TextInput } from '../../../../components/ui/field';
import { cn } from '../../../../lib/cn';
import type { BookOptions, CarRateDetail, CarSelection, DriverValues } from '../actions';
import { CAR_CLASS_LABELS, carClassOf, formatMoney, modelLabel } from './car-format';
import {
  MAX_DRIVER_AGE,
  MIN_DRIVER_AGE,
  canHold,
  checkDriver,
  countdownLabel,
  holdDeadlineLabel,
  priceBreakdown,
  sessionRemainingMs,
  sessionTone,
  youngDriver,
  type DriverDraft,
  type DriverField,
} from './car-checkout-model';
import { CarPhoto, CompanyLogo } from './car-photo';
import {
  PAYMENT_LABELS,
  daysLabel,
  placeLabel,
  rentalDays,
  whenLabel,
  type CarSearchCriteria,
} from './car-search-model';

/*
 * El paso 2 de autos: conductor, extras y cómo se reserva, con el resumen a la derecha. La tarifa
 * elegida vale 15 minutos (el `uniqid` de AgentCars): el contador está a la vista y, al vencer, el
 * botón deja de confirmar y ofrece renovarla con el mismo auto, sin volver a buscar.
 */

type ExtraKey = 'gps' | 'childToddlerSeat' | 'childBoosterSeat' | 'skyracks';

const EXTRAS: readonly { key: ExtraKey; label: string; icon: LucideIcon }[] = [
  { key: 'gps', label: 'GPS', icon: Navigation },
  { key: 'childToddlerSeat', label: 'Silla de bebé (0-2 años)', icon: Baby },
  { key: 'childBoosterSeat', label: 'Silla de niño (2-5 años)', icon: Baby },
  { key: 'skyracks', label: 'Portaesquís', icon: Mountain },
];

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Card>
      <section aria-labelledby={titleId} className="p-4 sm:p-5">
        <div className="mb-4 flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
            <Icon aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
          </span>
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{description}</p>
            ) : null}
          </div>
        </div>
        {children}
      </section>
    </Card>
  );
}

export function CarCheckout({
  criteria,
  selection,
  rateDetail,
  selectedAt,
  booking,
  renewing,
  error,
  onBack,
  onRenew,
  onConfirm,
}: {
  criteria: CarSearchCriteria;
  selection: CarSelection;
  rateDetail: CarRateDetail | null;
  /** Cuándo se abrió la sesión de la tarifa (reloj del navegador). */
  selectedAt: number;
  booking: boolean;
  renewing: boolean;
  error?: string | undefined;
  onBack: () => void;
  onRenew: () => void;
  onConfirm: (driver: DriverValues, options: BookOptions) => void;
}) {
  const values = criteria.values;
  const paymentType = values.paymentType ?? selection.paymentOption;
  const [driver, setDriver] = useState<DriverDraft>({
    firstName: '',
    lastName: '',
    email: '',
    age: '30',
  });
  const [extras, setExtras] = useState<Partial<Record<ExtraKey, boolean>>>({});
  const [flightNumber, setFlightNumber] = useState('');
  const [onHold, setOnHold] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [selectedAt]);
  const remaining = sessionRemainingMs(selectedAt, now);
  const tone = sessionTone(remaining);
  const expired = tone === 'expired';

  const issues = checkDriver(driver);
  const shownIssues: Partial<Record<DriverField, string>> = submitted ? issues : {};
  const holdAllowed = canHold(values, new Date(now), criteria.pickup.timezone);
  const holdDeadline = holdDeadlineLabel(values);

  function set<K extends DriverField>(key: K, value: string) {
    setDriver((d) => ({ ...d, [key]: value }));
  }

  function confirm() {
    setSubmitted(true);
    const problems = checkDriver(driver);
    const first = (['firstName', 'lastName', 'email', 'age'] as const).find((k) => problems[k]);
    if (first) {
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>(`[data-driver-field="${first}"]`)?.focus(),
      );
      return;
    }
    const options: BookOptions = {};
    for (const { key } of EXTRAS) if (extras[key]) options[key] = true;
    if (flightNumber.trim()) options.flightNumber = flightNumber.trim().toUpperCase();
    if (onHold && holdAllowed) options.onHold = true;
    onConfirm(
      {
        firstName: driver.firstName.trim(),
        lastName: driver.lastName.trim(),
        email: driver.email.trim(),
        age: Number(driver.age),
      },
      options,
    );
  }

  const title =
    modelLabel(selection.carModel) ||
    selection.category ||
    CAR_CLASS_LABELS[carClassOf(selection.sippCode)];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Volver a los resultados
        </button>
        <SessionBadge remaining={remaining} tone={tone} />
      </div>

      {/* En el teléfono el resumen va al final, con el botón: acá arriba, qué se está reservando. */}
      <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-fg-muted)] lg:hidden">
        <span className="font-semibold text-[var(--color-fg)]">{title}</span> ·{' '}
        {selection.companyName} · {daysLabel(rentalDays(values))} ·{' '}
        <span className="font-semibold tabular-nums text-[var(--color-fg)]">
          {formatMoney(priceBreakdown(selection, rateDetail, paymentType).sale)}
        </span>
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-4">
          <SectionCard
            icon={UserRound}
            title="Conductor principal"
            description="Tal como figura en su licencia. Con el apellido y el código se consulta y se cancela la reserva."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Nombre" required error={shownIssues.firstName}>
                {(props) => (
                  <TextInput
                    {...props}
                    data-driver-field="firstName"
                    value={driver.firstName}
                    onChange={(e) => set('firstName', e.target.value)}
                    autoComplete="off"
                    autoCapitalize="words"
                    spellCheck={false}
                    maxLength={60}
                  />
                )}
              </Field>
              <Field label="Apellido" required error={shownIssues.lastName}>
                {(props) => (
                  <TextInput
                    {...props}
                    data-driver-field="lastName"
                    value={driver.lastName}
                    onChange={(e) => set('lastName', e.target.value)}
                    autoComplete="off"
                    autoCapitalize="words"
                    spellCheck={false}
                    maxLength={60}
                  />
                )}
              </Field>
              <Field
                label="Correo"
                required
                error={shownIssues.email}
                hint="Adonde AgentCars envía la confirmación."
              >
                {(props) => (
                  <TextInput
                    {...props}
                    data-driver-field="email"
                    type="email"
                    inputMode="email"
                    value={driver.email}
                    onChange={(e) => set('email', e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={120}
                  />
                )}
              </Field>
              <Field
                label="Edad"
                required
                error={shownIssues.age}
                hint={`De ${MIN_DRIVER_AGE} a ${MAX_DRIVER_AGE} años.`}
              >
                {(props) => (
                  <TextInput
                    {...props}
                    data-driver-field="age"
                    inputMode="numeric"
                    value={driver.age}
                    onChange={(e) => set('age', e.target.value.replace(/\D/g, '').slice(0, 2))}
                    autoComplete="off"
                    className="w-24"
                  />
                )}
              </Field>
            </div>
            {youngDriver(driver.age) ? (
              <p className="mt-3 flex items-start gap-1.5 rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
                <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                Con menos de 25 años la mayoría de las arrendadoras cobra un recargo por conductor
                joven en el mostrador.
              </p>
            ) : null}
          </SectionCard>

          <SectionCard
            icon={ShieldCheck}
            title="Llegada y extras"
            description="Los extras se le piden a la arrendadora: se confirman y se pagan en el mostrador."
          >
            <div className="space-y-4">
              <Field
                label="Número de vuelo (opcional)"
                hint="Si el vuelo se atrasa, el mostrador del aeropuerto espera el auto."
              >
                {(props) => (
                  <TextInput
                    {...props}
                    value={flightNumber}
                    onChange={(e) => setFlightNumber(e.target.value.slice(0, 10))}
                    placeholder="AV123"
                    autoComplete="off"
                    spellCheck={false}
                    className="max-w-40 uppercase"
                  />
                )}
              </Field>
              <fieldset>
                <legend className="mb-2 text-xs font-semibold text-[var(--color-fg)]">
                  Extras
                </legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {EXTRAS.map(({ key, label, icon: Icon }) => (
                    <label
                      key={key}
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
                        extras[key]
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-fg)]'
                          : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(extras[key])}
                        onChange={(e) => setExtras((x) => ({ ...x, [key]: e.target.checked }))}
                        className="size-4 shrink-0 accent-[var(--color-primary)]"
                      />
                      <Icon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-[var(--color-fg-subtle)]"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </SectionCard>

          <SectionCard icon={CalendarClock} title="Cómo se reserva">
            <HoldChoice
              onHold={onHold && holdAllowed}
              holdAllowed={holdAllowed}
              deadline={holdDeadline}
              onChange={setOnHold}
            />
          </SectionCard>
        </div>

        <aside aria-label="Resumen de la reserva" className="lg:sticky lg:top-4">
          <CheckoutSummary
            criteria={criteria}
            selection={selection}
            rateDetail={rateDetail}
            title={title}
            expired={expired}
            booking={booking}
            renewing={renewing}
            onHold={onHold && holdAllowed}
            error={error}
            onRenew={onRenew}
            onConfirm={confirm}
          />
          <p className="mt-2 px-1 text-[11px] text-[var(--color-fg-subtle)]">
            {PAYMENT_LABELS[paymentType]}:{' '}
            {paymentType === 'ppd'
              ? 'el cobro al cliente lo hace tu agencia; AgentCars no pide datos de tarjeta.'
              : 'el cliente paga en el mostrador al retirar el auto.'}
          </p>
        </aside>
      </div>
    </div>
  );
}

function SessionBadge({
  remaining,
  tone,
}: {
  remaining: number;
  tone: ReturnType<typeof sessionTone>;
}) {
  if (tone === 'expired') {
    return (
      <p className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-2.5 py-0.5 text-xs font-medium text-[var(--color-danger)]">
        <TimerOff aria-hidden="true" className="size-3.5" />
        Tarifa vencida
      </p>
    );
  }
  return (
    <p
      role="timer"
      aria-live="off"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums',
        tone === 'warning'
          ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
      )}
    >
      <Clock aria-hidden="true" className="size-3.5" />
      Tarifa reservada por {countdownLabel(remaining)}
    </p>
  );
}

function HoldChoice({
  onHold,
  holdAllowed,
  deadline,
  onChange,
}: {
  onHold: boolean;
  holdAllowed: boolean;
  deadline: string;
  onChange: (onHold: boolean) => void;
}) {
  const name = useId();
  const options = [
    {
      value: false,
      title: 'Confirmar ahora',
      detail: 'La reserva queda confirmada al terminar.',
    },
    {
      value: true,
      title: 'Reservar en espera (ON HOLD)',
      detail: holdAllowed
        ? `Guarda el auto sin confirmarlo. Hay que activarla antes del ${deadline} o se cancela sola.`
        : 'No disponible: faltan menos de 48 horas para el retiro.',
    },
  ];
  return (
    <fieldset>
      <legend className="sr-only">Cómo se reserva</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const disabled = o.value && !holdAllowed;
          const checked = onHold === o.value;
          return (
            <label
              key={String(o.value)}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
                checked
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
                disabled && 'cursor-not-allowed opacity-60 hover:border-[var(--color-border)]',
              )}
            >
              <input
                type="radio"
                name={name}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(o.value)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-fg)]">
                  {o.value ? (
                    <PauseCircle
                      aria-hidden="true"
                      className="size-3.5 text-[var(--color-fg-subtle)]"
                    />
                  ) : null}
                  {o.title}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--color-fg-muted)]">
                  {o.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function CheckoutSummary({
  criteria,
  selection,
  rateDetail,
  title,
  expired,
  booking,
  renewing,
  onHold,
  error,
  onRenew,
  onConfirm,
}: {
  criteria: CarSearchCriteria;
  selection: CarSelection;
  rateDetail: CarRateDetail | null;
  title: string;
  expired: boolean;
  booking: boolean;
  renewing: boolean;
  onHold: boolean;
  error?: string | undefined;
  onRenew: () => void;
  onConfirm: () => void;
}) {
  const values = criteria.values;
  const paymentType = values.paymentType ?? selection.paymentOption;
  const price = priceBreakdown(selection, rateDetail, paymentType);
  const days = rentalDays(values);
  const dropoffPlace = placeLabel(criteria.dropoff ?? criteria.pickup);

  return (
    <Card className="overflow-hidden">
      <CarPhoto src={selection.imageUrl} className="h-32 border-b border-[var(--color-border)]" />
      <div className="space-y-4 p-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">
            {CAR_CLASS_LABELS[carClassOf(selection.sippCode)]}
          </p>
          <h2 className="text-[15px] font-semibold leading-snug text-[var(--color-fg)]">{title}</h2>
          {selection.companyName ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
              <CompanyLogo src={selection.companyImageUrl} />
              {selection.companyName}
            </p>
          ) : null}
        </div>

        <dl className="space-y-2 border-t border-[var(--color-border)] pt-3 text-xs">
          <div className="flex gap-2">
            <dt className="sr-only">Recogida</dt>
            <MapPin
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
            />
            <dd className="min-w-0">
              <span className="block font-medium text-[var(--color-fg)]">
                {placeLabel(criteria.pickup)}
              </span>
              <span className="text-[var(--color-fg-muted)]">
                Recogida {whenLabel(values.pickUpDate, values.pickUpHour)}
              </span>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="sr-only">Devolución</dt>
            <MapPin
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
            />
            <dd className="min-w-0">
              <span className="block font-medium text-[var(--color-fg)]">{dropoffPlace}</span>
              <span className="text-[var(--color-fg-muted)]">
                Devolución {whenLabel(values.dropOffDate, values.dropOffHour)}
              </span>
            </dd>
          </div>
        </dl>

        <dl className="space-y-1.5 border-t border-[var(--color-border)] pt-3 text-xs">
          {price.payNow ? (
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-fg-muted)]">Se paga al reservar</dt>
              <dd className="font-medium tabular-nums text-[var(--color-fg)]">
                {formatMoney(price.payNow)}
              </dd>
            </div>
          ) : null}
          {price.atCounter ? (
            <div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-fg-muted)]">Se paga en el mostrador</dt>
                <dd className="font-medium tabular-nums text-[var(--color-fg)]">
                  {formatMoney(price.atCounter)}
                </dd>
              </div>
              {price.counterCharges.length > 0 ? (
                <ul className="mt-1 space-y-0.5 border-l border-[var(--color-border)] pl-2.5 text-[11px] text-[var(--color-fg-muted)]">
                  {price.counterCharges.map((c, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate" title={c.name}>
                        {c.name}
                      </span>
                      <span className="tabular-nums">{formatMoney(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {price.ownMargin ? (
            <div className="flex justify-between gap-3 text-[var(--color-fg-muted)]">
              <dt>
                Tu markup
                {price.cost ? (
                  <span className="text-[var(--color-fg-subtle)]">
                    {' '}
                    · neto {formatMoney(price.cost)}
                  </span>
                ) : null}
              </dt>
              <dd className="tabular-nums text-[var(--color-success)]">
                +{formatMoney(price.ownMargin)}
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3 border-t border-[var(--color-border)] pt-2">
            <dt className="text-sm font-medium text-[var(--color-fg)]">
              Total de venta
              <span className="block text-[11px] font-normal text-[var(--color-fg-muted)]">
                {daysLabel(days)} · {PAYMENT_LABELS[paymentType].toLowerCase()}
              </span>
            </dt>
            <dd className="text-xl font-bold tabular-nums text-[var(--color-fg)]">
              {formatMoney(price.sale)}
            </dd>
          </div>
        </dl>

        {/* Siempre montada: una región viva que aparece ya con texto no la anuncian todos. */}
        <div aria-live="polite" aria-atomic="true" className="space-y-3">
          {expired ? (
            <div className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-fg)]">
              <p className="flex items-start gap-1.5">
                <TimerOff
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
                />
                <span>
                  <strong className="font-semibold">La tarifa venció.</strong> AgentCars la sostiene
                  15 minutos. Renuévala para confirmar este mismo auto; el precio puede cambiar.
                </span>
              </p>
            </div>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-danger)]"
            >
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        {expired ? (
          <button
            type="button"
            onClick={onRenew}
            disabled={renewing}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" className={cn('size-4', renewing && 'animate-spin')} />
            {renewing ? 'Renovando tarifa…' : 'Renovar tarifa'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onConfirm}
            disabled={booking || renewing}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {booking ? (
              <>
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                Confirmando con AgentCars…
              </>
            ) : onHold ? (
              'Reservar en espera'
            ) : (
              'Confirmar reserva'
            )}
          </button>
        )}
      </div>
    </Card>
  );
}
