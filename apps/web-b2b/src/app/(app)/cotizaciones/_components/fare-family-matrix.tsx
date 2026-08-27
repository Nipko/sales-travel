'use client';

import {
  Briefcase,
  Check,
  CircleMinus,
  Loader2,
  Luggage,
  Package,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { Offer } from '../actions';
import { baggageState } from '../../../../lib/baggage';
import { cn } from '../../../../lib/cn';
import { Button } from '../../../../components/ui/button';

interface FareFamilyMatrixProps {
  fares: Offer[];
  formatMoney: (amountMinor: number, currency: string) => string;
  onQuote?: (offer: Offer) => Promise<void>;
}

const FARE_COLORS: Record<string, string> = {
  BASIC: 'bg-[var(--color-surface)] border-[var(--color-border)]/70',
  LIGHT:
    'bg-[var(--color-primary)]/[0.02] border-[var(--color-primary)]/15 shadow-[var(--shadow-xs)]',
  FULL: 'bg-[var(--color-success)]/[0.02] border-[var(--color-success)]/15 shadow-[var(--shadow-xs)]',
  'PREMIUM ECONOMY FULL':
    'bg-[var(--color-accent)]/[0.02] border-[var(--color-accent)]/20 shadow-[var(--shadow-xs)]',
};

const FARE_BADGES: Record<string, string | undefined> = {
  FULL: 'Recomendado',
  'PREMIUM ECONOMY FULL': 'Clase Preferente',
};

function AttrIcon({ value }: { value: AttrValue }) {
  // `unknown` NO puede parecerse a `no`. Una cruz gris junto a «Maleta facturada» es una
  // afirmación —«esta tarifa no la lleva»— y aquí lo cierto es que el proveedor no lo informó.
  if (value === 'unknown') {
    return (
      <div className="flex size-4.5 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--color-border-strong)] text-[var(--color-fg-subtle)]">
        <CircleMinus className="size-3" strokeWidth={2} />
      </div>
    );
  }
  if (value === 'yes') {
    return (
      <div className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-success)]/12 text-[var(--color-success)] shadow-[var(--shadow-xs)]">
        <Check className="size-3" strokeWidth={3} />
      </div>
    );
  }
  if (value === 'partial') {
    return (
      <div className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning)]/12 text-[var(--color-warning)] shadow-[var(--shadow-xs)]">
        <CircleMinus className="size-3" strokeWidth={2.5} />
      </div>
    );
  }
  return (
    <div className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg-subtle)]/8 text-[var(--color-fg-subtle)]/60">
      <X className="size-3" strokeWidth={2} />
    </div>
  );
}

/** Los tres estados de una fila, más el `partial` que ya existía. */
type AttrValue = 'yes' | 'no' | 'partial' | 'unknown';

/** Traduce una franquicia a lo que pinta la fila, sin perder el «no se sabe». */
function attrDeEquipaje(allowance: { qty: number; weightKg?: number } | undefined): {
  value: AttrValue;
  detail?: string;
} {
  const state = baggageState(allowance);
  if (state.kind === 'unknown') return { value: 'unknown', detail: 'No informado' };
  if (state.kind === 'none') return { value: 'no' };
  return {
    value: 'yes',
    ...(state.weightKg === undefined ? {} : { detail: `${state.weightKg} kg` }),
  };
}

function AttrRow({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: AttrValue;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 py-2 border-b border-[var(--color-border)]/35 last:border-b-0">
      <span className="text-[var(--color-fg-subtle)]/80 size-4 flex items-center justify-center">
        {icon}
      </span>
      <div className="flex flex-1 items-center justify-between gap-2 min-w-0">
        {/* Sin `truncate`: la tarjeta es angosta y «Artículo personal» y «Equipaje de mano» salían
            como «Artículo p…» y «Equipaje d…». Un atributo que no se puede leer no informa de
            nada, y son justo los dos que el vendedor compara. Se deja que envuelva en dos
            líneas, que es lo que la columna admite. */}
        <span className="text-xs font-semibold leading-tight text-[var(--color-fg-muted)]">
          {label}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {detail && (
            <span className="text-[9px] font-bold text-[var(--color-fg-subtle)] bg-[var(--color-surface-muted)] border border-[var(--color-border)] px-1.5 py-0.5 rounded">
              {detail}
            </span>
          )}
          <AttrIcon value={value} />
        </div>
      </div>
    </div>
  );
}

