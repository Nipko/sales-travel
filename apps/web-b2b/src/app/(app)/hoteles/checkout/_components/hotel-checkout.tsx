'use client';

import { ArrowLeft, BedDouble, Check, Loader2, MapPin, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Card } from '../../../../../components/ui/card';
import { cn } from '../../../../../lib/cn';
import { formatMoney } from '../../_components/hotel-format';
import { hotelRateRows, saleTotal } from '../../_components/hotel-rate-view';
import {
  hotelLinkOf,
  readRateSelection,
  type RateSelection,
} from '../../_components/hotel-rate-selection';
import { countryNamer } from '../../_components/nationality-field';
import { stayNights, staySummary } from '../../[hotelKey]/_components/hotel-detail-view';
import { prebookRateAction, type PrebookActionResult } from '../actions';
import { SECONDARY_ACTION } from './action-styles';
import { BookingStep } from './booking-step';
import { CancelPolicy } from './cancel-policy';
import { CheckoutExpiry } from './checkout-expiry';
import { draftFitsRooms, emptyGuestDraft, type GuestDraft } from './guest-form-view';
import { PriceChangeNotice } from './price-change-notice';
import { PrebookSummary, PrebookTotal } from './prebook-summary';
import {
  acceptedPrebookOf,
  continueGate,
  priceChangeView,
  signalsView,
  type AcceptedPrebook,
} from './prebook-view';
import { RateConditions, RateSignalsNotice } from './rate-conditions';

/*
 * El checkout de una tarifa de hotel. Paso 1 (U-09 a U-11): al abrirlo se revalida la tarifa con
 * el proveedor (PreBook) y se muestra lo que queda firme para la reserva —precio de venta, el
 * aviso si cambió, la política de cancelación y las condiciones del hotel—; si subió o cambiaron
 * las condiciones, el vendedor lo acepta antes de seguir (D-TBO-20 A). Una tarifa "sólo con
 * aéreo" no sigue (D-TBO-22 A). El paso 2 (U-12 a U-14), huéspedes y reserva, recibe la tarifa
 * aceptada; los huéspedes cargados se conservan si el vendedor vuelve al paso 1 o hay que
 * revalidar la tarifa, porque es la misma estadía.
 */

type PrebookState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly result: PrebookActionResult };

const UNREACHABLE: PrebookActionResult = {
  ok: false,
  error: 'No pudimos conectar para revalidar la tarifa. Revisá tu conexión e intentá de nuevo.',
  retryable: true,
};

