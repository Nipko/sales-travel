'use client';

import {
  CheckCircle2,
  ChevronRight,
  FileText,
  Search,
  SearchX,
  Ticket,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useState, useTransition } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Select, TextInput } from '../../../components/ui/field';
import {
  activitiesStatusAction,
  availabilityAction,
  modalitiesAction,
  reservationAction,
  searchActivitiesAction,
  type BookOutcome,
} from './actions';
import { ActivityCheckout } from './_components/activity-checkout';
import {
  formatDate,
  formatMoney,
  type ActivitiesStatus,
  type ActivityDetail,
  type ActivityOffer,
  type ActivitySummary,
  type Participants,
} from './_components/activity-model';
import { AddToPackage } from './_components/add-to-package';
import { OfferCard } from './_components/offer-card';
import { ParticipantsField } from './_components/participants-field';

/*
 * Actividades de Despegar/HotelDO: destino → actividad → modalidad, fecha y participantes →
 * tarifa (precio, cancelación, validez) → reservar o agregar a un paquete.
 */

const DESTINATIONS: readonly { code: string; label: string }[] = [
  { code: 'ORL', label: 'Orlando' },
  { code: 'MIA', label: 'Miami' },
  { code: 'CUN', label: 'Cancún' },
  { code: 'RIO', label: 'Río de Janeiro' },
  { code: 'SAO', label: 'São Paulo' },
  { code: 'BUE', label: 'Buenos Aires' },
  { code: 'BOG', label: 'Bogotá' },
  { code: 'CTG', label: 'Cartagena' },
  { code: 'LIM', label: 'Lima' },
  { code: 'CUZ', label: 'Cusco' },
];

