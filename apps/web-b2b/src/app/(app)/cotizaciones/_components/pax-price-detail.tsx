'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { isCarrierCharge, taxLineLabel, type PaxSale } from '../../../../lib/sale-breakdown';

const PAX_NAMES: Readonly<Record<PaxSale['paxType'], readonly [string, string]>> = {
  ADT: ['Adulto', 'Adultos'],
  CHD: ['Niño', 'Niños'],
  INF: ['Infante', 'Infantes'],
};

interface PaxPriceDetailProps {
  readonly sales: readonly PaxSale[];
  readonly currency: string;
  readonly formatMoney: (amountMinor: number, currency: string) => string;
  /** Compacto para la tarjeta de tarifa; normal para la cotización y la reserva. */
  readonly size?: 'compact' | 'regular';
}

/**
 * «Detalles del precio» por pasajero, como en los sitios de venta: cada tipo con lo que paga cada
 * uno, y al abrirlo la tarifa base y cada impuesto con su código (Airport tax (CO), IVA (YS)…).
 *
 * Los impuestos van TAL CUAL los cobra la aerolínea; el markup de la red queda en la tarifa base,
 * la misma regla que el resto de la pantalla (`lib/sale-breakdown.ts`). Los cargos `YQ`/`YR` se
 * separan: son de la aerolínea (combustible, misceláneos), no de un gobierno, y el cliente lo
 * pregunta.
 */
export function PaxPriceDetail({
  sales,
  currency,
  formatMoney,
  size = 'regular',
}: PaxPriceDetailProps) {
  if (sales.length === 0) return null;
  return (
    <ul
      aria-label="Precio por pasajero"
      className={cn(
        'divide-y divide-[var(--color-border)]/50',
        size === 'compact' ? 'text-[11px]' : 'text-xs',
      )}
    >
      {sales.map((sale, index) => (
        <PaxRow
          key={`${sale.paxType}-${index}`}
          sale={sale}
          currency={currency}
          formatMoney={formatMoney}
        />
      ))}
    </ul>
  );
}

function PaxRow({
  sale,
  currency,
  formatMoney,
}: {
  readonly sale: PaxSale;
  readonly currency: string;
  readonly formatMoney: (amountMinor: number, currency: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [uno, varios] = PAX_NAMES[sale.paxType];
  const label = sale.paxCount === 1 ? uno : `${sale.paxCount} ${varios.toLowerCase()}`;
  const baseMinor = sale.sellPerPaxMinor - sale.taxesPerPaxMinor;
  const lines = sale.taxLines ?? [];
  const taxes = lines.filter((line) => !isCarrierCharge(line.code));
  const carrier = lines.filter((line) => isCarrierCharge(line.code));

  return (
    <li className="py-1.5 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-baseline justify-between gap-2 text-left text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        <span className="flex items-center gap-1">
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
          />
          {label} <span className="font-mono text-[var(--color-fg-subtle)]">({sale.paxType})</span>
        </span>
        <strong className="font-semibold tabular-nums text-[var(--color-fg)]">
          {formatMoney(sale.sellPerPaxMinor, currency)}
          {sale.paxCount > 1 ? <span className="font-normal"> c/u</span> : null}
        </strong>
      </button>

      <div id={panelId} hidden={!open}>
        {open ? (
          <dl className="mt-1.5 space-y-1 rounded-lg bg-[var(--color-surface-muted)]/60 px-2.5 py-2">
            <Line label="Tarifa base" value={formatMoney(baseMinor, currency)} strong />
            <Line
              label="Impuestos, tasas y cargos"
              value={formatMoney(sale.taxesPerPaxMinor, currency)}
              strong
            />
            {taxes.map((line, index) => (
              <Line
                key={`t-${line.code}-${index}`}
                label={taxLineLabel(line)}
                value={formatMoney(line.amount.amountMinor, line.amount.currency)}
                dotted
              />
            ))}
            {carrier.length > 0 ? (
              <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                Cargos de la aerolínea
              </p>
            ) : null}
            {carrier.map((line, index) => (
              <Line
                key={`c-${line.code}-${index}`}
                label={taxLineLabel(line)}
                value={formatMoney(line.amount.amountMinor, line.amount.currency)}
                dotted
              />
            ))}
            {lines.length === 0 ? (
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                El proveedor no informa el detalle de cada impuesto.
              </p>
            ) : null}
          </dl>
        ) : null}
      </div>
    </li>
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
      {dotted ? (
        <span
          aria-hidden="true"
          className="min-w-4 flex-1 border-b border-dotted border-[var(--color-border-strong)]"
        />
      ) : (
        <span aria-hidden="true" className="flex-1" />
      )}
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
