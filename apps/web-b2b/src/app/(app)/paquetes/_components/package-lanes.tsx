'use client';

import {
  Car,
  Check,
  ChevronDown,
  Hotel,
  Luggage,
  Plane,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/cn';
import { formatMoney } from '../../../../lib/flight-format';
import type { CarOffer } from '../../autos/actions';
import { CarPhoto } from '../../autos/_components/car-photo';
import type { Offer } from '../../cotizaciones/actions';
import { airlineLogoUrl, airlineName } from '../../cotizaciones/_components/airline-names';
import type { HotelRoompack } from '../../hoteles/actions';
import { HotelPhoto } from '../../hoteles/_components/hotel-photo';
import { rateBoardLabel } from '../../hoteles/_components/hotel-format';
import type { PhotoState } from '../../hoteles/_components/hotel-photos';
import {
  carKey,
  carSale,
  flightSale,
  priceDelta,
  roompackSale,
  totalStops,
  type HotelChoice,
  type ManualDraft,
  type ManualVertical,
  type Price,
} from './package-model';

// ─────────────────────────── Piezas comunes ───────────────────────────

export type LaneStatus = 'off' | 'loading' | 'error' | 'empty' | 'ready';

const LANE_ICON = { flights: Plane, hotels: Hotel, cars: Car, extras: Sparkles } as const;

export function LaneShell({
  kind,
  title,
  subtitle,
  status,
  error,
  onRetry,
  action,
  children,
}: {
  kind: keyof typeof LANE_ICON;
  title: string;
  subtitle?: string | undefined;
  status: LaneStatus;
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = LANE_ICON[kind];
  return (
    <section
      aria-labelledby={`lane-${kind}`}
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
    >
      <header className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`lane-${kind}`} className="text-sm font-semibold text-[var(--color-fg)]">
            {title}
          </h2>
          {subtitle ? (
            <p className="truncate text-xs text-[var(--color-fg-subtle)]">{subtitle}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="border-t border-[var(--color-border)] px-4 py-4 sm:px-5">
        {status === 'loading' ? (
          <LaneSkeleton />
        ) : status === 'error' ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-[var(--color-warning)]" />
            <span className="min-w-0 flex-1 text-[var(--color-fg-muted)]">{error}</span>
            {onRetry ? (
              <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
                <RefreshCw /> Reintentar
              </Button>
            ) : null}
          </div>
        ) : status === 'empty' ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            {error ?? 'No encontramos opciones para estas fechas.'}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function LaneSkeleton() {
  return (
    <div className="flex animate-pulse items-center gap-4" aria-busy="true" aria-label="Buscando">
      <div className="h-16 w-24 shrink-0 rounded-lg bg-[var(--color-surface-muted)]" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-2/3 rounded bg-[var(--color-surface-muted)]" />
        <div className="h-3 w-1/2 rounded bg-[var(--color-surface-muted)]" />
      </div>
      <div className="h-5 w-20 rounded bg-[var(--color-surface-muted)]" />
    </div>
  );
}

function PriceTag({ price, delta }: { price: Price; delta?: number | undefined }) {
  return (
    <div className="shrink-0 text-right">
      {delta === undefined ? (
        <p className="text-sm font-semibold tabular-nums text-[var(--color-fg)]">
          {formatMoney(price.amountMinor, price.currency)}
        </p>
      ) : (
        <p
          className={cn(
            'text-sm font-semibold tabular-nums',
            delta > 0
              ? 'text-[var(--color-fg)]'
              : delta < 0
                ? 'text-[var(--color-success)]'
                : 'text-[var(--color-fg-subtle)]',
          )}
        >
          {delta === 0
            ? 'Mismo precio'
            : `${delta > 0 ? '+' : '−'} ${formatMoney(Math.abs(delta), price.currency)}`}
        </p>
      )}
      {delta !== undefined && delta !== 0 ? (
        <p className="text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
          {formatMoney(price.amountMinor, price.currency)}
        </p>
      ) : null}
    </div>
  );
}

function ChangeToggle({
  open,
  count,
  onToggle,
  controls,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
  controls: string;
}) {
  if (count <= 1) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      {open ? 'Listo' : `Cambiar · ${count}`}
      <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
    </Button>
  );
}

function OptionButton({
  selected,
  onSelect,
  children,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
        selected
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
          : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]',
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          selected
            ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
            : 'border-[var(--color-border-strong)]',
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

export function RecommendedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent)]/25 px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]">
      <Sparkles className="size-3" /> Recomendado
    </span>
  );
}

