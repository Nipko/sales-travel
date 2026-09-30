'use client';

import { Check, CircleCheck, Copy, PauseCircle, Search, Ticket } from 'lucide-react';
import { useState } from 'react';
import { Card } from '../../../../components/ui/card';
import { cn } from '../../../../lib/cn';
import type { CarBookResult, CarSelection } from '../actions';
import { CAR_CLASS_LABELS, carClassOf, formatMoney, modelLabel, saleOf } from './car-format';
import { bookingStatusView, holdDeadlineLabel } from './car-checkout-model';
import { CarPhoto } from './car-photo';
import {
  daysLabel,
  placeLabel,
  rentalDays,
  whenLabel,
  type CarSearchCriteria,
} from './car-search-model';

/*
 * La reserva hecha: qué quedó (confirmada, en espera o a confirmar), el código con el que se consulta
 * y se cancela —grande y copiable: es lo que el vendedor le pasa al cliente— y el voucher a un toque.
 */
export function CarBookingDone({
  result,
  criteria,
  selection,
  driverName,
  onViewVoucher,
  onNewSearch,
}: {
  result: CarBookResult;
  criteria: CarSearchCriteria;
  selection: CarSelection;
  driverName: string;
  onViewVoucher: () => void;
  onNewSearch: () => void;
}) {
  const values = criteria.values;
  const paymentType = values.paymentType ?? selection.paymentOption;
  const view = bookingStatusView(result.status, paymentType, holdDeadlineLabel(values));
  const title =
    modelLabel(selection.carModel) ||
    selection.category ||
    CAR_CLASS_LABELS[carClassOf(selection.sippCode)];
  const [copied, setCopied] = useState(false);

  function copy() {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(result.confirmationCode).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  }

  const StatusIcon = view.tone === 'success' ? CircleCheck : PauseCircle;

  return (
    <Card className="mx-auto max-w-2xl overflow-hidden">
      <div
        className={cn(
          'flex flex-col items-center px-6 pb-6 pt-8 text-center',
          view.tone === 'success' ? 'bg-[var(--color-success)]/8' : 'bg-[var(--color-warning)]/10',
        )}
      >
        <span
          className={cn(
            'flex size-12 items-center justify-center rounded-full',
            view.tone === 'success'
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-warning)]/25 text-[var(--color-fg)]',
          )}
        >
          <StatusIcon aria-hidden="true" className="size-6" />
        </span>
        <h2 className="mt-3 text-lg font-semibold tracking-tight text-[var(--color-fg)]">
          {view.title}
        </h2>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Código de confirmación</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-2xl font-bold tracking-wider text-[var(--color-fg)]">
            {result.confirmationCode}
          </span>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? 'Código copiado' : 'Copiar el código de confirmación'}
            className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-4 text-[var(--color-success)]" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
        <p className="mx-auto mt-3 max-w-md text-sm text-[var(--color-fg)]">{view.note}</p>
      </div>

      <div className="flex flex-col gap-4 border-t border-[var(--color-border)] p-5 sm:flex-row">
        <CarPhoto
          src={selection.imageUrl}
          className="h-24 w-full shrink-0 rounded-md border border-[var(--color-border)] sm:w-36"
        />
        <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="sr-only">Auto</dt>
            <dd className="text-sm font-semibold text-[var(--color-fg)]">{title}</dd>
            <dd className="text-[var(--color-fg-muted)]">
              {selection.companyName} · {result.sippCode || selection.sippCode}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-subtle)]">Recogida</dt>
            <dd className="text-[var(--color-fg)]">{placeLabel(criteria.pickup)}</dd>
            <dd className="text-[var(--color-fg-muted)]">
              {whenLabel(values.pickUpDate, values.pickUpHour)}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-subtle)]">Devolución</dt>
            <dd className="text-[var(--color-fg)]">
              {placeLabel(criteria.dropoff ?? criteria.pickup)}
            </dd>
            <dd className="text-[var(--color-fg-muted)]">
              {whenLabel(values.dropOffDate, values.dropOffHour)}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-subtle)]">Conductor</dt>
            <dd className="text-[var(--color-fg)]">{driverName}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-subtle)]">
              Total de venta · {daysLabel(rentalDays(values))}
            </dt>
            <dd className="font-semibold tabular-nums text-[var(--color-fg)]">
              {formatMoney(saleOf(selection))}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-5 py-4 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onNewSearch}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          <Search aria-hidden="true" className="size-4" />
          Nueva búsqueda
        </button>
        <button
          type="button"
          onClick={onViewVoucher}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 focus-visible:ring-offset-2"
        >
          <Ticket aria-hidden="true" className="size-4" />
          Ver voucher
        </button>
      </div>
    </Card>
  );
}
