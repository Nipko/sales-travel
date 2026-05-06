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
import { cn } from '../../../../lib/cn';
import { Button } from '../../../../components/ui/button';

interface FareFamilyMatrixProps {
  fares: Offer[];
  formatMoney: (amountMinor: number, currency: string) => string;
  onQuote?: (offer: Offer) => Promise<void>;
}

const FARE_COLORS: Record<string, string> = {
  BASIC: 'bg-[var(--color-surface-muted)]',
  LIGHT: 'bg-blue-50/60',
  FULL: 'bg-green-50/60',
  'PREMIUM ECONOMY FULL': 'bg-amber-50/60',
};

const FARE_BADGES: Record<string, string | undefined> = {
  FULL: 'Recomendado',
};

function AttrIcon({ value }: { value: 'yes' | 'no' | 'partial' }) {
  if (value === 'yes')
    return <Check className="size-4 text-[var(--color-success)]" strokeWidth={2.5} />;
  if (value === 'partial')
    return <CircleMinus className="size-4 text-[var(--color-warning)]" strokeWidth={2} />;
  return <X className="size-4 text-[var(--color-fg-subtle)]" strokeWidth={1.5} />;
}

function AttrRow({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: 'yes' | 'no' | 'partial';
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-[var(--color-fg-subtle)]">{icon}</span>
      <div className="flex flex-1 items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-fg-muted)]">{label}</span>
        <div className="flex items-center gap-1">
          {detail && <span className="text-[10px] text-[var(--color-fg-subtle)]">{detail}</span>}
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
      <Button variant="primary" size="sm" className="mt-4 w-full" disabled>
        <Check className="size-4" /> Guardado
      </Button>
    );
  }

  return (
    <Button
      variant="primary"
      size="sm"
      className="mt-4 w-full"
      disabled={!onQuote || loading}
      onClick={handleClick}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : 'Guardar Cotización'}
    </Button>
  );
}

export function FareFamilyMatrix({ fares, formatMoney, onQuote }: FareFamilyMatrixProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {fares.map((fare) => {
        const name = fare.fareFamily?.name ?? 'STANDARD';
        const bgClass = FARE_COLORS[name] ?? 'bg-[var(--color-surface-muted)]';
        const badge = FARE_BADGES[name];
        const baggage = fare.baggage;
        const policies = fare.policies;

        return (
          <div
            key={fare.id}
            className={cn(
              'relative flex flex-col rounded-xl border border-[var(--color-border)] p-4 transition-all duration-150 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)]',
              bgClass,
            )}
          >
            {badge && (
              <span className="absolute -top-2.5 left-3 rounded-full bg-[var(--color-primary)] px-2.5 py-0.5 text-[10px] font-semibold text-[var(--color-primary-fg)]">
                {badge}
              </span>
            )}

            {/* Fare name + cabin */}
            <div className="mb-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-fg)]">
                {name}
              </p>
              {fare.fareFamily?.cabin && fare.fareFamily.cabin !== 'economy' && (
                <p className="mt-0.5 text-[10px] capitalize text-[var(--color-fg-muted)]">
                  {fare.fareFamily.cabin.replace('_', ' ')}
                </p>
              )}
            </div>

            {/* Price */}
            <div className="mb-4 border-b border-[var(--color-border)] pb-3">
              <p className="font-mono text-lg font-bold tabular-nums text-[var(--color-fg)]">
                {formatMoney(fare.total.amountMinor, fare.total.currency)}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">
                Base: {formatMoney(fare.baseFare.amountMinor, fare.baseFare.currency)} + Imp:{' '}
                {formatMoney(fare.taxes.amountMinor, fare.taxes.currency)}
              </p>
            </div>

            {/* Attributes */}
            <div className="flex-1 space-y-0.5">
              <AttrRow
                icon={<Package className="size-3.5" />}
                label="Artículo personal"
                value={baggage && baggage.personalItem > 0 ? 'yes' : 'no'}
              />
              <AttrRow
                icon={<Briefcase className="size-3.5" />}
                label="Carry-on"
                value={baggage && baggage.carryOn.qty > 0 ? 'yes' : 'no'}
                detail={
                  baggage && baggage.carryOn.qty > 0 && baggage.carryOn.weightKg
                    ? `${baggage.carryOn.weightKg}kg`
                    : undefined
                }
              />
              <AttrRow
                icon={<Luggage className="size-3.5" />}
                label="Maleta facturada"
                value={baggage && baggage.checked.qty > 0 ? 'yes' : 'no'}
                detail={
                  baggage && baggage.checked.qty > 0 && baggage.checked.weightKg
                    ? `${baggage.checked.weightKg}kg`
                    : undefined
                }
              />
              <AttrRow
                icon={<RefreshCw className="size-3.5" />}
                label="Cambios"
                value={policies?.changeable ? 'yes' : 'no'}
              />
              <AttrRow
                icon={<RotateCcw className="size-3.5" />}
                label="Reembolso"
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
