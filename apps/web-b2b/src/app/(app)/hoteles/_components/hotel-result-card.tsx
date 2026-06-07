'use client';

import { BedDouble, ChevronDown, MapPin, ShieldCheck, ShieldX, Star, Wallet } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../../../lib/cn';
import type { HotelOffer, HotelRoompack } from '../actions';
import { boardLabel, cancellationLabel, formatMoney } from './hotel-format';

function cheapest(roompacks: HotelRoompack[]): HotelRoompack | undefined {
  if (roompacks.length === 0) return undefined;
  return roompacks.reduce((min, rp) =>
    rp.price.total.amountMinor < min.price.total.amountMinor ? rp : min,
  );
}

export function HotelResultCard({ offer }: { offer: HotelOffer }) {
  const [open, setOpen] = useState(false);
  const best = cheapest(offer.roompacks);
  const anyRefundable = offer.roompacks.some((rp) => rp.cancellation.refundable);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-shadow hover:shadow-[var(--shadow-sm)]">
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--color-fg)]">
              {offer.name ?? `Hotel ${offer.hotelId}`}
            </h3>
            {offer.stars ? (
              <span className="flex items-center gap-0.5 text-[var(--color-accent)]">
                {Array.from({ length: Math.min(5, Math.round(offer.stars)) }, (_, i) => (
                  <Star key={i} className="size-3 fill-current" />
                ))}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
            <span className="font-mono">ID {offer.hotelId}</span>
            {offer.location ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3" />
                {offer.location.lat.toFixed(3)}, {offer.location.lng.toFixed(3)}
              </span>
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium',
                anyRefundable
                  ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
                  : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
              )}
            >
              {anyRefundable ? <ShieldCheck className="size-3" /> : <ShieldX className="size-3" />}
              {anyRefundable ? 'Reembolsable disp.' : 'No reembolsable'}
            </span>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">desde</p>
          <p className="text-base font-bold text-[var(--color-fg)]">
            {formatMoney(best?.price.total)}
          </p>
          {best ? (
            <p className="text-[11px] text-[var(--color-fg-muted)]">{boardLabel(best.board)}</p>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-1.5 border-t border-[var(--color-border)] py-2 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-surface-muted)]"
      >
        {open
          ? 'Ocultar'
          : `Ver ${offer.roompacks.length} tarifa${offer.roompacks.length === 1 ? '' : 's'}`}
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {offer.roompacks.map((rp) => (
            <li key={rp.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <BedDouble className="size-3.5 text-[var(--color-fg-subtle)]" />
                  <span className="rounded bg-[var(--color-primary)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">
                    {boardLabel(rp.board)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-[var(--color-fg)]">
                  {rp.rooms
                    .map((r) => r.name)
                    .filter(Boolean)
                    .join(' + ') || 'Habitación'}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">
                  {cancellationLabel(rp.cancellation.status)}
                </p>
                {rp.price.agencyCommission ? (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[var(--color-success)]">
                    <Wallet className="size-3" />
                    Comisión {formatMoney(rp.price.agencyCommission.amount)}
                    {rp.price.agencyCommission.percentage
                      ? ` (${rp.price.agencyCommission.percentage}%)`
                      : ''}
                  </p>
                ) : null}
                {rp.price.chargeAtDestination ? (
                  <p className="text-[11px] text-[var(--color-warning)]">
                    A pagar en destino: {formatMoney(rp.price.chargeAtDestination)}
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-bold text-[var(--color-fg)]">
                  {formatMoney(rp.price.total)}
                </p>
                <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">
                  {rp.rooms[0]?.choiceId ? 'Reservable' : 'Tarifa'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
