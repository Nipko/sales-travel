'use client';

import {
  Ban,
  CircleCheck,
  CircleHelp,
  Loader2,
  Receipt,
  RefreshCw,
  Search,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Card } from '../../../../../components/ui/card';
import { cn } from '../../../../../lib/cn';
import { formatMoney } from '../../_components/hotel-format';
import type { HotelDetailLink } from '../../_components/hotel-search-handoff';
import type { AtHotelCharge } from '../../_components/hotel-rate-view';
import { formatRemaining } from '../../_components/offer-expiry';
import { PRIMARY_ACTION, SECONDARY_ACTION } from './action-styles';
import {
  repricedChangeView,
  type BookOutcome,
  type ConfirmedView,
  type FailedView,
} from './booking-view';
import { PriceChangeNotice } from './price-change-notice';

/*
 * Lo que se ve de la reserva una vez tocado "Confirmar" (U-13, U-14, U-18, U-19): la espera con
 * "confirmando" o "verificando con el proveedor", cada desenlace con lo que el vendedor puede
 * hacer, y los avisos que vuelven al formulario.
 */

const RESERVAS = '/reservas';

type Heading = RefObject<HTMLHeadingElement | null>;

function PanelHeading({ headingRef, children }: { headingRef: Heading; children: ReactNode }) {
  return (
    <h2
      ref={headingRef}
      tabIndex={-1}
      className="rounded text-sm font-semibold tracking-tight text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    >
      {children}
    </h2>
  );
}

/** Minutos y segundos desde que se tocó "Confirmar": la espera se ve avanzar. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="tabular-nums">
      <span className="sr-only">Tiempo transcurrido: </span>
      {formatRemaining(Math.max(0, now - since))}
    </span>
  );
}

// ───────────────────────── Espera ─────────────────────────

export function ProgressPanel({
  title,
  detail,
  orderNumber,
  startedAt,
  headingRef,
  stopped,
  note,
  onPollNow,
  polling,
}: {
  title: string;
  detail: string;
  orderNumber?: number;
  startedAt: number;
  headingRef: Heading;
  /** Terminó la consulta automática: el vendedor consulta a pedido. */
  stopped?: boolean;
  /** Algo que decir además del estado: la consulta falló, el envío ya había llegado. */
  note?: string;
  onPollNow?: () => void;
  polling?: boolean;
}) {
  return (
    <Card aria-busy={stopped ? undefined : 'true'} className="overflow-hidden">
      <div className="flex items-start gap-2.5 px-4 py-4">
        {stopped ? (
          <CircleHelp
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]"
          />
        ) : (
          <Loader2
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--color-fg-muted)]"
          />
        )}
        <div className="min-w-0 space-y-1">
          <PanelHeading headingRef={headingRef}>{title}</PanelHeading>
          <p className="text-xs text-[var(--color-fg-muted)]">{detail}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--color-border)] px-4 py-2.5 text-[11px] text-[var(--color-fg-muted)]">
        <span>
          {orderNumber === undefined ? (
            'Reserva en curso'
          ) : (
            <>
              Reserva <span className="font-medium tabular-nums">N.º {orderNumber}</span>
            </>
          )}
        </span>
        <Elapsed since={startedAt} />
      </div>
      {note ? (
        <p className="border-t border-[var(--color-border)] px-4 py-2.5 text-[11px] text-[var(--color-fg)]">
          {note}
        </p>
      ) : null}
      {stopped ? (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-[var(--color-fg)]">
            La verificación sigue del lado del proveedor. Consultala cuando quieras; no la repitas.
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={onPollNow}
              disabled={polling}
              className={SECONDARY_ACTION}
            >
              <RefreshCw aria-hidden="true" className={cn('size-3.5', polling && 'animate-spin')} />
              Consultar ahora
            </button>
            <Link href={RESERVAS} className={SECONDARY_ACTION}>
              Ir a Mis Reservas
            </Link>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ───────────────────────── Confirmada ─────────────────────────

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="break-words text-sm font-medium tabular-nums text-[var(--color-fg)]">
        {children}
      </dd>
    </div>
  );
}

