'use client';

import { ArrowLeft, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Field, Select, TextInput } from '../../../../components/ui/field';
import {
  bookActivityAction,
  prebookAction,
  type BookOutcome,
  type PrebookOutcome,
  type TravelerInput,
} from '../actions';
import {
  formatDate,
  formatMoney,
  participantCount,
  saleOf,
  travelersMismatch,
  type ActivityOffer,
} from './activity-model';

interface TravelerDraft {
  firstName: string;
  lastName: string;
  birthDate: string;
  docType: 'PASSPORT' | 'LOCAL';
  docNumber: string;
}

const EMPTY: TravelerDraft = {
  firstName: '',
  lastName: '',
  birthDate: '',
  docType: 'PASSPORT',
  docNumber: '',
};

/**
 * Reserva a cuenta corriente: abre el prebook (revalida la tarifa y trae las políticas de cambio,
 * que hay que mostrarle al cliente), pide a TODOS los participantes y confirma.
 */
export function ActivityCheckout({
  offer,
  onBack,
  onBooked,
}: {
  offer: ActivityOffer;
  onBack: () => void;
  onBooked: (result: BookOutcome, holder: string) => void;
}) {
  const count = participantCount(offer.participants);
  const [prebook, setPrebook] = useState<PrebookOutcome | null>(null);
  const [prebookError, setPrebookError] = useState('');
  const [travelers, setTravelers] = useState<TravelerDraft[]>(() =>
    Array.from({ length: count }, () => ({ ...EMPTY })),
  );
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [booking, setBooking] = useState(false);
  const lock = useRef(false);
  const needsDoc = offer.category === 'ticket';

  useEffect(() => {
    void prebookAction(offer.choiceId).then((res) => {
      if (res.ok) setPrebook(res.data);
      else setPrebookError(res.error);
    });
  }, [offer.choiceId]);

  function update(i: number, patch: Partial<TravelerDraft>) {
    setTravelers((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!prebook || lock.current) return;
    const missing = travelers.findIndex(
      (t) =>
        !t.firstName.trim() ||
        !t.lastName.trim() ||
        !t.birthDate ||
        (needsDoc && !t.docNumber.trim()),
    );
    if (missing !== -1) {
      setError(`Completa los datos del participante ${missing + 1}.`);
      return;
    }
    const mismatch = travelersMismatch(
      offer.participants,
      travelers.map((t) => t.birthDate),
      offer.date,
    );
    if (mismatch) {
      setError(mismatch);
      return;
    }
    lock.current = true;
    setBooking(true);
    setError('');
    const payload: TravelerInput[] = travelers.map((t) => ({
      firstName: t.firstName.trim(),
      lastName: t.lastName.trim(),
      birthDate: t.birthDate,
      ...(t.docNumber.trim()
        ? { identification: { type: t.docType, number: t.docNumber.trim() } }
        : {}),
    }));
    try {
      const res = await bookActivityAction({
        prebookId: prebook.prebookId,
        offer: {
          choiceId: offer.choiceId,
          activityId: offer.activityId,
          name: offer.name,
          category: offer.category,
          date: offer.date,
          currency: offer.price.currency,
          netMinor: offer.price.gross.amountMinor,
          ...(offer.modalityId ? { modalityId: offer.modalityId } : {}),
          ...(offer.modalityName ? { modalityName: offer.modalityName } : {}),
          ...(offer.startAt ? { startAt: offer.startAt } : {}),
        },
        contact: { email: email.trim() },
        travelers: payload,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onBooked(res.data, `${payload[0]?.firstName ?? ''} ${payload[0]?.lastName ?? ''}`.trim());
    } catch {
      setError(
        'No pudimos saber si la reserva se confirmó. Revisa Mis Reservas antes de intentar de nuevo.',
      );
    } finally {
      lock.current = false;
      setBooking(false);
    }
  }

  const policies = prebook?.exchangePolicies ?? [];

  return (
    <form onSubmit={(e) => void confirm(e)} className="space-y-4" noValidate>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Volver a la actividad
      </button>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
        <h2 className="text-base font-semibold">{offer.modalityName ?? offer.name}</h2>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {offer.name} · {formatDate(offer.date)} · {count} participantes ·{' '}
          <span className="font-medium text-[var(--color-fg)]">{formatMoney(saleOf(offer))}</span>
        </p>
        <p className="mt-2 flex items-start gap-2 text-xs text-[var(--color-fg-muted)]">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          Se paga con la cuenta corriente de la agencia en Despegar.
        </p>
      </section>

      {prebookError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
          />
          {prebookError}
        </p>
      ) : !prebook ? (
        <p role="status" className="text-sm text-[var(--color-fg-muted)]">
          Revalidando la tarifa con Despegar…
        </p>
      ) : !prebook.currentAccountAvailable ? (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3 text-sm"
        >
          La cuenta de Despegar no ofrece cuenta corriente para esta actividad. No se puede reservar
          desde aquí.
        </p>
      ) : null}

      {policies.length > 0 ? (
        <section
          aria-labelledby="policies-title"
          className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h3 id="policies-title" className="text-sm font-semibold">
            Políticas de cambio y cancelación (léelas con el cliente)
          </h3>
          {policies.map((p, i) => (
            <div key={i} className="space-y-1 text-xs text-[var(--color-fg-muted)]">
              {p.summaries.map((s, j) => (
                <p key={`s${j}`}>
                  <span className="font-medium text-[var(--color-fg)]">{s.title}</span>{' '}
                  {s.description}
                </p>
              ))}
              {p.conditions
                .flatMap((c) => c.answers)
                .map((a, j) => (
                  <p key={`a${j}`}>
                    {a.question ? (
                      <span className="font-medium text-[var(--color-fg)]">{a.question} </span>
                    ) : null}
                    {a.answer}
                  </p>
                ))}
              {p.disclaimers.map((d, j) => (
                <p key={`d${j}`}>
                  {d.title ? `${d.title}: ` : ''}
                  {d.description}
                </p>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      <section
        aria-labelledby="travelers-title"
        className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <h3 id="travelers-title" className="text-sm font-semibold">
          Participantes
        </h3>
        {travelers.map((t, i) => (
          <fieldset
            key={i}
            className="grid gap-3 border-t border-[var(--color-border)] pt-3 first-of-type:border-0 first-of-type:pt-0 sm:grid-cols-2"
          >
            <legend className="mb-1 text-xs font-semibold text-[var(--color-fg-muted)]">
              {i === 0 ? 'Participante 1 (titular)' : `Participante ${i + 1}`}
            </legend>
            <Field label="Nombre" required>
              {(p) => (
                <TextInput
                  {...p}
                  autoComplete="off"
                  value={t.firstName}
                  onChange={(e) => update(i, { firstName: e.target.value })}
                />
              )}
            </Field>
            <Field label="Apellido" required>
              {(p) => (
                <TextInput
                  {...p}
                  autoComplete="off"
                  value={t.lastName}
                  onChange={(e) => update(i, { lastName: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Fecha de nacimiento"
              required
              hint="Con ella se verifica la edad el día de la actividad."
            >
              {(p) => (
                <TextInput
                  {...p}
                  type="date"
                  value={t.birthDate}
                  onChange={(e) => update(i, { birthDate: e.target.value })}
                />
              )}
            </Field>
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <Field label="Documento">
                {(p) => (
                  <Select
                    {...p}
                    value={t.docType}
                    onChange={(e) =>
                      update(i, { docType: e.target.value as TravelerDraft['docType'] })
                    }
                  >
                    <option value="PASSPORT">Pasaporte</option>
                    <option value="LOCAL">Nacional</option>
                  </Select>
                )}
              </Field>
              <Field label="Número" required={needsDoc}>
                {(p) => (
                  <TextInput
                    {...p}
                    autoComplete="off"
                    value={t.docNumber}
                    onChange={(e) => update(i, { docNumber: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </fieldset>
        ))}
        <Field label="Correo de contacto" required hint="Ahí llega la confirmación de Despegar.">
          {(p) => (
            <TextInput
              {...p}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
      </section>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
          />
          {error}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-4 border-t border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        <Button
          type="submit"
          size="lg"
          className="w-full sm:w-auto"
          disabled={!prebook || !prebook.currentAccountAvailable || booking || !email.includes('@')}
        >
          {booking ? 'Confirmando…' : `Confirmar reserva · ${formatMoney(saleOf(offer))}`}
        </Button>
      </div>
    </form>
  );
}
