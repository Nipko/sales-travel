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
  Armchair,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { Offer } from '../actions';
import { fareAttributes, type AttrValue } from '../../../../lib/fare-attributes';
import { cn } from '../../../../lib/cn';
import { saleBreakdown, salePerPax, type PaxSale } from '../../../../lib/sale-breakdown';
import { isTestFare } from '../../../../lib/test-content';
import { Button } from '../../../../components/ui/button';
import { TestContentBadge } from '../../../../components/test-content-badge';
import { fareComponentsForDisplay, fareFamilySummary } from './fare-components-view';
import { BaggageIcons } from './baggage-icons';
import { legFare, type Leg } from './leg-selection';
import { TicketingDeadlineBadge } from './ticketing-deadline-badge';

/**
 * Cómo se usa la matriz. Por defecto, cada tarjeta es una combinación completa y su botón guarda
 * la cotización. Con `leg`, cada tarjeta es la tarifa de UN trayecto (ida o vuelta) y el botón lo
 * elige — es el flujo de ida y vuelta por trayecto (docs/sabre/15 §5).
 */
export interface FareChoiceMode {
  /** Trayecto cuya tarifa se compara: el nombre y los componentes de la tarjeta son los suyos. */
  leg: Leg;
  /** Texto del botón. */
  actionLabel: string;
  /** Rótulo del precio: «Ida y vuelta desde», «Total ida y vuelta». */
  priceLabel: string;
  /** `false` cuando el botón sólo elige y no guarda nada: no hay «Cotización Guardada» que mostrar. */
  confirmsSave: boolean;
}