export function ConfirmedPanel({
  view,
  atHotel,
  headingRef,
}: {
  view: ConfirmedView;
  atHotel: readonly AtHotelCharge[];
  headingRef: Heading;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-success)]/10 px-4 py-3">
        <CircleCheck
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
        />
        <div className="min-w-0">
          <PanelHeading headingRef={headingRef}>Reserva confirmada</PanelHeading>
          <p className="text-[11px] text-[var(--color-fg-muted)]">
            El proveedor confirmó la reserva. La encontrás en Mis Reservas.
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2">
        {view.orderNumber === undefined ? null : (
          <Detail label="Reserva">N.º {view.orderNumber}</Detail>
        )}
        {view.providerBookingId ? (
          <Detail label="Localizador del proveedor">{view.providerBookingId}</Detail>
        ) : null}
        {view.bookingReference ? (
          <Detail label="Referencia de la reserva">{view.bookingReference}</Detail>
        ) : null}
        {view.total ? <Detail label="Total">{formatMoney(view.total)}</Detail> : null}
      </dl>
      <div className="space-y-2 px-4 pb-4 text-xs text-[var(--color-fg-muted)]">
        {view.priceNote ? <p className="text-[var(--color-fg)]">{view.priceNote}</p> : null}
        {view.note ? <p className="text-[var(--color-fg)]">{view.note}</p> : null}
        {atHotel.length > 0 ? (
          <div className="rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-fg)]">
            <p className="flex items-center gap-1 font-medium">
              <Receipt aria-hidden="true" className="size-3 shrink-0" />
              Recordale al huésped lo que paga en el hotel
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {atHotel.map((c, i) => (
                <li key={i}>
                  {c.description}
                  {c.room === undefined ? '' : ` (habitación ${c.room})`}:{' '}
                  <span className="font-medium tabular-nums">{c.amount}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p>El número de confirmación del hotel llega más tarde: lo vas a ver en Mis Reservas.</p>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] px-4 py-3">
        <Link href={RESERVAS} className={PRIMARY_ACTION}>
          Ver en Mis Reservas
        </Link>
        <Link href="/hoteles" className={SECONDARY_ACTION}>
          <Search aria-hidden="true" className="size-3.5" />
          Buscar otro hotel
        </Link>
      </div>
    </Card>
  );
}

// ───────────────────────── Sin reserva ─────────────────────────

export function FailedPanel({
  view,
  message,
  orderNumber,
  hotelLink,
  onRetry,
  headingRef,
}: {
  view: FailedView;
  message: string;
  orderNumber?: number;
  hotelLink: HotelDetailLink;
  onRetry: () => void;
  headingRef: Heading;
}) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <div className="flex items-start gap-2.5">
        <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 space-y-1">
          <PanelHeading headingRef={headingRef}>{view.title}</PanelHeading>
          <p>{message}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">
            No se hizo ninguna reserva
            {orderNumber === undefined
              ? ''
              : `; el intento quedó registrado como N.º ${orderNumber}`}
            .
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:pl-6.5">
        {view.next === 'retry' ? (
          <button type="button" onClick={onRetry} className={SECONDARY_ACTION}>
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Intentar de nuevo
          </button>
        ) : null}
        {view.next === 'research' ? (
          <Link href={hotelLink} className={SECONDARY_ACTION}>
            Volver al hotel
          </Link>
        ) : null}
        <Link href={RESERVAS} className={SECONDARY_ACTION}>
          Ir a Mis Reservas
        </Link>
      </div>
    </div>
  );
}

