'use client';

import { Clock, TimerOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../../../../lib/cn';
import type { HotelRoompack } from '../../actions';
import type { HotelDetailLink } from '../../_components/hotel-search-handoff';
import { formatRemaining, offerExpiryState } from '../../_components/offer-expiry';
import { checkoutExpiryNotice } from './prebook-view';

/*
 * Cuánto le queda a la tarifa revalidada (RF-09): el PreBook no mueve el vencimiento, que sigue
 * contando desde la búsqueda. El mismo reloj que el listado —el del servidor, con el aviso a los
 * 20 minutos—, con los textos de UNA tarifa.
 */

export function CheckoutExpiry({
  roompack,
  expiresAt,
  clockOffsetMs,
  onExpiredChange,
  hotelLink,
  children,
}: {
  roompack: HotelRoompack;
  /** El de la respuesta del PreBook, que manda sobre el de la tarifa. */
  expiresAt: string;
  /** Reloj del servidor menos el del navegador. */
  clockOffsetMs: number;
  onExpiredChange: (expired: boolean) => void;
  hotelLink: HotelDetailLink;
  /** Lo que va a la izquierda del contador. */
  children: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now() + clockOffsetMs);
  useEffect(() => {
    setNow(Date.now() + clockOffsetMs);
  }, [expiresAt, clockOffsetMs]);

  const state = useMemo(
    () => offerExpiryState([{ roompacks: [{ ...roompack, expiresAt }] }], now),
    [roompack, expiresAt, now],
  );
  const counting = state.phase === 'running' || state.phase === 'warning';
  const expired = state.phase === 'expired';
  const notice = checkoutExpiryNotice(state);

  useEffect(() => {
    if (!counting) return;
    const id = window.setInterval(() => setNow(Date.now() + clockOffsetMs), 1000);
    return () => window.clearInterval(id);
  }, [counting, clockOffsetMs]);

  useEffect(() => {
    onExpiredChange(expired);
  }, [expired, onExpiredChange]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-xs text-[var(--color-fg-muted)]">{children}</div>
        {counting ? (
          <p
            role="timer"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums',
              state.phase === 'warning'
                ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
            )}
          >
            <Clock aria-hidden="true" className="size-3.5" />
            Tarifa vigente por {formatRemaining(state.remainingMs)}
          </p>
        ) : null}
      </div>

      {/* Siempre montada: una región viva que aparece ya con texto no la anuncian todos los
          lectores. */}
      <div aria-live="polite" aria-atomic="true">
        {notice ? (
          <div
            className={cn(
              'flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between',
              notice.tone === 'expired'
                ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5'
                : 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
            )}
          >
            <div className="flex items-start gap-2.5">
              {notice.tone === 'expired' ? (
                <TimerOff
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
                />
              ) : (
                <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              <p>
                <strong className="font-semibold">{notice.title}</strong> {notice.detail}
              </p>
            </div>
            {notice.tone === 'expired' ? (
              <Link
                href={hotelLink}
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                Volver al hotel
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
