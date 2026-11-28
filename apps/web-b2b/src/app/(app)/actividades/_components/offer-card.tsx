'use client';

import { CalendarClock, PackagePlus, ShieldCheck, ShieldX, Ticket } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import {
  cancellationSummary,
  formatDate,
  formatMoney,
  participantsLabel,
  saleOf,
  tierLabel,
  type ActivityOffer,
} from './activity-model';

/** La tarifa de una fecha: precio de venta, cancelación por tramos, validez y acciones. */
export function OfferCard({
  offer,
  onBook,
  onAddToPackage,
}: {
  offer: ActivityOffer;
  onBook: () => void;
  onAddToPackage: () => void;
}) {
  const sale = saleOf(offer);
  const time = offer.startAt && /T(\d{2}:\d{2})/.exec(offer.startAt)?.[1];
  return (
    <section
      aria-labelledby="activity-offer-title"
      className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="activity-offer-title" className="text-sm font-semibold text-[var(--color-fg)]">
            {offer.modalityName ?? offer.name}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
            {formatDate(offer.date)}
            {time ? ` · ${time}` : ''} · {participantsLabel(offer.participants)}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-xl font-semibold tabular-nums text-[var(--color-fg)]">
            {formatMoney(sale)}
          </p>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Total para el grupo
            {offer.pricing
              ? ` · tu margen ${formatMoney({ amountMinor: offer.pricing.ownMarkupMinor, currency: sale.currency })}`
              : ''}
          </p>
        </div>
      </header>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex gap-2.5">
          {offer.cancellation.refundable ? (
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
            />
          ) : (
            <ShieldX
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
            />
          )}
          <div>
            <dt className="font-medium text-[var(--color-fg)]">
              {cancellationSummary(offer.cancellation)}
            </dt>
            {offer.cancellation.tiers.length > 0 ? (
              <dd>
                <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-fg-muted)]">
                  {offer.cancellation.tiers.map((t) => (
                    <li key={`${t.from}-${t.percentage}`}>{tierLabel(t)}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                  Se cancela la reserva completa: no se puede quitar a un participante.
                </p>
              </dd>
            ) : null}
          </div>
        </div>
        {offer.ticketValidity ? (
          <div className="flex gap-2.5">
            <CalendarClock
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]"
            />
            <div>
              <dt className="font-medium text-[var(--color-fg)]">Validez</dt>
              <dd className="text-xs text-[var(--color-fg-muted)]">
                {offer.ticketValidity.useDate
                  ? `Uso el ${formatDate(offer.ticketValidity.useDate)}`
                  : 'Fecha abierta'}
                {offer.ticketValidity.expirationDate
                  ? ` · vence el ${formatDate(offer.ticketValidity.expirationDate)}`
                  : ''}
              </dd>
            </div>
          </div>
        ) : null}
      </dl>

      {offer.cancellation.conditions.length > 0 || offer.highlights.length > 0 ? (
        <ul className="list-inside list-disc space-y-0.5 text-xs text-[var(--color-fg-muted)]">
          {[...offer.highlights, ...offer.cancellation.conditions].map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onAddToPackage}>
          <PackagePlus aria-hidden="true" />
          Agregar a un paquete
        </Button>
        <Button type="button" onClick={onBook}>
          <Ticket aria-hidden="true" />
          Reservar
        </Button>
      </div>
    </section>
  );
}