export function CancelledPanel({
  orderNumber,
  headingRef,
}: {
  orderNumber?: number;
  headingRef: Heading;
}) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <PanelHeading headingRef={headingRef}>La reserva figura cancelada.</PanelHeading>
          <p>
            No era lo que esperábamos después de confirmarla, así que ya quedó para revisarla.
            {orderNumber === undefined ? '' : ` Es la reserva N.º ${orderNumber}.`} No la repitas
            sin mirarla antes en Mis Reservas.
          </p>
        </div>
      </div>
      <div className="sm:pl-6.5">
        <Link href={RESERVAS} className={SECONDARY_ACTION}>
          Ir a Mis Reservas
        </Link>
      </div>
    </div>
  );
}

/** No se sabe si se reservó: se consulta con la MISMA clave o en Mis Reservas; nunca otra vez. */
export function UnknownPanel({
  message,
  onResend,
  headingRef,
}: {
  message: string;
  onResend: () => void;
  headingRef: Heading;
}) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <div className="flex items-start gap-2.5">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <PanelHeading headingRef={headingRef}>No sabemos si la reserva se hizo.</PanelHeading>
          <p>{message}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:pl-6.5">
        <button type="button" onClick={onResend} className={SECONDARY_ACTION}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Reintentar sin duplicar
        </button>
        <Link href={RESERVAS} className={SECONDARY_ACTION}>
          Ir a Mis Reservas
        </Link>
      </div>
    </div>
  );
}

// ───────────────────────── Avisos sobre el formulario ─────────────────────────

export type BookNotice = Extract<
  BookOutcome,
  { kind: 'fix' | 'repriced' | 'revalidate' | 'research' | 'rejected' }
>;

export function BookNoticeView({
  notice,
  hotelLink,
  onRevalidate,
  repricedAccepted,
  onRepricedAcceptedChange,
  noticeRef,
}: {
  notice: BookNotice;
  hotelLink: HotelDetailLink;
  onRevalidate: () => void;
  repricedAccepted: boolean;
  onRepricedAcceptedChange: (accepted: boolean) => void;
  noticeRef: RefObject<HTMLDivElement | null>;
}) {
  if (notice.kind === 'repriced') {
    return (
      <div ref={noticeRef} tabIndex={-1} className="rounded-lg focus-visible:outline-none">
        <PriceChangeNotice
          change={repricedChangeView(notice)}
          accepted={repricedAccepted}
          onAcceptedChange={onRepricedAcceptedChange}
        />
      </div>
    );
  }

  const danger = notice.kind === 'rejected' && !notice.retry;
  const title =
    notice.kind === 'fix'
      ? 'No se hizo la reserva: faltan datos o hay que corregir alguno.'
      : notice.title;
  return (
    <div
      ref={noticeRef}
      tabIndex={-1}
      role="alert"
      className={cn(
        'flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm text-[var(--color-fg)] focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between',
        danger || notice.kind === 'research'
          ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5'
          : 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
      )}
    >
      <div className="flex items-start gap-2.5">
        {danger || notice.kind === 'research' ? (
          <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
        ) : (
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        )}
        <p>
          <strong className="font-semibold">{title}</strong> {notice.message}
        </p>
      </div>
      {notice.kind === 'revalidate' ? (
        <button type="button" onClick={onRevalidate} className={SECONDARY_ACTION}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Revalidar la tarifa
        </button>
      ) : notice.kind === 'research' ? (
        <Link href={hotelLink} className={SECONDARY_ACTION}>
          Volver al hotel
        </Link>
      ) : notice.kind === 'rejected' && notice.action === 'portfolios' ? (
        <Link href="/carteras" className={SECONDARY_ACTION}>
          <Wallet aria-hidden="true" className="size-3.5" />
          Ir a Carteras
        </Link>
      ) : notice.kind === 'rejected' && notice.action === 'agency' ? (
        <Link href="/configuracion" className={SECONDARY_ACTION}>
          Ir a Mi Agencia
        </Link>
      ) : null}
    </div>
  );
}
