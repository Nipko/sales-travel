'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newIdempotencyKey, type HotelBookRequest } from '../../../../../lib/hotel-book';
import { readJson } from '../../../../../lib/read-json';
import { atHotelCharges, hotelRateRows } from '../../_components/hotel-rate-view';
import { hotelLinkOf } from '../../_components/hotel-rate-selection';
import { stayNights } from '../../[hotelKey]/_components/hotel-detail-view';
import { hotelOrderStatusAction } from '../actions';
import { BookingConfirm } from './booking-confirm';
import {
  BookNoticeView,
  CancelledPanel,
  ConfirmedPanel,
  FailedPanel,
  ProgressPanel,
  UnknownPanel,
  type BookNotice,
} from './booking-panels';
import {
  TRACKING_TEXT,
  afterPoll,
  bookGate,
  classifyBookResponse,
  confirmedViewOf,
  keepsAttempt,
  pollDelayFor,
  resumeTracking,
  startTracking,
  type BookOutcome,
  type FinalState,
  type OrderStatusRead,
  type TrackingState,
} from './booking-view';
import { CheckoutExpiry } from './checkout-expiry';
import { cancelPolicyView } from './conditions-view';
import { GuestForm } from './guest-form';
import {
  AT_PROPERTY_FIELD,
  changedGuestPaths,
  checkGuestDraft,
  issuesByPath,
  type GuestDraft,
} from './guest-form-view';
import {
  NON_REFUNDABLE_FIELD,
  nonRefundableAckKey,
  nonRefundableAt,
  nonRefundableForTotal,
  type PrebookNonRefundable,
} from './non-refundable-view';
import type { AcceptedPrebook } from './prebook-view';

/*
 * El paso 2 del checkout (U-12 a U-14, U-18, U-19; RF-18, RF-20, RF-22; D-TBO-09 A): huéspedes,
 * contacto, los cargos en el hotel con su reconocimiento, la confirmación OBLIGATORIA de una tarifa
 * no reembolsable (pedido del 2026-09-29, punto c) y el Book.
 *
 * El Book sale UNA vez por intento. Cada intento lleva su `Idempotency-Key`, nueva, y el botón se
 * deshabilita mientras viaja; además un candado síncrono frena el segundo clic que llega antes de
 * que React pinte. Si la respuesta no se entiende, el intento se conserva entero —clave y cuerpo— y
 * lo único que se ofrece es reenviarlo tal cual, que el servidor reconoce: nunca otro intento con
 * los datos cambiados, que podría reservar dos veces.
 *
 * `201` es el desenlace; `202` (o un doble envío reconocido) deja la orden en curso y se la
 * consulta hasta que salga de `pending`: "confirmando" mientras el Book puede responder y
 * "verificando con el proveedor" si no respondió, nunca "fallida".
 */

interface Attempt {
  readonly key: string;
  readonly body: HotelBookRequest;
}

type Phase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'submitting'; readonly startedAt: number }
  | TrackingState
  | FinalState
  | { readonly kind: 'unknown'; readonly message: string };

type FocusTarget = 'panel' | 'notice' | 'invalid' | 'confirm';

const POLL_UNREACHABLE: OrderStatusRead = {
  ok: false,
  error: 'No pudimos consultar el estado de la reserva en este momento. Seguimos intentando.',
  notFound: false,
};

/** El primer control marcado como inválido; en un grupo de radios, su opción elegida o la primera. */
function focusFirstInvalid(root: HTMLElement | null): boolean {
  const target = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!target) return false;
  if (target.getAttribute('role') === 'radiogroup') {
    const radio =
      target.querySelector<HTMLInputElement>('input:checked') ??
      target.querySelector<HTMLInputElement>('input');
    radio?.focus();
    return radio !== null && radio !== undefined;
  }
  target.focus();
  return true;
}