interface FareFamilyMatrixProps {
  fares: Offer[];
  formatMoney: (amountMinor: number, currency: string) => string;
  onQuote?: (offer: Offer) => Promise<void>;
  mode?: FareChoiceMode;
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
  // La etiqueta de la aerolínea («1 cabin bag up to 10kg») no cabe en la pastilla: va debajo.
  const largo = detail !== undefined && detail.length > 16;
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
          {largo ? (
            <span className="mt-0.5 block text-[10px] font-medium text-[var(--color-fg-subtle)]">
              {detail}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {detail && !largo && (
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
  mode,
}: {
  fare: Offer;
  onQuote?: (offer: Offer) => Promise<void>;
  mode?: FareChoiceMode;
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function handleClick() {
    if (!onQuote || loading || done) return;
    setLoading(true);
    void onQuote(fare)
      .then(() => setDone(mode?.confirmsSave ?? true))
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
        (mode?.actionLabel ?? 'Guardar Cotización')
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

export function FareFamilyMatrix({ fares, formatMoney, onQuote, mode }: FareFamilyMatrixProps) {
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
          {...(mode === undefined ? {} : { mode })}
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
  mode?: FareChoiceMode;
}

function FareCard({ fare, solo, formatMoney, onQuote, mode }: FareCardProps) {
  // Con un trayecto elegido, la tarjeta habla SÓLO de ese trayecto: nombrarla «LIGHT / FLEX»
  // mezclaría la tarifa que se está eligiendo con la del otro trayecto.
  const components = fareComponentsForDisplay(fare).filter(
    (component) => mode === undefined || component.itineraryIndexes.includes(mode.leg),
  );
  const name =
    mode === undefined
      ? (fareFamilySummary(fare) ?? 'STANDARD')
      : legFare(fare, mode.leg).name.toUpperCase();
  const bgClass = FARE_COLORS[name] ?? 'bg-[var(--color-surface)] border-[var(--color-border)]/70';
  const badge = FARE_BADGES[name];
  const attrs = fareAttributes(fare, mode?.leg, formatMoney);

  const encabezado = (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-fg)]">{name}</p>
        {/* Cada tarjeta dice si ESA tarifa es de pruebas: un mismo vuelo puede traer una real por
            un proveedor y otra de pruebas por otro. Se puede cotizar igual, para probar el flujo. */}
        {isTestFare(fare) ? <TestContentBadge /> : null}
      </div>
      <BaggageIcons attributes={attrs} className="mt-3" />
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
  const porPasajero = salePerPax(fare);
  const precio = (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {mode?.priceLabel ?? 'Precio de venta'}
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
      <TicketingDeadlineBadge raw={fare.provider.raw} className="mt-2" />
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
      <PaxSales sales={porPasajero} currency={venta.currency} formatMoney={formatMoney} />
    </div>
  );

  const atributos = (
    <div>
      {/* De dónde sale lo que se lista: con trayecto elegido y sin atributos de marca, lo único
          que hay es el equipaje y las políticas del viaje completo, y hay que decirlo. */}
      {mode !== undefined ? (
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          {attrs.source === 'leg'
            ? `Incluye en la ${mode.leg === 0 ? 'ida' : 'vuelta'}`
            : 'Del viaje completo'}
        </p>
      ) : null}
      <div className="rounded-lg border border-[var(--color-border)]/40 px-2.5 py-1">
        <AttrRow
          icon={<Package className="size-3.5" />}
          label="Artículo personal"
          {...attrs.personalItem}
        />
        <AttrRow
          icon={<Briefcase className="size-3.5" />}
          label="Equipaje de mano"
          {...attrs.carryOn}
        />
        <AttrRow
          icon={<Luggage className="size-3.5" />}
          label="Maleta facturada"
          {...attrs.checked}
        />
        <AttrRow
          icon={<RefreshCw className="size-3.5" />}
          label="Cambios de fecha"
          {...attrs.change}
        />
        <AttrRow
          icon={<RotateCcw className="size-3.5" />}
          label="Reembolso de tarifa"
          {...attrs.refund}
        />
        {attrs.seat !== undefined && attrs.seat.value !== 'unknown' ? (
          <AttrRow
            icon={<Armchair className="size-3.5" />}
            label="Selección de asiento"
            {...attrs.seat}
          />
        ) : null}
      </div>
      {attrs.extras.length > 0 ? (
        <ul aria-label="También incluye" className="mt-2 flex flex-wrap gap-1">
          {attrs.extras.slice(0, 4).map((extra) => (
            <li
              key={extra}
              className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]"
            >
              {extra}
            </li>
          ))}
        </ul>
      ) : null}
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
            <QuoteButton fare={fare} onQuote={onQuote} {...(mode === undefined ? {} : { mode })} />
          </div>
        </>
      ) : (
        <>
          {encabezado}
          {trayectos ? <div className="mb-4">{trayectos}</div> : null}
          <div className="mb-4 border-b border-[var(--color-border)]/50 pb-4">{precio}</div>
          <div className="flex-1">{atributos}</div>
          <QuoteButton fare={fare} onQuote={onQuote} {...(mode === undefined ? {} : { mode })} />
        </>
      )}
    </div>
  );
}

const PAX_LABEL: Readonly<Record<PaxSale['paxType'], [string, string]>> = {
  ADT: ['Adulto', 'Adultos'],
  CHD: ['Niño', 'Niños'],
  INF: ['Infante', 'Infantes'],
};

/**
 * Lo que se le cobra a cada pasajero. Sólo cuando hay más de uno: con un adulto solo, el precio de
 * la tarjeta ya lo dice. Los tipos repetidos por el redondeo (un adulto con un centavo más) se
 * muestran como dos líneas, para que lo escrito sume exactamente el total.
 */
function PaxSales({
  sales,
  currency,
  formatMoney,
}: {
  sales: readonly PaxSale[];
  currency: string;
  formatMoney: (amountMinor: number, currency: string) => string;
}) {
  const pasajeros = sales.reduce((total, sale) => total + sale.paxCount, 0);
  if (pasajeros <= 1) return null;
  return (
    <ul
      aria-label="Precio por pasajero"
      className="mt-2 space-y-0.5 border-t border-[var(--color-border)]/40 pt-2 text-[11px] text-[var(--color-fg-subtle)]"
    >
      {sales.map((sale, index) => {
        const [uno, varios] = PAX_LABEL[sale.paxType];
        return (
          <li
            key={`${sale.paxType}-${index}`}
            className="flex items-baseline justify-between gap-2"
          >
            <span>{sale.paxCount === 1 ? uno : `${sale.paxCount} ${varios.toLowerCase()}`}</span>
            <strong className="font-semibold tabular-nums text-[var(--color-fg-muted)]">
              {formatMoney(sale.sellPerPaxMinor, currency)}
              {sale.paxCount > 1 ? <span className="font-normal"> c/u</span> : null}
            </strong>
          </li>
        );
      })}
    </ul>
  );
}
