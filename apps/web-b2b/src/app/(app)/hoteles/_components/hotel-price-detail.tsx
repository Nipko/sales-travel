'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { formatMoney } from './hotel-format';
import type { HotelPriceDetail } from './hotel-rate-view';

/**
 * «Detalles del precio» de una tarifa de hotel: alojamiento, cada impuesto que informa el
 * proveedor y el total. Lo que se paga en el hotel va aparte (`AtHotelCharges`): no está en el
 * total y puede ir en otra moneda.
 */
export function HotelPriceDetailView({
  detail,
  defaultOpen = false,
}: {
  readonly detail: HotelPriceDetail;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const noches =
    detail.nights === undefined
      ? ''
      : ` (${String(detail.nights)} ${detail.nights === 1 ? 'noche' : 'noches'})`;

  return (
    <div className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-1 font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn('size-3 transition-transform', open && 'rotate-180')}
        />
        Detalles del precio
      </button>
      <div id={panelId} hidden={!open}>
        {open ? (
          <dl className="mt-1.5 space-y-1 rounded-lg bg-[var(--color-surface-muted)]/60 px-2.5 py-2">
            <Line label={`Alojamiento${noches}`} value={formatMoney(detail.lodging)} strong />
            {detail.taxes ? (
              <Line label="Impuestos y tasas" value={formatMoney(detail.taxes)} strong />
            ) : null}
            {detail.taxLines.map((line, index) => (
              <Line
                key={`${line.label}-${index}`}
                label={line.label}
                value={formatMoney(line.amount)}
                dotted
              />
            ))}
            {detail.taxes && detail.taxLines.length === 0 ? (
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                El proveedor no informa el detalle de cada impuesto.
              </p>
            ) : null}
            {!detail.taxes ? (
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                Impuestos incluidos en el total; el proveedor no los informa por separado.
              </p>
            ) : null}
            <Line label="Total" value={formatMoney(detail.total)} strong />
            {detail.perNight ? (
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                {formatMoney(detail.perNight)} por noche, en promedio.
              </p>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function Line({
  label,
  value,
  strong = false,
  dotted = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
  readonly dotted?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt
        className={cn(
          'min-w-0',
          strong ? 'font-semibold text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
        )}
      >
        {label}
      </dt>
      <span
        aria-hidden="true"
        className={cn(
          'min-w-4 flex-1',
          dotted && 'border-b border-dotted border-[var(--color-border-strong)]',
        )}
      />
      <dd
        className={cn(
          'shrink-0 tabular-nums',
          strong ? 'font-semibold text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