export function BookingStep({
  accepted,
  draft,
  onDraftChange,
  onBack,
  onRevalidate,
}: {
  accepted: AcceptedPrebook;
  draft: GuestDraft;
  onDraftChange: (draft: GuestDraft) => void;
  /** Al paso 1 con la tarifa como está. */
  onBack: () => void;
  /** Al paso 1 revalidando la tarifa otra vez con el proveedor. */
  onRevalidate: () => void;
}) {
  const { prebook, selection, clockOffsetMs } = accepted;
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [notice, setNotice] = useState<BookNotice | undefined>(undefined);
  // Con qué se reserva: lo aceptado en el paso 1, o el precio nuevo que se aceptó acá.
  const [current, setCurrent] = useState({
    prebookRef: prebook.prebookRef,
    total: accepted.acceptedTotal,
  });
  const [repricedAccepted, setRepricedAccepted] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  // El importe que el vendedor confirmó (`amountMinor currency`). Si el 100 % cambia —aceptó un
  // precio nuevo—, la casilla vuelve a estar sin marcar: confirmó otro monto.
  const [nonRefundableAckedFor, setNonRefundableAckedFor] = useState<string>();
  // Lo que dijo el servidor al rechazar un Book sin la confirmación: gana a lo que ve la pantalla.
  const [serverNonRefundable, setServerNonRefundable] = useState<PrebookNonRefundable>();
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});
  const [expired, setExpired] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ target: FocusTarget; seq: number }>();

  const attemptRef = useRef<Attempt | null>(null);
  const inFlightRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLElement>(null);

  const row = useMemo(
    () => hotelRateRows({ roompacks: [prebook.roompack] }, selection.showProviderInResults)[0],
    [prebook.roompack, selection.showProviderInResults],
  );
  const atHotel = useMemo(() => atHotelCharges(prebook.roompack), [prebook.roompack]);
  const roomNames = useMemo(() => prebook.roompack.rooms.map((r) => r.name), [prebook.roompack]);
  const hotelLink = hotelLinkOf(selection);
  const nights = stayNights(selection.stay);

  const repriced = notice?.kind === 'repriced' ? notice : undefined;
  const effective =
    repriced && repricedAccepted
      ? { prebookRef: repriced.prebookRef, total: repriced.currentTotal }
      : current;

  // Con el reloj del servidor, en cada pintado: si el 100 % empieza a regir mientras se cargan los
  // huéspedes, la casilla aparece antes de que el servidor rechace el Book. El 100 % es el precio de
  // venta con el que se reserva (`acceptedTotal`): si acá se aceptó un precio nuevo, es ése, no el
  // del paso 1.
  const nonRefundable = nonRefundableForTotal(
    serverNonRefundable ?? nonRefundableAt(prebook, Date.now() + clockOffsetMs),
    effective.total,
  );
  const isNonRefundable = nonRefundable !== undefined;
  const nonRefundableKey = nonRefundableAckKey(nonRefundable);
  const nonRefundableAcknowledged =
    nonRefundableKey !== undefined && nonRefundableAckedFor === nonRefundableKey;
  const cancellation = useMemo(
    () => cancelPolicyView(prebook.roompack, isNonRefundable),
    [prebook.roompack, isNonRefundable],
  );

  const check = useMemo(
    () =>
      checkGuestDraft(
        draft,
        { required: atHotel.length > 0, acknowledged },
        { required: isNonRefundable, acknowledged: nonRefundableAcknowledged },
      ),
    [draft, atHotel.length, acknowledged, isNonRefundable, nonRefundableAcknowledged],
  );
  const errors = useMemo(
    () => ({ ...serverErrors, ...(attempted && !check.ok ? issuesByPath(check.issues) : {}) }),
    [serverErrors, attempted, check],
  );

  const blockedReason =
    notice?.kind === 'research' || (notice?.kind === 'rejected' && !notice.retry)
      ? notice.title
      : notice?.kind === 'revalidate'
        ? 'Revalidá la tarifa para confirmar la reserva.'
        : undefined;
  const gate = bookGate({
    expired,
    submitting: phase.kind === 'submitting',
    ...(blockedReason ? { blockedReason } : {}),
    repricedPending: repriced !== undefined && !repricedAccepted,
  });

  const requestFocus = useCallback((target: FocusTarget) => {
    setFocusRequest((r) => ({ target, seq: (r?.seq ?? 0) + 1 }));
  }, []);

  // Después de pintar: el foco va a lo que acaba de aparecer, no queda en un botón que ya no está.
  useEffect(() => {
    if (focusRequest === undefined) return;
    switch (focusRequest.target) {
      case 'panel':
        headingRef.current?.focus();
        break;
      case 'notice':
        noticeRef.current?.focus();
        break;
      case 'invalid':
        if (!focusFirstInvalid(rootRef.current)) noticeRef.current?.focus();
        break;
      case 'confirm':
        confirmRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        break;
    }
  }, [focusRequest]);

  const handleDraftChange = (next: GuestDraft) => {
    const touched = changedGuestPaths(draft, next);
    if (touched.some((path) => path in serverErrors)) {
      setServerErrors((prev) => {
        const out = { ...prev };
        for (const path of touched) delete out[path];
        return out;
      });
    }
    onDraftChange(next);
  };

  const handleAcknowledged = (value: boolean) => {
    setAcknowledged(value);
    if (AT_PROPERTY_FIELD in serverErrors) {
      setServerErrors((prev) => {
        const out = { ...prev };
        delete out[AT_PROPERTY_FIELD];
        return out;
      });
    }
  };

  const handleNonRefundableAcknowledged = (value: boolean) => {
    setNonRefundableAckedFor(value ? nonRefundableKey : undefined);
    if (NON_REFUNDABLE_FIELD in serverErrors) {
      setServerErrors((prev) => {
        const out = { ...prev };
        delete out[NON_REFUNDABLE_FIELD];
        return out;
      });
    }
  };

  const applyOutcome = (outcome: BookOutcome, startedAt: number) => {
    switch (outcome.kind) {
      case 'confirmed':
        setPhase({ kind: 'confirmed', view: confirmedViewOf(outcome.summary) });
        requestFocus('panel');
        return;
      case 'failed':
        setPhase({
          kind: 'failed',
          view: outcome.view,
          message: outcome.message,
          ...(outcome.summary.orderNumber === undefined
            ? {}
            : { orderNumber: outcome.summary.orderNumber }),
        });
        requestFocus('panel');
        return;
      case 'tracking':
        setPhase(startTracking(outcome, startedAt));
        requestFocus('panel');
        return;
      case 'unknown':
        setPhase({ kind: 'unknown', message: outcome.message });
        requestFocus('panel');
        return;
      case 'fix':
        setPhase({ kind: 'editing' });
        setNotice(outcome);
        setAttempted(true);
        setServerErrors(outcome.fieldErrors);
        if (outcome.nonRefundable) setServerNonRefundable(outcome.nonRefundable);
        requestFocus(Object.keys(outcome.fieldErrors).length > 0 ? 'invalid' : 'notice');
        return;
      default:
        setPhase({ kind: 'editing' });
        setNotice(outcome);
        setRepricedAccepted(false);
        requestFocus('notice');
    }
  };

  const send = async (attempt: Attempt) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    attemptRef.current = attempt;
    const startedAt = Date.now();
    setPhase({ kind: 'submitting', startedAt });
    setNotice(undefined);
    requestFocus('panel');

    let status = 0;
    let body: unknown;
    try {
      const res = await fetch('/api/hotels/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: JSON.stringify(attempt.body),
      });
      status = res.status;
      const read = await readJson<unknown>(res);
      body = read.ok ? read.data : { message: read.message };
    } catch {
      // El navegador no sabe si el pedido llegó antes de perder la red: se clasifica como incierto.
      status = 0;
      body = undefined;
    } finally {
      inFlightRef.current = false;
    }

    const outcome = classifyBookResponse(status, body);
    if (!keepsAttempt(outcome)) attemptRef.current = null;
    applyOutcome(outcome, startedAt);
  };

  const confirm = () => {
    if (inFlightRef.current || !gate.ok) return;
    setAttempted(true);
    if (!check.ok) {
      requestFocus('invalid');
      return;
    }
    if (effective !== current) {
      setCurrent(effective);
      setRepricedAccepted(false);
    }
    void send({
      key: newIdempotencyKey(),
      body: {
        providerCode: prebook.providerCode,
        prebookRef: effective.prebookRef,
        acceptedTotal: {
          amountMinor: effective.total.amountMinor,
          currency: effective.total.currency,
        },
        ...(atHotel.length > 0 && acknowledged ? { atPropertyAcknowledged: true as const } : {}),
        ...(isNonRefundable && nonRefundableAcknowledged
          ? { nonRefundableAcknowledged: true as const }
          : {}),
        rooms: check.rooms,
        contact: check.contact,
      },
    });
  };

  const resend = () => {
    const attempt = attemptRef.current;
    if (attempt === null) {
      setPhase({ kind: 'editing' });
      requestFocus('confirm');
      return;
    }
    void send(attempt);
  };

  const pollOrder = useCallback(
    async (state: TrackingState) => {
      setPhase((cur) =>
        cur.kind === 'tracking' && cur.orderId === state.orderId && cur.tick === state.tick
          ? { ...cur, polling: true }
          : cur,
      );
      const read = await hotelOrderStatusAction(state.orderId).catch(() => POLL_UNREACHABLE);
      const next = afterPoll(state, read);
      setPhase((cur) =>
        cur.kind === 'tracking' && cur.orderId === state.orderId && cur.tick === state.tick
          ? next
          : cur,
      );
      if (next.kind !== 'tracking') requestFocus('panel');
    },
    [requestFocus],
  );

  // La consulta automática de una orden en curso: una a la vez, con el calendario de la espera.
  useEffect(() => {
    if (phase.kind !== 'tracking') return;
    const delay = pollDelayFor(phase, Date.now());
    if (delay === undefined) {
      if (!phase.stopped && !phase.polling) {
        setPhase((cur) => (cur === phase ? { ...phase, stopped: true } : cur));
      }
      return;
    }
    const id = window.setTimeout(() => void pollOrder(phase), delay);
    return () => window.clearTimeout(id);
  }, [phase, pollOrder]);

  const pollNow = () => {
    if (phase.kind !== 'tracking' || phase.polling) return;
    const resumed = resumeTracking(phase, Date.now());
    setPhase(resumed);
    void pollOrder(resumed);
  };

  const live =
    phase.kind === 'submitting'
      ? TRACKING_TEXT.confirming.title
      : phase.kind === 'tracking'
        ? TRACKING_TEXT[phase.trackPhase].title
        : '';

  return (
    <div ref={rootRef} className="space-y-5">
      <p role="status" aria-live="polite" className="sr-only">
        {live}
      </p>
      {phase.kind === 'submitting' ? (
        <ProgressPanel
          title={TRACKING_TEXT.confirming.title}
          detail={TRACKING_TEXT.confirming.detail}
          startedAt={phase.startedAt}
          headingRef={headingRef}
        />
      ) : phase.kind === 'tracking' ? (
        <ProgressPanel
          title={TRACKING_TEXT[phase.trackPhase].title}
          detail={TRACKING_TEXT[phase.trackPhase].detail}
          {...(phase.orderNumber === undefined ? {} : { orderNumber: phase.orderNumber })}
          startedAt={phase.startedAt}
          headingRef={headingRef}
          stopped={phase.stopped}
          polling={phase.polling}
          {...(phase.note ? { note: phase.note } : {})}
          onPollNow={pollNow}
        />
      ) : phase.kind === 'confirmed' ? (
        <ConfirmedPanel view={phase.view} atHotel={atHotel} headingRef={headingRef} />
      ) : phase.kind === 'failed' ? (
        <FailedPanel
          view={phase.view}
          message={phase.message}
          {...(phase.orderNumber === undefined ? {} : { orderNumber: phase.orderNumber })}
          hotelLink={hotelLink}
          headingRef={headingRef}
          onRetry={() => {
            setPhase({ kind: 'editing' });
            requestFocus('confirm');
          }}
        />
      ) : phase.kind === 'cancelled' ? (
        <CancelledPanel
          {...(phase.orderNumber === undefined ? {} : { orderNumber: phase.orderNumber })}
          headingRef={headingRef}
        />
      ) : phase.kind === 'unknown' ? (
        <UnknownPanel message={phase.message} onResend={resend} headingRef={headingRef} />
      ) : row === undefined ? null : (
        <>
          <CheckoutExpiry
            roompack={prebook.roompack}
            expiresAt={prebook.expiresAt}
            clockOffsetMs={clockOffsetMs}
            onExpiredChange={setExpired}
            hotelLink={hotelLink}
          >
            <p>Cargá los huéspedes y confirmá la reserva.</p>
          </CheckoutExpiry>

          {notice ? (
            <BookNoticeView
              notice={notice}
              hotelLink={hotelLink}
              onRevalidate={onRevalidate}
              repricedAccepted={repricedAccepted}
              onRepricedAcceptedChange={setRepricedAccepted}
              noticeRef={noticeRef}
            />
          ) : null}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0">
              <GuestForm
                draft={draft}
                onChange={handleDraftChange}
                errors={errors}
                roomNames={roomNames}
                noNameChange={prebook.signals.includes('NO_NAME_CHANGE')}
              />
            </div>
            {/* Después en el DOM: en el teléfono, el total, los cargos en el hotel y el botón
                quedan al final, una vez cargados los huéspedes; en escritorio, fijos al costado. */}
            <aside
              ref={confirmRef}
              aria-label="Confirmar la reserva"
              className="lg:sticky lg:top-6"
            >
              <BookingConfirm
                row={row}
                total={effective.total}
                nights={nights}
                cancellation={cancellation}
                atHotel={atHotel}
                acknowledged={acknowledged}
                onAcknowledgedChange={handleAcknowledged}
                acknowledgeError={errors[AT_PROPERTY_FIELD]}
                nonRefundable={nonRefundable}
                nonRefundableAcknowledged={nonRefundableAcknowledged}
                onNonRefundableAcknowledgedChange={handleNonRefundableAcknowledged}
                nonRefundableError={errors[NON_REFUNDABLE_FIELD]}
                gate={gate}
                onConfirm={confirm}
                onBack={onBack}
              />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