type Step = 'search' | 'checkout' | 'done';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ActividadesPage() {
  const [status, setStatus] = useState<ActivitiesStatus | null>(null);
  const [step, setStep] = useState<Step>('search');
  const destId = useId();

  const [destination, setDestination] = useState('ORL');
  const [searching, startSearch] = useTransition();
  const [results, setResults] = useState<ActivitySummary[] | null>(null);
  const [searchError, setSearchError] = useState('');

  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [loadingDetail, startDetail] = useTransition();
  const [modalityId, setModalityId] = useState('');
  const [date, setDate] = useState('');
  const [schedule, setSchedule] = useState('');
  const [participants, setParticipants] = useState<Participants>({ adults: 2, childrenAges: [] });
  const [participantsError, setParticipantsError] = useState<string | undefined>();
  const [quoting, startQuote] = useTransition();
  const [offer, setOffer] = useState<ActivityOffer | null>(null);
  const [offerError, setOfferError] = useState('');
  const [packaging, setPackaging] = useState(false);

  const [booked, setBooked] = useState<{ result: BookOutcome; holder: string } | null>(null);
  const [voucherUrl, setVoucherUrl] = useState<string | undefined>();

  useEffect(() => {
    void activitiesStatusAction().then(setStatus);
  }, []);

  const modality = detail?.modalities.find((m) => m.id === modalityId);
  const hours = modality?.availableDates.find((d) => d.date === date)?.hours ?? [];

  function search(e: React.FormEvent) {
    e.preventDefault();
    setSearchError('');
    setDetail(null);
    setOffer(null);
    startSearch(async () => {
      const res = await searchActivitiesAction(destination);
      if (!res.ok) {
        setResults(null);
        setSearchError(res.error);
        return;
      }
      setResults(res.data);
    });
  }

  function open(a: ActivitySummary) {
    setOffer(null);
    setOfferError('');
    setPackaging(false);
    startDetail(async () => {
      const res = await modalitiesAction(a.id);
      if (!res.ok) {
        setOfferError(res.error);
        return;
      }
      setDetail(res.data);
      const first = res.data.modalities[0];
      setModalityId(first?.id ?? '');
      setDate(first?.availableDates[0]?.date ?? '');
      setSchedule('');
    });
  }

  function quote(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !modalityId || !date || participantsError) return;
    setOfferError('');
    setOffer(null);
    setPackaging(false);
    startQuote(async () => {
      const res = await availabilityAction({
        activityId: detail.id,
        modalityId,
        date,
        participants,
        ...(schedule ? { schedule } : {}),
      });
      if (!res.ok) {
        setOfferError(res.error);
        return;
      }
      setOffer(res.data);
    });
  }

  function onBooked(result: BookOutcome, holder: string) {
    setBooked({ result, holder });
    setStep('done');
    window.scrollTo({ top: 0 });
    // La post-venta (y el voucher de HotelDO) aparece alrededor de un minuto después.
    window.setTimeout(() => {
      void reservationAction(result.reservationId).then((r) => {
        if (r.ok && r.data.voucherUrl) setVoucherUrl(r.data.voucherUrl);
      });
    }, 65_000);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:space-y-5 sm:p-6">
      <header className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
          <Ticket aria-hidden="true" className="size-5 text-[var(--color-primary)]" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
            Actividades
          </h1>
          <p className="truncate text-xs text-[var(--color-fg-muted)]">
            Tickets y tours de Despegar: busca, cotiza y reserva o súmalos a un paquete
          </p>
        </div>
      </header>

      {status && !status.enabled ? (
        <div
          role="status"
          className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3 text-sm"
        >
          {status.reason === 'kill-switch'
            ? 'Las actividades están apagadas por operaciones en este momento.'
            : 'Las actividades de Despegar todavía no están habilitadas: esperamos que Despegar active el acceso a la API.'}
        </div>
      ) : null}

      {step === 'search' ? (
        <>
          <form
            onSubmit={search}
            className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-1.5">
              <label htmlFor={destId} className="block text-xs font-semibold">
                Destino
              </label>
              <TextInput
                id={destId}
                list={`${destId}-list`}
                value={destination}
                maxLength={3}
                autoCapitalize="characters"
                onChange={(e) => setDestination(e.target.value.toUpperCase())}
                placeholder="Código de la ciudad, p. ej. ORL"
              />
              <datalist id={`${destId}-list`}>
                {DESTINATIONS.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.label}
                  </option>
                ))}
              </datalist>
            </div>
            <Button
              type="submit"
              disabled={searching || status?.enabled === false}
              className="sm:w-36"
            >
              <Search aria-hidden="true" />
              {searching ? 'Buscando…' : 'Buscar'}
            </Button>
          </form>

          {searchError ? <ErrorBox message={searchError} /> : null}

          {results && results.length === 0 ? (
            <div
              role="status"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center"
            >
              <SearchX
                aria-hidden="true"
                className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
              />
              <p className="text-sm font-medium">Despegar no tiene actividades para ese destino</p>
            </div>
          ) : null}

          {results && results.length > 0 ? (
            <ul
              aria-label="Actividades"
              className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
            >
              {results.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => open(a)}
                    aria-current={detail?.id === a.id ? 'true' : undefined}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/40 aria-[current=true]:bg-[var(--color-primary)]/5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{a.name}</span>
                      <span className="text-xs text-[var(--color-fg-muted)]">
                        {a.category === 'ticket' ? 'Ticket' : 'Tour'}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-[var(--color-fg-subtle)]"
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {loadingDetail ? (
            <p role="status" className="text-sm text-[var(--color-fg-muted)]">
              Abriendo la actividad…
            </p>
          ) : null}

          {detail ? (
            <section aria-labelledby="activity-title" className="space-y-4">
              <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
                {detail.images[0] ? (
                  <img src={detail.images[0]} alt="" className="h-40 w-full object-cover sm:h-56" />
                ) : null}
                <div className="space-y-2 p-4">
                  <h2 id="activity-title" className="text-base font-semibold">
                    {detail.name}
                  </h2>
                  {detail.duration ? (
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      Duración: {detail.duration.value}{' '}
                      {durationUnit(detail.duration.unit, detail.duration.value)}
                    </p>
                  ) : null}
                  {detail.description ? (
                    <p className="text-sm text-[var(--color-fg-muted)]">
                      {stripHtml(detail.description)}
                    </p>
                  ) : null}
                  {detail.inclusions.length > 0 || detail.exclusions.length > 0 ? (
                    <div className="grid gap-2 text-xs sm:grid-cols-2">
                      {detail.inclusions.length > 0 ? (
                        <p>
                          <span className="font-medium">Incluye:</span>{' '}
                          {detail.inclusions.join(' · ')}
                        </p>
                      ) : null}
                      {detail.exclusions.length > 0 ? (
                        <p>
                          <span className="font-medium">No incluye:</span>{' '}
                          {detail.exclusions.join(' · ')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <form
                onSubmit={quote}
                className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Modalidad" className="sm:col-span-2">
                    {(p) => (
                      <Select
                        {...p}
                        value={modalityId}
                        onChange={(e) => {
                          setModalityId(e.target.value);
                          setOffer(null);
                        }}
                      >
                        {detail.modalities.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {m.referencePrices[0]
                              ? ` · desde ${formatMoney(m.referencePrices[0])} p/p`
                              : ''}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field
                    label="Fecha"
                    hint={
                      modality && modality.availableDates.length > 0
                        ? `${modality.availableDates.length} fechas con cupo`
                        : undefined
                    }
                  >
                    {(p) => (
                      <TextInput
                        {...p}
                        type="date"
                        min={todayIso()}
                        value={date}
                        onChange={(e) => {
                          setDate(e.target.value);
                          setSchedule('');
                          setOffer(null);
                        }}
                      />
                    )}
                  </Field>
                </div>
                {hours.length > 0 ? (
                  <Field label="Horario">
                    {(p) => (
                      <Select {...p} value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                        <option value="">Cualquiera</option>
                        {hours.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
                <ParticipantsField
                  value={participants}
                  onChange={(next, err) => {
                    setParticipants(next);
                    setParticipantsError(err);
                    setOffer(null);
                  }}
                />
                {modality?.ageRanges.child || modality?.ageRanges.infant ? (
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    En esta modalidad:{' '}
                    {[
                      modality.ageRanges.infant &&
                        `bebés ${modality.ageRanges.infant.minAge}–${modality.ageRanges.infant.maxAge} años`,
                      modality.ageRanges.child &&
                        `niños ${modality.ageRanges.child.minAge}–${modality.ageRanges.child.maxAge}`,
                      modality.ageRanges.adult &&
                        `adultos desde ${modality.ageRanges.adult.minAge}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={quoting || !modalityId || !date || Boolean(participantsError)}
                  className="w-full sm:w-auto"
                >
                  {quoting ? 'Consultando…' : `Ver precio del ${date ? formatDate(date) : 'día'}`}
                </Button>
              </form>

              {offerError ? <ErrorBox message={offerError} /> : null}
              {offer ? (
                <OfferCard
                  offer={offer}
                  onBook={() => {
                    setStep('checkout');
                    window.scrollTo({ top: 0 });
                  }}
                  onAddToPackage={() => setPackaging(true)}
                />
              ) : null}
              {offer && packaging ? (
                <AddToPackage offer={offer} detail={detail} onClose={() => setPackaging(false)} />
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      {step === 'checkout' && offer ? (
        <ActivityCheckout offer={offer} onBack={() => setStep('search')} onBooked={onBooked} />
      ) : null}

      {step === 'done' && booked && offer ? (
        <section
          role="status"
          className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]"
        >
          <p className="flex items-center gap-2 text-base font-semibold">
            <CheckCircle2 aria-hidden="true" className="size-5 text-[var(--color-success)]" />
            {booked.result.status === 'SUCCESS' ? 'Reserva confirmada' : 'Reserva en proceso'}
          </p>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Reserva HotelDO</dt>
              <dd className="font-mono">{booked.result.reservationId}</dd>
            </div>
            {booked.result.pnr ? (
              <div>
                <dt className="text-xs text-[var(--color-fg-muted)]">Localizador</dt>
                <dd className="font-mono">{booked.result.pnr}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Actividad</dt>
              <dd>
                {offer.modalityName ?? offer.name} · {formatDate(offer.date)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Titular</dt>
              <dd>{booked.holder}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-fg-muted)]">Total</dt>
              <dd>
                {formatMoney({
                  amountMinor: booked.result.saleMinor,
                  currency: booked.result.currency,
                })}
              </dd>
            </div>
          </dl>
          {!booked.result.recorded ? (
            <p className="text-xs text-[var(--color-warning)]">
              La reserva está hecha en Despegar pero no quedó en Mis Reservas. Guarda el código y
              avisa a soporte.
            </p>
          ) : null}
          {voucherUrl ? (
            <a
              href={voucherUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              <FileText aria-hidden="true" className="size-4" />
              Voucher de HotelDO (entrégaselo al cliente)
            </a>
          ) : (
            <p className="text-xs text-[var(--color-fg-muted)]">
              El voucher de HotelDO aparece aquí alrededor de un minuto después de confirmar. Es
              obligatorio entregárselo al cliente.
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setStep('search');
              setOffer(null);
              setBooked(null);
              setVoucherUrl(undefined);
            }}
          >
            Nueva búsqueda
          </Button>
        </section>
      ) : null}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
      />
      {message}
    </p>
  );
}

function durationUnit(unit: string, n: number): string {
  const plural = n !== 1;
  if (unit.startsWith('day')) return plural ? 'días' : 'día';
  if (unit.startsWith('hour')) return plural ? 'horas' : 'hora';
  if (unit.startsWith('min')) return 'min';
  return unit;
}

/** La descripción de Despegar puede traer HTML: se muestra como texto. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