function hiddenNote(count: number, currency: string | undefined) {
  if (count === 0 || !currency) return null;
  return (
    <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">
      {count === 1
        ? `1 opción en otra moneda no se muestra: el paquete se arma en ${currency}.`
        : `${count} opciones en otra moneda no se muestran: el paquete se arma en ${currency}.`}
    </p>
  );
}

// ─────────────────────────── Vuelo ───────────────────────────

function clock(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '';
}

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function stopsText(stops: number): string {
  return stops === 0 ? 'Directo' : stops === 1 ? '1 escala' : `${stops} escalas`;
}

function FlightSummary({ offer }: { offer: Offer }) {
  const carrier = offer.itineraries?.[0]?.segments[0]?.carrier ?? '';
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      {carrier ? (
        <img
          src={airlineLogoUrl(carrier)}
          alt=""
          className="mt-0.5 size-8 shrink-0 rounded-md bg-white object-contain"
          loading="lazy"
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium text-[var(--color-fg)]">
          {carrier ? airlineName(carrier) : 'Vuelo'}
          {offer.fareFamily?.name ? (
            <span className="font-normal text-[var(--color-fg-subtle)]">
              {' '}
              · {offer.fareFamily.name}
            </span>
          ) : null}
        </p>
        {(offer.itineraries ?? []).map((it, i) => {
          const first = it.segments[0];
          const last = it.segments.at(-1);
          if (!first || !last) return null;
          return (
            <p key={i} className="text-xs tabular-nums text-[var(--color-fg-muted)]">
              <span className="font-medium text-[var(--color-fg)]">
                {clock(first.departureAt)} {first.origin}
              </span>{' '}
              →{' '}
              <span className="font-medium text-[var(--color-fg)]">
                {clock(last.arrivalAt)} {last.destination}
              </span>{' '}
              · {stopsText(it.stops)} · {duration(it.totalDurationMinutes)}
            </p>
          );
        })}
        {offer.baggage?.checked?.qty ? (
          <p className="flex items-center gap-1 text-[11px] text-[var(--color-fg-subtle)]">
            <Luggage className="size-3" /> {offer.baggage.checked.qty} maleta
            {offer.baggage.checked.qty > 1 ? 's' : ''} en bodega
          </p>
        ) : null}
      </div>
    </div>
  );
}

const FLIGHT_OPTIONS = 8;

export function FlightLane(props: {
  status: LaneStatus;
  error?: string | undefined;
  onRetry: () => void;
  subtitle?: string | undefined;
  offers: readonly Offer[];
  hiddenByCurrency: number;
  currency?: string | undefined;
  selected?: Offer | undefined;
  recommendedId?: string | undefined;
  onSelect: (offer: Offer) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const options = useMemo(() => {
    const sorted = [...props.offers].sort(
      (a, b) =>
        flightSale(a).amountMinor - flightSale(b).amountMinor || totalStops(a) - totalStops(b),
    );
    const top = sorted.slice(0, FLIGHT_OPTIONS);
    if (props.selected && !top.some((o) => o.id === props.selected?.id))
      top.unshift(props.selected);
    return top;
  }, [props.offers, props.selected]);
  const selectedSale = props.selected ? flightSale(props.selected) : undefined;

  return (
    <LaneShell
      kind="flights"
      title="Vuelo"
      subtitle={props.subtitle}
      status={props.status}
      error={props.error}
      onRetry={props.onRetry}
      action={
        props.status === 'ready' ? (
          <ChangeToggle
            open={open}
            count={props.offers.length}
            onToggle={() => setOpen((v) => !v)}
            controls={listId}
          />
        ) : null
      }
    >
      {props.selected ? (
        <div className="flex items-start gap-3">
          <FlightSummary offer={props.selected} />
          <div className="flex flex-col items-end gap-1">
            {props.selected.id === props.recommendedId ? <RecommendedBadge /> : null}
            <PriceTag price={flightSale(props.selected)} />
          </div>
        </div>
      ) : null}
      {open ? (
        <ul id={listId} className="mt-4 space-y-2">
          {options.map((o) => (
            <li key={o.id}>
              <OptionButton
                selected={o.id === props.selected?.id}
                onSelect={() => props.onSelect(o)}
                label={`Elegir vuelo de ${formatMoney(flightSale(o).amountMinor, flightSale(o).currency)}`}
              >
                <FlightSummary offer={o} />
                <PriceTag price={flightSale(o)} delta={priceDelta(flightSale(o), selectedSale)} />
              </OptionButton>
            </li>
          ))}
        </ul>
      ) : null}
      {hiddenNote(props.hiddenByCurrency, props.currency)}
    </LaneShell>
  );
}

// ─────────────────────────── Hotel ───────────────────────────

function Stars({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${count} estrellas`}>
      {Array.from({ length: Math.min(5, Math.round(count)) }, (_, i) => (
        <Star key={i} className="size-3 fill-[var(--color-accent)] text-[var(--color-accent)]" />
      ))}
    </span>
  );
}

function HotelSummary({
  choice,
  photo,
  large = false,
}: {
  choice: HotelChoice;
  photo: PhotoState | undefined;
  large?: boolean;
}) {
  const { hotel, pack } = choice;
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <HotelPhoto
        state={photo}
        sizes={large ? '160px' : '96px'}
        className={cn('shrink-0 rounded-lg', large ? 'h-24 w-32 sm:h-28 sm:w-40' : 'h-16 w-20')}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium leading-snug text-[var(--color-fg)]">
          {hotel.name ?? 'Hotel'}
        </p>
        <Stars count={hotel.stars} />
        <p className="text-xs text-[var(--color-fg-muted)]">
          {pack.rooms[0]?.name ? `${pack.rooms[0].name} · ` : ''}
          {rateBoardLabel(pack)}
        </p>
        <p
          className={cn(
            'text-[11px]',
            pack.cancellation.refundable
              ? 'text-[var(--color-success)]'
              : 'text-[var(--color-fg-subtle)]',
          )}
        >
          {pack.cancellation.refundable ? 'Reembolsable' : 'No reembolsable'}
        </p>
      </div>
    </div>
  );
}

const HOTEL_OPTIONS = 10;
const ROOM_OPTIONS = 6;

export function HotelLane(props: {
  status: LaneStatus;
  error?: string | undefined;
  onRetry: () => void;
  subtitle?: string | undefined;
  choices: readonly HotelChoice[];
  hiddenByCurrency: number;
  currency?: string | undefined;
  selected?: HotelChoice | undefined;
  recommendedHotelId?: string | undefined;
  photos: ReadonlyMap<string, PhotoState>;
  photoKeyOf: (hotelId: string) => string | undefined;
  onSelect: (choice: HotelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const roomSelectId = useId();
  const options = useMemo(() => {
    const sorted = [...props.choices].sort(
      (a, b) => roompackSale(a.pack).amountMinor - roompackSale(b.pack).amountMinor,
    );
    const top = sorted.slice(0, HOTEL_OPTIONS);
    const sel = props.selected;
    if (sel && !top.some((c) => c.hotel.hotelId === sel.hotel.hotelId)) top.unshift(sel);
    return top;
  }, [props.choices, props.selected]);
  const selectedSale = props.selected ? roompackSale(props.selected.pack) : undefined;
  const photoOf = (hotelId: string) => {
    const key = props.photoKeyOf(hotelId);
    return key ? props.photos.get(key) : undefined;
  };

  const roomOptions = useMemo((): HotelRoompack[] => {
    if (!props.selected || !props.currency) return [];
    return props.selected.hotel.roompacks
      .filter((p) => roompackSale(p).currency === props.currency)
      .sort((a, b) => roompackSale(a).amountMinor - roompackSale(b).amountMinor)
      .slice(0, ROOM_OPTIONS);
  }, [props.selected, props.currency]);

  return (
    <LaneShell
      kind="hotels"
      title="Hotel"
      subtitle={props.subtitle}
      status={props.status}
      error={props.error}
      onRetry={props.onRetry}
      action={
        props.status === 'ready' ? (
          <ChangeToggle
            open={open}
            count={props.choices.length}
            onToggle={() => setOpen((v) => !v)}
            controls={listId}
          />
        ) : null
      }
    >
      {props.selected ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <HotelSummary
              choice={props.selected}
              photo={photoOf(props.selected.hotel.hotelId)}
              large
            />
            <div className="flex flex-col items-end gap-1">
              {props.selected.hotel.hotelId === props.recommendedHotelId ? (
                <RecommendedBadge />
              ) : null}
              <PriceTag price={roompackSale(props.selected.pack)} />
              <p className="text-[11px] text-[var(--color-fg-subtle)]">toda la estadía</p>
            </div>
          </div>
          {roomOptions.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={roomSelectId} className="text-xs text-[var(--color-fg-muted)]">
                Habitación
              </label>
              <select
                id={roomSelectId}
                value={props.selected.pack.id}
                onChange={(e) => {
                  const pack = roomOptions.find((p) => p.id === e.target.value);
                  if (pack && props.selected) props.onSelect({ hotel: props.selected.hotel, pack });
                }}
                className="h-8 min-w-0 max-w-full flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
              >
                {roomOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {(p.rooms[0]?.name ?? 'Habitación') +
                      ' · ' +
                      rateBoardLabel(p) +
                      ' · ' +
                      formatMoney(roompackSale(p).amountMinor, roompackSale(p).currency)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <ul id={listId} className="mt-4 space-y-2">
          {options.map((c) => (
            <li key={c.hotel.hotelId}>
              <OptionButton
                selected={c.hotel.hotelId === props.selected?.hotel.hotelId}
                onSelect={() => props.onSelect(c)}
                label={`Elegir ${c.hotel.name ?? 'hotel'}`}
              >
                <HotelSummary choice={c} photo={photoOf(c.hotel.hotelId)} />
                <PriceTag
                  price={roompackSale(c.pack)}
                  delta={priceDelta(roompackSale(c.pack), selectedSale)}
                />
              </OptionButton>
            </li>
          ))}
        </ul>
      ) : null}
      {hiddenNote(props.hiddenByCurrency, props.currency)}
    </LaneShell>
  );
}

// ─────────────────────────── Auto ───────────────────────────

function CarSummary({ car, large = false }: { car: CarOffer; large?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <CarPhoto
        src={car.imageUrl}
        className={cn(
          'shrink-0 rounded-lg border border-[var(--color-border)]',
          large ? 'h-20 w-32' : 'h-14 w-20',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium text-[var(--color-fg)]">{car.carModel}</p>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {car.category} · {car.companyName}
        </p>
        <p className="flex items-center gap-2 text-[11px] text-[var(--color-fg-subtle)]">
          <span className="inline-flex items-center gap-1">
            <Users className="size-3" /> {car.passengers}
          </span>
          <span className="inline-flex items-center gap-1">
            <Luggage className="size-3" /> {car.bags}
          </span>
          <span>{/^a/i.test(car.trans) ? 'Automático' : 'Manual'}</span>
        </p>
      </div>
    </div>
  );
}

const CAR_OPTIONS = 8;

export function CarLane(props: {
  status: LaneStatus;
  error?: string | undefined;
  onRetry: () => void;
  subtitle?: string | undefined;
  cars: readonly CarOffer[];
  hiddenByCurrency: number;
  currency?: string | undefined;
  selected?: CarOffer | undefined;
  recommendedKey?: string | undefined;
  onSelect: (car: CarOffer) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const options = useMemo(() => {
    const sorted = [...props.cars].sort((a, b) => carSale(a).amountMinor - carSale(b).amountMinor);
    const top = sorted.slice(0, CAR_OPTIONS);
    const sel = props.selected;
    if (sel && !top.some((c) => carKey(c) === carKey(sel))) top.unshift(sel);
    return top;
  }, [props.cars, props.selected]);
  const selectedSale = props.selected ? carSale(props.selected) : undefined;

  return (
    <LaneShell
      kind="cars"
      title="Auto"
      subtitle={props.subtitle}
      status={props.status}
      error={props.error}
      onRetry={props.onRetry}
      action={
        props.status === 'ready' ? (
          <ChangeToggle
            open={open}
            count={props.cars.length}
            onToggle={() => setOpen((v) => !v)}
            controls={listId}
          />
        ) : null
      }
    >
      {props.selected ? (
        <div className="flex items-start gap-3">
          <CarSummary car={props.selected} large />
          <div className="flex flex-col items-end gap-1">
            {carKey(props.selected) === props.recommendedKey ? <RecommendedBadge /> : null}
            <PriceTag price={carSale(props.selected)} />
          </div>
        </div>
      ) : null}
      {open ? (
        <ul id={listId} className="mt-4 space-y-2">
          {options.map((c) => (
            <li key={carKey(c)}>
              <OptionButton
                selected={props.selected !== undefined && carKey(c) === carKey(props.selected)}
                onSelect={() => props.onSelect(c)}
                label={`Elegir ${c.carModel}`}
              >
                <CarSummary car={c} />
                <PriceTag price={carSale(c)} delta={priceDelta(carSale(c), selectedSale)} />
              </OptionButton>
            </li>
          ))}
        </ul>
      ) : null}
      {hiddenNote(props.hiddenByCurrency, props.currency)}
    </LaneShell>
  );
}

// ─────────────────────────── Extras manuales ───────────────────────────

export const MANUAL_LABEL: Record<ManualVertical, string> = {
  activities: 'Actividad',
  transfers: 'Traslado',
  other: 'Otro servicio',
};

const fieldClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]';

/** «150.000» o «150000,50» → unidades menores. */
export function parseAmount(raw: string, decimals: 0 | 2): number | undefined {
  const cleaned = raw.replace(/[^\d,.]/g, '');
  if (!cleaned) return undefined;
  let normalized: string;
  if (decimals === 0) normalized = cleaned.replace(/[.,]/g, '');
  else {
    const lastSep = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'));
    normalized =
      lastSep >= 0 && cleaned.length - lastSep - 1 <= 2
        ? `${cleaned.slice(0, lastSep).replace(/[.,]/g, '')}.${cleaned.slice(lastSep + 1)}`
        : cleaned.replace(/[.,]/g, '');
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * 100);
}

export function ExtrasLane({
  items,
  currency,
  currencyDecimals,
  tripDays,
  onAdd,
  onRemove,
}: {
  items: readonly ManualDraft[];
  currency: string | undefined;
  currencyDecimals: 0 | 2;
  tripDays: readonly { date: string; label: string }[];
  onAdd: (draft: ManualDraft) => void;
  onRemove: (index: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [vertical, setVertical] = useState<ManualVertical>('activities');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string>();
  const ids = useId();

  function reset() {
    setTitle('');
    setDescription('');
    setDate('');
    setAmount('');
    setProblem(undefined);
    setAdding(false);
  }

  function submit() {
    const priceMinor = parseAmount(amount, currencyDecimals);
    if (title.trim().length < 3) return setProblem('Escribe un nombre para el servicio.');
    if (priceMinor === undefined) return setProblem('Escribe el precio de venta.');
    onAdd({
      vertical,
      title: title.trim().slice(0, 120),
      ...(description.trim() ? { description: description.trim().slice(0, 400) } : {}),
      ...(date ? { date } : {}),
      priceMinor,
    });
    reset();
  }

  return (
    <LaneShell
      kind="extras"
      title="Actividades y traslados"
      subtitle="Tours, traslados o lo que sumes por tu cuenta"
      status="ready"
      action={
        !adding ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            disabled={!currency}
          >
            <Plus /> Agregar
          </Button>
        ) : null
      }
    >
      {items.length === 0 && !adding ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          Suma un tour, un traslado del aeropuerto o una entrada. El precio que escribas es el de
          venta.
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li
              key={`${item.title}-${i}`}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5"
            >
              <Sparkles className="size-4 shrink-0 text-[var(--color-primary)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--color-fg)]">{item.title}</p>
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  {MANUAL_LABEL[item.vertical]}
                  {item.date
                    ? ` · ${tripDays.find((d) => d.date === item.date)?.label ?? item.date}`
                    : ''}
                </p>
              </div>
              {currency ? <PriceTag price={{ amountMinor: item.priceMinor, currency }} /> : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Quitar ${item.title}`}
                onClick={() => onRemove(i)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className={cn('grid gap-3 sm:grid-cols-2', items.length > 0 && 'mt-4')}>
          <div className="space-y-1 sm:col-span-2">
            <div role="radiogroup" aria-label="Tipo de servicio" className="flex flex-wrap gap-2">
              {(Object.keys(MANUAL_LABEL) as ManualVertical[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={vertical === v}
                  onClick={() => setVertical(v)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    vertical === v
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
                  )}
                >
                  {MANUAL_LABEL[v]}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label
              htmlFor={`${ids}-title`}
              className="text-xs font-medium text-[var(--color-fg-muted)]"
            >
              Nombre
            </label>
            <input
              id={`${ids}-title`}
              className={fieldClass}
              value={title}
              maxLength={120}
              placeholder="Tour a las Islas del Rosario"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label
              htmlFor={`${ids}-desc`}
              className="text-xs font-medium text-[var(--color-fg-muted)]"
            >
              Descripción (opcional)
            </label>
            <input
              id={`${ids}-desc`}
              className={fieldClass}
              value={description}
              maxLength={400}
              placeholder="Lancha ida y vuelta, almuerzo típico incluido"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`${ids}-date`}
              className="text-xs font-medium text-[var(--color-fg-muted)]"
            >
              Día
            </label>
            <select
              id={`${ids}-date`}
              className={fieldClass}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            >
              <option value="">Sin día fijo</option>
              {tripDays.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`${ids}-amount`}
              className="text-xs font-medium text-[var(--color-fg-muted)]"
            >
              Precio de venta {currency ? `(${currency})` : ''}
            </label>
            <input
              id={`${ids}-amount`}
              className={cn(fieldClass, 'tabular-nums')}
              inputMode="decimal"
              value={amount}
              placeholder="250.000"
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {problem ? (
            <p role="alert" className="text-xs text-[var(--color-danger)] sm:col-span-2">
              {problem}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              Cancelar
            </Button>
            <Button type="button" size="sm" onClick={submit}>
              <Plus /> Agregar al paquete
            </Button>
          </div>
        </div>
      ) : null}
    </LaneShell>
  );
}
