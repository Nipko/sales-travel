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
import { policyBadge, policyState, type PolicyState } from '../../../../lib/fare-policy';
import { cn } from '../../../../lib/cn';
import { saleBreakdown } from '../../../../lib/sale-breakdown';
import { Button } from '../../../../components/ui/button';
import { fareComponentsForDisplay, fareFamilySummary } from './fare-components-view';

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

/** La política con cargo es `partial`: se permite, pero no gratis. Un ✓ ahí prometía lo contrario. */
function attrDePolitica(
  state: PolicyState,
  formatMoney: (amountMinor: number, currency: string) => string,
): { value: AttrValue; detail?: string } {
  const detail = policyBadge(state, formatMoney);
  const value: AttrValue =
    state.kind === 'unknown'
      ? 'unknown'
      : state.kind === 'no'
        ? 'no'
        : state.kind === 'free'
          ? 'yes'
          : 'partial';
  return detail === undefined ? { value } : { value, detail };
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

/**
 * Columnas según cuántas tarifas hay, no un `lg:grid-cols-4` fijo.
 *
 * Con cuatro columnas fijas, UNA tarifa —el caso normal mientras Sabre devuelva una marca por
 * vuelo— ocupaba un cuarto del ancho y dejaba el resto del panel vacío: la pantalla parecía rota
 * justo en el momento en que el vendedor está decidiendo si cotiza.
 */
export function fareGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-1 sm:grid-cols-2';
  if (count === 3) return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';
}

export function FareFamilyMatrix({ fares, formatMoney, onQuote }: FareFamilyMatrixProps) {
  const solo = fares.length === 1;
  return (
    <div className={cn('grid gap-4', fareGridClass(fares.length))}>
      {fares.map((fare) => (
        <FareCard
          key={fare.id}
          fare={fare}
          solo={solo}
          formatMoney={formatMoney}
          onQuote={onQuote}
        />
      ))}
    </div>
  );
}

interface FareCardProps {
  fare: Offer;
  /** Única tarifa del vuelo: en escritorio se reparte en horizontal en vez de apilarse. */
  solo: boolean;
  formatMoney: (amountMinor: number, currency: string) => string;
  onQuote?: (offer: Offer) => Promise<void>;
}

function FareCard({ fare, solo, formatMoney, onQuote }: FareCardProps) {
  const components = fareComponentsForDisplay(fare);
  const name = fareFamilySummary(fare) ?? 'STANDARD';
  const bgClass = FARE_COLORS[name] ?? 'bg-[var(--color-surface)] border-[var(--color-border)]/70';
  const badge = FARE_BADGES[name];
  const baggage = fare.baggage;
  const policies = fare.policies;

  const encabezado = (
    <div className="mb-4">
      <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-fg)]">{name}</p>
      {fare.fareFamily?.cabin && fare.fareFamily.cabin !== 'economy' && (
        <span className="mt-1.5 inline-block rounded-md border border-[var(--color-navy)]/10 bg-[var(--color-navy)]/8 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-navy)]">
          {fare.fareFamily.cabin.replace('_', ' ')}
        </span>
      )}
    </div>
  );

  const trayectos =
    components.length > 0 ? (
      <div
        aria-label="Familias por trayecto"
        className="space-y-2.5 rounded-lg bg-[var(--color-surface-muted)]/60 p-3"
      >
        {components.map((component) => (
          <div key={component.key} className="text-xs">
            <p className="font-medium text-[var(--color-fg-muted)]">
              {component.legLabel} · {component.route}
            </p>
            <p className="font-semibold text-[var(--color-fg)]">{component.name}</p>
            {component.details.length > 0 && (
              // Códigos de tarifa (fare basis, clase): el vendedor los usa, el ojo no los necesita
              // para decidir. Van presentes pero en el tono más bajo de la tarjeta.
              <p className="mt-0.5 font-mono text-[10px] text-[var(--color-fg-subtle)]">
                {component.details.join(' · ')}
              </p>
            )}
          </div>
        ))}
      </div>
    ) : null;

  const venta = saleBreakdown(fare);
  const precio = (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
        Precio de venta
      </p>
      <p className="mt-1 text-2xl font-bold leading-none tracking-tight tabular-nums text-[var(--color-fg)]">
        {formatMoney(venta.sellMinor, venta.currency)}
      </p>
      {venta.ownMarginMinor !== undefined && venta.costMinor !== undefined && (
        <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
          tu costo {formatMoney(venta.costMinor, venta.currency)} · margen{' '}
          {formatMoney(venta.ownMarginMinor, venta.currency)}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-subtle)]">
        <span>
          Base{' '}
          <strong className="font-semibold tabular-nums text-[var(--color-fg-muted)]">
            {formatMoney(venta.baseMinor, venta.currency)}
          </strong>
        </span>
        <span>
          Impuestos{' '}
          <strong className="font-semibold tabular-nums text-[var(--color-fg-muted)]">
            {formatMoney(venta.taxesMinor, venta.currency)}
          </strong>
        </span>
      </div>
    </div>
  );

  const atributos = (
    <div className="rounded-lg border border-[var(--color-border)]/40 px-2.5 py-1">
      <AttrRow
        icon={<Package className="size-3.5" />}
        label="Artículo personal"
        {...attrDeEquipaje(
          baggage?.personalItem === undefined ? undefined : { qty: baggage.personalItem },
        )}
      />
      <AttrRow
        icon={<Briefcase className="size-3.5" />}
        label="Equipaje de mano"
        {...attrDeEquipaje(baggage?.carryOn)}
      />
      <AttrRow
        icon={<Luggage className="size-3.5" />}
        label="Maleta facturada"
        {...attrDeEquipaje(baggage?.checked)}
      />
      <AttrRow
        icon={<RefreshCw className="size-3.5" />}
        label="Cambios de fecha"
        {...attrDePolitica(policyState(policies, 'change'), formatMoney)}
      />
      <AttrRow
        icon={<RotateCcw className="size-3.5" />}
        label="Reembolso de tarifa"
        {...attrDePolitica(policyState(policies, 'refund'), formatMoney)}
      />
    </div>
  );

  return (
    <div
      className={cn(
        'relative rounded-xl border p-5 transition-shadow duration-200 hover:shadow-[var(--shadow-md)]',
        bgClass,
        // Una sola tarifa: tres zonas en fila (qué es · qué incluye · cuánto cuesta y cotizar),
        // que es el orden en que se lee una oferta. En móvil se apila igual que la matriz.
        solo
          ? 'flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_15rem] lg:items-start lg:gap-6'
          : 'flex flex-col',
      )}
    >
      {badge && (
        <span className="absolute -top-2.5 left-4 rounded-full bg-[var(--color-primary)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)]">
          {badge}
        </span>
      )}

      {solo ? (
        <>
          <div>
            {encabezado}
            {trayectos}
          </div>
          {atributos}
          <div className="flex flex-col lg:items-stretch">
            {precio}
            <QuoteButton fare={fare} onQuote={onQuote} />
          </div>
        </>
      ) : (
        <>
          {encabezado}
          {trayectos ? <div className="mb-4">{trayectos}</div> : null}
          <div className="mb-4 border-b border-[var(--color-border)]/50 pb-4">{precio}</div>
          <div className="flex-1">{atributos}</div>
          <QuoteButton fare={fare} onQuote={onQuote} />
        </>
      )}
    </div>
  );
}