export function HotelCheckout({ rateToken }: { rateToken: string | undefined }) {
  // `undefined` mientras no se leyó el almacenamiento; `null` si no hay tarifa elegida.
  const [selection, setSelection] = useState<RateSelection | null | undefined>(undefined);
  const [state, setState] = useState<PrebookState>({ kind: 'loading' });
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [confirmed, setConfirmed] = useState<AcceptedPrebook | undefined>(undefined);
  const [guestDraft, setGuestDraft] = useState<GuestDraft | undefined>(undefined);
  const requestRef = useRef(0);
  const startedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moveFocusRef = useRef(false);

  const runPrebook = useCallback((from: RateSelection) => {
    const request = ++requestRef.current;
    setState({ kind: 'loading' });
    setAccepted(false);
    setExpired(false);
    prebookRateAction(from.reference)
      .catch(() => UNREACHABLE)
      .then((result) => {
        // Una respuesta que llega después de un reintento ya no es la que se está mirando.
        if (request !== requestRef.current) return;
        if (result.ok) setClockOffsetMs(result.receivedAt - Date.now());
        setState({ kind: 'done', result });
      });
  }, []);

  // Una sola revalidación al abrir: en desarrollo React monta dos veces, y cada PreBook es una
  // consulta al proveedor.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const found = rateToken === undefined ? undefined : readRateSelection(rateToken);
    setSelection(found ?? null);
    if (found !== undefined) runPrebook(found);
  }, [rateToken, runPrebook]);

  // Al cambiar de paso el contenido se reemplaza entero: el foco va al título, que es desde donde
  // el teclado y el lector siguen, y no queda perdido en un botón que ya no existe.
  useEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    headingRef.current?.focus();
  }, [confirmed]);
  const goToStep = (next: AcceptedPrebook | undefined) => {
    moveFocusRef.current = true;
    if (next !== undefined) {
      const { rooms, guestNationality } = next.selection.stay;
      setGuestDraft((draft) =>
        draft !== undefined && draftFitsRooms(draft, rooms)
          ? draft
          : emptyGuestDraft(rooms, guestNationality),
      );
    }
    setConfirmed(next);
  };

  const hotelName = selection?.hotel.name;
  useEffect(() => {
    if (!hotelName) return;
    const previous = document.title;
    document.title = `Reservar ${hotelName} · Hoteles`;
    return () => {
      document.title = previous;
    };
  }, [hotelName]);

  if (selection === undefined) {
    return (
      <CheckoutFrame>
        <CheckoutSteps current={1} />
        <LoadingPrebook />
      </CheckoutFrame>
    );
  }
  if (selection === null) {
    return (
      <CheckoutFrame>
        <MissingSelection />
      </CheckoutFrame>
    );
  }

  const hotelLink = hotelLinkOf(selection);
  const announcement =
    confirmed !== undefined
      ? ''
      : state.kind === 'loading'
        ? 'Revalidando la tarifa con el proveedor.'
        : state.result.ok
          ? `Tarifa revalidada. Total ${formatMoney(saleTotal(state.result.prebook.roompack))}.`
          : '';
  return (
    <CheckoutFrame
      back={
        <Link
          href={hotelLink}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Volver al hotel
        </Link>
      }
    >
      <CheckoutHeader selection={selection} step={confirmed ? 2 : 1} headingRef={headingRef} />
      {/* Siempre montada: una región viva que aparece ya con texto no la anuncian todos los
          lectores. El error se anuncia solo, como alerta. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {confirmed ? (
        <BookingStep
          accepted={confirmed}
          draft={
            guestDraft ?? emptyGuestDraft(selection.stay.rooms, selection.stay.guestNationality)
          }
          onDraftChange={setGuestDraft}
          onBack={() => goToStep(undefined)}
          onRevalidate={() => {
            goToStep(undefined);
            runPrebook(selection);
          }}
        />
      ) : state.kind === 'loading' ? (
        <LoadingPrebook />
      ) : state.result.ok ? (
        <PrebookReady
          selection={selection}
          result={state.result}
          clockOffsetMs={clockOffsetMs}
          accepted={accepted}
          onAcceptedChange={setAccepted}
          expired={expired}
          onExpiredChange={setExpired}
          onContinue={goToStep}
        />
      ) : (
        <PrebookError
          message={state.result.error}
          retryable={state.result.retryable}
          onRetry={() => {
            // El botón desaparece con el reintento: el foco no puede quedar en un elemento que ya
            // no existe.
            headingRef.current?.focus();
            runPrebook(selection);
          }}
          hotelLink={hotelLink}
        />
      )}
    </CheckoutFrame>
  );
}

function CheckoutFrame({ back, children }: { back?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      {back ? <nav aria-label="Ruta">{back}</nav> : null}
      {children}
    </div>
  );
}

/** Los dos pasos de la reserva: dónde está el vendedor y qué le falta. */
function CheckoutSteps({ current }: { current: 1 | 2 }) {
  const steps = ['Tarifa y condiciones', 'Huéspedes y confirmación'] as const;
  return (
    <ol aria-label="Pasos de la reserva" className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {steps.map((label, i) => {
        const number = i + 1;
        const active = number === current;
        const done = number < current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 text-[11px] font-medium',
              active || done ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
            )}
          >
            {i > 0 ? (
              <span aria-hidden="true" className="h-px w-5 bg-[var(--color-border-strong)]" />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                'grid size-5 place-items-center rounded-full text-[10px] tabular-nums',
                active
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : done
                    ? 'bg-[var(--color-primary)]/15 text-[var(--color-fg)]'
                    : 'border border-[var(--color-border-strong)] text-[var(--color-fg-muted)]',
              )}
            >
              {done ? <Check className="size-3" /> : number}
            </span>
            <span className="sr-only">
              Paso {number} de 2{done ? ', completo' : ''}:{' '}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** El hotel y la estadía con que se reserva, a la vista: la nacionalidad cambia el precio. */
function CheckoutHeader({
  selection,
  step,
  headingRef,
}: {
  selection: RateSelection;
  step: 1 | 2;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const summary = useMemo(() => staySummary(selection.stay, countryNamer('es')), [selection]);
  return (
    <header className="space-y-2">
      <CheckoutSteps current={step} />
      <div className="space-y-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="rounded text-lg font-semibold tracking-tight text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          {selection.hotel.name ?? 'Reserva de hotel'}
        </h1>
        {selection.hotel.address ? (
          <p className="flex items-start gap-1 text-xs text-[var(--color-fg-muted)]">
            <MapPin aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            {selection.hotel.address}
          </p>
        ) : null}
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          <span className="font-medium text-[var(--color-fg)]">{summary.dates}</span> ·{' '}
          {summary.details} · Nacionalidad: {summary.nationality}
        </p>
      </div>
    </header>
  );
}

function PrebookReady({
  selection,
  result,
  clockOffsetMs,
  accepted,
  onAcceptedChange,
  expired,
  onExpiredChange,
  onContinue,
}: {
  selection: RateSelection;
  result: Extract<PrebookActionResult, { ok: true }>;
  clockOffsetMs: number;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  expired: boolean;
  onExpiredChange: (expired: boolean) => void;
  onContinue: (accepted: AcceptedPrebook) => void;
}) {
  const { prebook } = result;
  const row = useMemo(
    () => hotelRateRows({ roompacks: [prebook.roompack] }, selection.showProviderInResults)[0],
    [prebook, selection.showProviderInResults],
  );
  const change = useMemo(
    () => priceChangeView(prebook, selection.shownSale),
    [prebook, selection.shownSale],
  );
  const signals = useMemo(() => signalsView(prebook.signals), [prebook.signals]);
  const gate = continueGate({ expired, blocked: signals.blocking, change, accepted });
  const hotelLink = hotelLinkOf(selection);
  const nights = stayNights(selection.stay);

  if (row === undefined) return null;
  return (
    <div className="space-y-5">
      <CheckoutExpiry
        roompack={prebook.roompack}
        expiresAt={prebook.expiresAt}
        clockOffsetMs={clockOffsetMs}
        onExpiredChange={onExpiredChange}
        hotelLink={hotelLink}
      >
        <p>Revisá la tarifa antes de cargar los huéspedes.</p>
      </CheckoutExpiry>

      {change ? (
        <PriceChangeNotice
          change={change}
          accepted={accepted}
          onAcceptedChange={onAcceptedChange}
        />
      ) : null}
      <RateSignalsNotice view={signals} hotelLink={hotelLink} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <PrebookSummary row={row} expired={expired} />
          <CancelPolicy pack={prebook.roompack} />
          <RateConditions conditions={prebook.rateConditions} />
        </div>
        {/* Después en el DOM: en el teléfono, el total y el paso siguiente quedan al final, una
            vez leídas la política y las condiciones; en escritorio, fijos al costado. */}
        <aside aria-label="Total y paso siguiente" className="lg:sticky lg:top-6">
          <PrebookTotal
            row={row}
            nights={nights}
            gate={gate}
            onContinue={() => {
              if (gate.ok) onContinue(acceptedPrebookOf(prebook, selection, clockOffsetMs));
            }}
          />
        </aside>
      </div>
    </div>
  );
}

function LoadingPrebook() {
  return (
    <Card aria-busy="true" className="overflow-hidden">
      <div className="flex items-start gap-2.5 px-4 py-4">
        <Loader2
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--color-fg-muted)]"
        />
        <div>
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Revalidando la tarifa con el proveedor…
          </p>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Confirmamos precio, disponibilidad y condiciones finales. Puede tardar unos segundos.
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="space-y-2 border-t border-[var(--color-border)] px-4 py-3">
        <div className="h-5 w-28 animate-pulse rounded-full bg-[var(--color-surface-muted)]" />
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-surface-muted)]" />
      </div>
    </Card>
  );
}

function PrebookError({
  message,
  retryable,
  onRetry,
  hotelLink,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
  hotelLink: ReturnType<typeof hotelLinkOf>;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="font-semibold">No pudimos revalidar la tarifa.</p>
        <p className="mt-0.5">{message}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {retryable ? (
          <button type="button" onClick={onRetry} className={SECONDARY_ACTION}>
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Reintentar
          </button>
        ) : null}
        <Link href={hotelLink} className={SECONDARY_ACTION}>
          Volver al hotel
        </Link>
      </div>
    </div>
  );
}

/** Sin tarifa elegida en este navegador: se elige desde el detalle de un hotel. */
function MissingSelection() {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
      <BedDouble aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
      <h1 className="text-sm font-medium text-[var(--color-fg)]">
        No encontramos la tarifa elegida.
      </h1>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
        Elegí la tarifa desde el detalle del hotel. La elección se recuerda en este navegador
        durante una hora.
      </p>
      <Link
        href="/hoteles"
        className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-4 text-xs font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
      >
        <Search aria-hidden="true" className="size-3.5" />
        Buscar hoteles
      </Link>
    </div>
  );
}