function QuoteButton({
  fare,
  onQuote,
}: {
  fare: Offer;
  onQuote?: (offer: Offer) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function handleClick() {
    if (!onQuote || loading || done) return;
    setLoading(true);
    void onQuote(fare)
      .then(() => setDone(true))
      .finally(() => setLoading(false));
  }

  if (done) {
    return (
      <Button
        variant="primary"
        size="sm"
        className="mt-5 w-full bg-[var(--color-success)] text-white hover:bg-[var(--color-success)] border border-[var(--color-success)]/10 font-bold text-xs gap-1.5 shadow-[var(--shadow-sm)] animate-fade-in-up"
        disabled
      >
        <Check className="size-3.5" strokeWidth={2.5} /> Cotización Guardada
      </Button>
    );
  }

  return (
    <Button
      variant="primary"
      size="sm"
      className="mt-5 w-full bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] border border-[var(--color-primary)]/10 font-bold text-xs gap-1.5 transition-all active:scale-[0.98] shadow-[var(--shadow-sm)] cursor-pointer"
      disabled={!onQuote || loading}
      onClick={handleClick}
    >
      {loading ? (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          Procesando...
        </>
      ) : (
        'Guardar Cotización'
      )}
    </Button>
  );
}

export function FareFamilyMatrix({ fares, formatMoney, onQuote }: FareFamilyMatrixProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {fares.map((fare) => {
        const name = fare.fareFamily?.name ?? 'STANDARD';
        const bgClass =
          FARE_COLORS[name] ?? 'bg-[var(--color-surface)] border-[var(--color-border)]/70';
        const badge = FARE_BADGES[name];
        const baggage = fare.baggage;
        const policies = fare.policies;

        return (
          <div
            key={fare.id}
            className={cn(
              'relative flex flex-col rounded-xl border p-4.5 transition-all duration-300 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]',
              bgClass,
            )}
          >
            {badge && (
              <span className="absolute -top-2.5 left-4 rounded-full bg-[var(--color-primary)] px-2.5 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] animate-pulse">
                {badge}
              </span>
            )}

            {/* Fare name + cabin */}
            <div className="mb-4">
              <p className="text-[11px] font-black uppercase tracking-widest text-[var(--color-fg)]">
                {name}
              </p>
              {fare.fareFamily?.cabin && fare.fareFamily.cabin !== 'economy' && (
                <span className="inline-block mt-1.5 rounded bg-[var(--color-navy)]/8 border border-[var(--color-navy)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-navy)]">
                  {fare.fareFamily.cabin.replace('_', ' ')}
                </span>
              )}
            </div>

            {/* Price */}
            <div className="mb-4 border-b border-[var(--color-border)]/50 pb-3.5">
              <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-fg-subtle)]">
                Precio de venta
              </p>
              <p className="font-mono text-xl font-extrabold tabular-nums text-[var(--color-fg)] mt-0.5 tracking-tight leading-none">
                {formatMoney(
                  fare.pricing?.finalMinor ?? fare.total.amountMinor,
                  fare.total.currency,
                )}
              </p>
              {(fare.pricing?.ownMarkupMinor ?? 0) > 0 && (
                <p className="mt-0.5 text-[9px] font-medium text-[var(--color-fg-subtle)]">
                  neto {formatMoney(fare.total.amountMinor, fare.total.currency)}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] font-semibold text-[var(--color-fg-subtle)]">
                <span>
                  Base:{' '}
                  <strong className="font-mono text-[var(--color-fg)]">
                    {formatMoney(fare.baseFare.amountMinor, fare.baseFare.currency)}
                  </strong>
                </span>
                <span className="text-[var(--color-border)]">|</span>
                <span>
                  Imp:{' '}
                  <strong className="font-mono text-[var(--color-fg)]">
                    {formatMoney(fare.taxes.amountMinor, fare.taxes.currency)}
                  </strong>
                </span>
              </div>
            </div>

            {/* Attributes */}
            <div className="flex-1 space-y-0.5 bg-[var(--color-surface)]/60 rounded-lg p-1.5 border border-[var(--color-border)]/20">
              <AttrRow
                icon={<Package className="size-3.5" />}
                label="Artículo personal"
                {...attrDeEquipaje(
                  baggage?.personalItem === undefined ? undefined : { qty: baggage.personalItem },
                )}
              />
              <AttrRow
                icon={<Briefcase className="size-3.5" />}
                label="Equipaje de Mano"
                {...attrDeEquipaje(baggage?.carryOn)}
              />
              <AttrRow
                icon={<Luggage className="size-3.5" />}
                label="Maleta Facturada"
                {...attrDeEquipaje(baggage?.checked)}
              />
              <AttrRow
                icon={<RefreshCw className="size-3.5" />}
                label="Cambios de fecha"
                value={policies?.changeable ? 'yes' : 'no'}
              />
              <AttrRow
                icon={<RotateCcw className="size-3.5" />}
                label="Reembolso de tarifa"
                value={policies?.refundable ? 'yes' : 'no'}
              />
            </div>

            {/* CTA */}
            <QuoteButton fare={fare} onQuote={onQuote} />
          </div>
        );
      })}
    </div>
  );
}
