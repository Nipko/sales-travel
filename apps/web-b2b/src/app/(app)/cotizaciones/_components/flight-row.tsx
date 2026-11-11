'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import type { Offer } from '../actions';
import { cn } from '../../../../lib/cn';
import { providerTagFor } from '../../../../lib/provider-disclosure';
import { saleBreakdown, salePerPax } from '../../../../lib/sale-breakdown';
import { getAirportByCode } from '../../../../lib/airports';
import {
  SOME_TEST_FARES_DESCRIPTION,
  TEST_FARE_DESCRIPTION,
  testFareShare,
  type TestFareShare,
} from '../../../../lib/test-content';
import { TestContentBadge } from '../../../../components/test-content-badge';
import { airlineName } from './airline-names';
import { fareAttributes } from '../../../../lib/fare-attributes';
import { BaggageIcons } from './baggage-icons';
import { FareFamilyMatrix, type FareChoiceMode } from './fare-family-matrix';
import { fareFamilySummary } from './fare-components-view';
import { faresForLeg, legFare } from './leg-selection';
import { isRoundTripLegs, legLabel } from '../../../../lib/flight-legs';
import {
  buildItineraryView,
  codeshareOperators,
  layoverLabel,
  summarizeCarriers,
  type ItineraryInput,
  type ItineraryView,
  type LayoverView,
} from './itinerary-view';

export interface FlightGroup {
  key: string;
  offers: Offer[];
}

interface FlightRowProps {
  group: FlightGroup;
  formatMoney: (amountMinor: number, currency: string) => string;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatDuration: (minutes: number) => string;
  onQuote?: (offer: Offer) => Promise<void>;
  /**
   * Ajuste efectivo de divulgación de proveedor del tenant: ¿el vendedor ve de dónde sale
   * cada oferta (Sabre, LATAM NDC, …)?
   *
   * Apagado por defecto, igual que `PROVIDER_DISCLOSURE_DEFAULT`: es un dato interno del
   * consolidador. La etiqueta la resuelve `providerTagFor`, la misma que usa el panel de
   * administración, para que no haya dos nombres para el mismo proveedor.
   */
  showProvider?: boolean;
  /**
   * Ida y vuelta por trayecto: la fila muestra SÓLO ese trayecto y abre sus tarifas, una por
   * marca. Sin esto, la fila es la combinación completa de siempre.
   */
  fareChoice?: FareChoiceMode;
  /** Lo que la lista destaca de este vuelo: «Más barato», «Más rápido». */
  tags?: readonly string[];
}

/* ---------------------------------------------------------------------------
   Escala tipográfica de la fila

   Nada baja de 12 px (`text-xs`). El componente venía con `text-[9px]` y `text-[10px]`
   por todos lados: por debajo del mínimo legible, y encima en `--color-fg-subtle`, que
   sobre blanco da 5.51:1 —pasa AA como texto, pero no si nadie puede enfocarlo—.

   La jerarquía la hacen tamaño + peso + color, no el tamaño solo:
     hora de salida/llegada   text-lg  semibold  --color-fg
     precio de venta          text-xl  bold      --color-fg
     aerolínea / aeropuertos  text-sm  semibold  --color-fg
     duración, escalas, fecha text-xs  medium    --color-fg-muted / -subtle

   Los colores de estado (`--color-warning` 2.18:1, `--color-success` 3.71:1 sobre blanco)
   NO se usan nunca como color de texto: no llegan a AA. Van como fondo tenue o como punto,
   siempre con el significado escrito al lado, para no cargar información sólo en el color.
   --------------------------------------------------------------------------- */

const LOGO_SIZE = {
  sm: { box: 'size-7 rounded-md', text: 'text-[11px]', px: 28 },
  md: { box: 'size-10 rounded-lg', text: 'text-xs', px: 40 },
  lg: { box: 'size-12 rounded-xl', text: 'text-sm', px: 48 },
} as const;

/**
 * Logo de la aerolínea con el código siempre debajo.
 *
 * `pics.avs.io` es un tercero: puede tardar o no tener el código. El código es la capa base y la
 * imagen se revela sólo cuando carga, así que nunca queda un hueco en blanco.
 *
 * El estado no se reinicia solo: montarlo con `key={carrier}` es lo que garantiza que una fila
 * reordenada no herede el "cargado" de otra aerolínea.
 */
export function AirlineLogo({
  carrier,
  size = 'lg',
  className,
}: {
  carrier: string;
  size?: keyof typeof LOGO_SIZE;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const dims = LOGO_SIZE[size];

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-white',
        dims.box,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('font-mono font-bold tracking-wide text-slate-500', dims.text)}
      >
        {carrier}
      </span>
      <img
        src={`https://pics.avs.io/120/120/${carrier}.png`}
        alt=""
        width={dims.px}
        height={dims.px}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          'absolute inset-0 size-full bg-white object-contain p-1',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

/**
 * Logo principal y, si el viaje combina aerolíneas, el de la segunda montado en la esquina: se
 * ve que son dos sin leer el nombre. El fondo del logo es blanco también en el tema oscuro porque
 * los logos de las aerolíneas están dibujados para fondo claro.
 */
function AirlineMark({ carriers, size = 'lg' }: { carriers: string[]; size?: 'md' | 'lg' }) {
  const [main, second] = carriers;
  if (!main) return null;
  if (!second) return <AirlineLogo key={main} carrier={main} size={size} />;
  return (
    <div className={cn('relative shrink-0', size === 'lg' ? 'size-12' : 'size-10')}>
      <AirlineLogo
        key={main}
        carrier={main}
        size="md"
        className={size === 'lg' ? 'absolute left-0 top-0' : 'absolute left-0 top-0 size-8'}
      />
      <AirlineLogo
        key={second}
        carrier={second}
        size="sm"
        className="absolute -bottom-1 -right-1 ring-2 ring-[var(--color-surface)]"
      />
    </div>
  );
}

function carrierTitle(carriers: string[]): { main: string; others: string } {
  const [main = '', ...rest] = carriers;
  return { main: airlineName(main), others: rest.map(airlineName).join(', ') };
}

/** Los vuelos de la oferta, como los dicta el vendedor: «AA 2168 · AA 1520». */
function flightNumbers(itineraries: ItineraryInput[]): string {
  return itineraries
    .flatMap((it) => it.segments)
    .map((s) => `${s.carrier} ${s.flightNumber}`)
    .join(' · ');
}

/**
 * Identidad de la oferta: quién vuela, con el logo grande y el nombre completo. Visible en todos
 * los anchos: en el teléfono es donde trabaja el vendedor.
 */
function AirlineIdentity({
  itineraries,
  providerLabel,
  testFares = 'none',
  size = 'lg',
  tags = [],
}: {
  itineraries: ItineraryInput[];
  providerLabel?: string;
  /** Tarifas del entorno de pruebas del proveedor en este vuelo: la fila lo dice siempre. */
  testFares?: TestFareShare;
  size?: 'md' | 'lg';
  /** «Más barato», «Más rápido»: lo que la lista destaca de este vuelo. */
  tags?: readonly string[];
}) {
  const { carriers } = summarizeCarriers(itineraries);
  const title = carrierTitle(carriers);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <AirlineMark carriers={carriers} size={size} />
      <div className="min-w-0">
        <p
          className={cn(
            'truncate font-semibold text-[var(--color-fg)]',
            size === 'lg' ? 'text-base' : 'text-sm',
          )}
        >
          {title.main}
          {title.others ? (
            <span className="font-normal text-[var(--color-fg-muted)]"> + {title.others}</span>
          ) : null}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-mono text-xs tabular-nums text-[var(--color-fg-muted)]">
            {flightNumbers(itineraries)}
          </span>
          {providerLabel ? (
            <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg-muted)]">
              {providerLabel}
            </span>
          ) : null}
          {/* Aunque la pastilla del proveedor esté oculta: lo que se marca es que la tarifa no
              es real, no de quién es. Con tarifas de los dos tipos, cada tarjeta dice cuál. */}
          {testFares === 'none' ? null : (
            <TestContentBadge
              description={
                testFares === 'all' ? TEST_FARE_DESCRIPTION : SOME_TEST_FARES_DESCRIPTION
              }
            />
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[var(--color-success)]/14 px-2 py-px text-xs font-semibold text-[var(--color-fg)]"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * La línea de tiempo, con una marca por escala ubicada por tiempo transcurrido.
 *
 * Es el arreglo al reclamo de fondo: antes la línea era la misma para un directo y para uno
 * de dos escalas. Ahora cero marcas / una / dos se distinguen sin leer nada.
 *
 * Va `aria-hidden` a propósito: no aporta nada que no esté escrito en texto al lado (horas,
 * aeropuertos, conteo y duración de cada escala), y por eso mismo no necesita cumplir
 * contraste de objeto gráfico — la información no depende de que se vea la línea.
 */
function StopsTrack({ layovers }: { layovers: LayoverView[] }) {
  return (
    <div className="relative h-3.5 w-full" aria-hidden="true">
      <span className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-[var(--color-border-strong)]" />
      <span className="absolute left-0 top-1/2 size-2 -translate-y-1/2 rounded-full border border-[var(--color-fg-muted)] bg-[var(--color-surface)]" />
      <span className="absolute right-0 top-1/2 size-2 -translate-y-1/2 rounded-full border border-[var(--color-fg-muted)] bg-[var(--color-surface)]" />
      {layovers.map((layover, i) => (
        <span
          key={`${layover.arrivalAirport}-${i}`}
          style={{ left: `${layover.position * 100}%` }}
          className={cn(
            'absolute top-1/2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-fg)]',
            // La escala con alerta se estira, no cambia de color: el color no llega a AA
            // como objeto gráfico y el motivo ya va escrito en la pastilla de abajo.
            layover.alerts.length > 0 ? 'h-3.5' : 'h-2.5',
          )}
        />
      ))}
    </div>
  );
}

function LayoverChips({
  view,
  formatDuration,
}: {
  view: ItineraryView;
  formatDuration: (minutes: number) => string;
}) {
  if (view.stops <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-success)]/12 px-2.5 py-0.5 text-xs font-semibold text-[var(--color-fg)]">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--color-success)]" />
        Directo
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <span className="text-xs font-semibold text-[var(--color-fg)]">
        {view.stops} {view.stops === 1 ? 'escala' : 'escalas'}
      </span>
      {view.layovers.map((layover, i) => (
        <span
          key={`${layover.arrivalAirport}-${i}`}
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
            layover.alerts.length > 0
              ? 'bg-[var(--color-warning)]/18 font-semibold text-[var(--color-fg)]'
              : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
          )}
        >
          {layoverLabel(layover, formatDuration)}
        </span>
      ))}
    </div>
  );
}

/** La ciudad del código, si el catálogo la tiene: «CTG» se lee mejor con «Cartagena» debajo. */
function cityOf(code: string): string | undefined {
  const city = getAirportByCode(code)?.city;
  return city && city.toUpperCase() !== code.toUpperCase() ? city : undefined;
}

/**
 * Salida, línea de tiempo con duración y escalas, llegada. Es el corazón de cada renglón; con
 * `wide` las horas crecen y debajo del código va la ciudad (un solo tramo en pantalla).
 */
function LegTimes({
  itinerary,
  wide,
  formatTime,
  formatDuration,
}: {
  itinerary: ItineraryInput;
  wide: boolean;
  formatTime: (iso: string) => string;
  formatDuration: (minutes: number) => string;
}) {
  const first = itinerary.segments[0];
  const last = itinerary.segments[itinerary.segments.length - 1];
  if (!first || !last) return null;
  const view = buildItineraryView(itinerary);
  const originCity = wide ? cityOf(first.origin) : undefined;
  const destinationCity = wide ? cityOf(last.destination) : undefined;
  const timeClass = cn(
    'font-semibold leading-tight tabular-nums text-[var(--color-fg)]',
    wide ? 'text-xl' : 'text-lg',
  );

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 sm:gap-5">
      <div className="min-w-[3.5rem]">
        <p className={timeClass}>{formatTime(first.departureAt)}</p>
        <p className="text-sm font-semibold leading-tight text-[var(--color-fg-muted)]">
          {first.origin}
        </p>
        {originCity ? (
          <p className="hidden max-w-[9rem] truncate text-xs text-[var(--color-fg-muted)] sm:block">
            {originCity}
          </p>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col items-center gap-1 pt-1">
        <p className="text-xs font-medium tabular-nums text-[var(--color-fg-muted)]">
          {formatDuration(itinerary.totalDurationMinutes)}
        </p>
        <StopsTrack layovers={view.layovers} />
        <LayoverChips view={view} formatDuration={formatDuration} />
      </div>

      <div className="min-w-[3.5rem] text-right">
        <p className={timeClass}>
          {formatTime(last.arrivalAt)}
          {/* "+1" es la convención de la industria; el lector de pantalla recibe la frase entera. */}
          {view.arrivalDayOffset > 0 ? (
            <>
              <span
                aria-hidden="true"
                className="ml-0.5 align-super text-xs font-bold text-[var(--color-fg-muted)]"
              >
                +{view.arrivalDayOffset}
              </span>
              <span className="sr-only">
                {' '}
                (llega {view.arrivalDayOffset} {view.arrivalDayOffset === 1 ? 'día' : 'días'}{' '}
                después)
              </span>
            </>
          ) : null}
        </p>
        <p className="text-sm font-semibold leading-tight text-[var(--color-fg-muted)]">
          {last.destination}
        </p>
        {destinationCity ? (
          <p className="ml-auto hidden max-w-[9rem] truncate text-xs text-[var(--color-fg-muted)] sm:block">
            {destinationCity}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OperatedBy({ itinerary }: { itinerary: ItineraryInput }) {
  const operadoras = codeshareOperators(itinerary);
  if (operadoras.length === 0) return null;
  return (
    <p className="mt-1 text-xs font-medium text-[var(--color-fg-muted)]">
      Operado por {operadoras.map(airlineName).join(', ')}
    </p>
  );
}

/**
 * Un tramo de varios: etiqueta y fecha a la izquierda, el logo de quien lo vuela y las horas.
 * Todos los renglones comparten columnas, así los tramos se comparan de un vistazo; en el
 * teléfono la etiqueta sube encima.
 */
function LegRow({
  itinerary,
  label,
  formatTime,
  formatDate,
  formatDuration,
}: {
  itinerary: ItineraryInput;
  label?: string;
  formatTime: (iso: string) => string;
  formatDate: (iso: string) => string;
  formatDuration: (minutes: number) => string;
}) {
  const first = itinerary.segments[0];
  if (!first) return null;
  return (
    <div className="border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex items-center gap-2 sm:w-24 sm:shrink-0 sm:flex-col sm:items-start sm:gap-0">
          {label ? (
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg)]">
              {label}
            </p>
          ) : null}
          <p className="text-xs font-medium text-[var(--color-fg-muted)]">
            {formatDate(first.departureAt)}
          </p>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <AirlineLogo key={first.carrier} carrier={first.carrier} size="sm" />
          <LegTimes
            itinerary={itinerary}
            wide={false}
            formatTime={formatTime}
            formatDuration={formatDuration}
          />
        </div>
      </div>
      <div className="sm:pl-28">
        <OperatedBy itinerary={itinerary} />
      </div>
    </div>
  );
}

/**
 * El precio como lo pregunta el cliente: cuánto por adulto, cuánto de eso son impuestos y cuánto
 * es el total. Si el desglose por pasajero no cuadra con el total (`salePerPax` vacío), va sólo
 * el total: nunca un desglose que no suma.
 */
function PricePanel({
  offer,
  fares,
  fareChoice,
  formatMoney,
}: {
  offer: Offer;
  fares: number;
  fareChoice?: FareChoiceMode;
  formatMoney: (amountMinor: number, currency: string) => string;
}) {
  const venta = saleBreakdown(offer);
  const perPax = fareChoice === undefined ? salePerPax(offer) : [];
  const adult = perPax.find((p) => p.paxType === 'ADT') ?? perPax[0];
  const travelers = perPax.reduce((n, p) => n + p.paxCount, 0);
  const label = fareChoice?.priceLabel ?? (fares > 1 ? 'Desde' : 'Total');

  return (
    <div className="flex flex-col gap-1.5">
      {adult ? (
        <dl className="space-y-1 text-xs text-[var(--color-fg-muted)]">
          <dt className="font-medium text-[var(--color-fg)]">
            Precio por {adult.paxType === 'ADT' ? 'adulto' : 'pasajero'}
          </dt>
          <div className="flex justify-between gap-3">
            <dd>Tarifa</dd>
            <dd className="tabular-nums">
              {formatMoney(adult.sellPerPaxMinor - adult.taxesPerPaxMinor, venta.currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dd>Impuestos y tasas</dd>
            <dd className="tabular-nums">{formatMoney(adult.taxesPerPaxMinor, venta.currency)}</dd>
          </div>
        </dl>
      ) : null}
      <div
        className={cn(
          'flex items-baseline justify-between gap-3',
          adult && 'mt-1 border-t border-[var(--color-border)] pt-2',
        )}
      >
        <p className="text-xs font-medium text-[var(--color-fg-muted)]">
          {label}
          {travelers > 1 ? (
            <span className="block text-[var(--color-fg-subtle)]">{travelers} pasajeros</span>
          ) : null}
        </p>
        <p className="text-xl font-bold leading-tight tabular-nums text-[var(--color-fg)]">
          {formatMoney(venta.sellMinor, venta.currency)}
        </p>
      </div>
      {/* El costo de la AGENCIA, nunca el neto del proveedor: para una sub-agencia la diferencia
          entre los dos es el margen del consolidador. */}
      {venta.ownMarginMinor !== undefined && venta.costMinor !== undefined ? (
        <p className="text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
          tu costo {formatMoney(venta.costMinor, venta.currency)}
        </p>
      ) : null}
    </div>
  );
}

/** El llamado a la acción de la tarjeta. Es un `span`: toda la cabecera ya es el botón. */
function OpenFaresCue({ fares, expanded }: { fares: number; expanded: boolean }) {
  return (
    <span
      className={cn(
        'mt-2 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition-colors',
        expanded
          ? 'border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-fg)]'
          : 'bg-[var(--color-primary)] text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)]',
      )}
    >
      {expanded ? 'Ocultar tarifas' : fares > 1 ? `Ver ${fares} tarifas` : 'Ver tarifa'}
      <ChevronDown
        aria-hidden="true"
        className={cn('size-4 transition-transform', expanded && 'rotate-180')}
      />
    </span>
  );
}

export function FlightRow({
  group,
  formatMoney,
  formatTime,
  formatDate,
  formatDuration,
  onQuote,
  showProvider = false,
  fareChoice,
  tags,
}: FlightRowProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const cheapest = group.offers[0];
  const allItineraries = cheapest?.itineraries ?? [];
  // Con elección por trayecto se pinta sólo ese trayecto; el índice real decide la etiqueta.
  const shown = allItineraries
    .map((itinerary, index) => ({ itinerary, index }))
    .filter(({ index }) => fareChoice === undefined || index === fareChoice.leg);
  const itineraries = shown.map(({ itinerary }) => itinerary);
  const firstItinerary = itineraries[0];

  if (!cheapest || !firstItinerary?.segments[0]) return null;

  const fares = fareChoice === undefined ? group.offers : faresForLeg(group.offers, fareChoice.leg);
  const familySummary =
    fareChoice === undefined
      ? fareFamilySummary(cheapest)
      : fares.map((fare) => legFare(fare, fareChoice.leg).name).join(' · ');
  // Un solo tramo en pantalla (solo ida, o un paso de ida y vuelta): un renglón, sin cabecera
  // aparte; la identidad va en la misma línea que las horas.
  const single = shown.length === 1;
  const identity = (
    <AirlineIdentity
      itineraries={itineraries}
      providerLabel={providerTagFor(cheapest.provider.name, showProvider)?.label}
      testFares={testFareShare(group.offers)}
      size={single ? 'md' : 'lg'}
      {...(tags ? { tags } : {})}
    />
  );

  return (
    <article
      className={cn(
        'overflow-hidden rounded-2xl border bg-[var(--color-surface)] transition-all duration-200',
        expanded
          ? 'border-[var(--color-primary)]/45 shadow-[var(--shadow-md)]'
          : 'border-[var(--color-border)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]',
      )}
    >
      {/* Toda la cabecera abre el detalle. Sin `focus:outline-none`: el anillo global de
          `:focus-visible` es la única señal de quien navega con teclado. */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="block w-full cursor-pointer text-left"
      >
        <div className="flex flex-col md:flex-row md:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-5">
            {single ? (
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
                <div className="lg:w-56 lg:shrink-0">{identity}</div>
                <div className="min-w-0 flex-1">
                  <p className="mb-1 text-xs font-medium text-[var(--color-fg-muted)]">
                    {legLabel(allItineraries, shown[0]!.index) ? (
                      <span className="mr-1.5 font-semibold uppercase tracking-wide text-[var(--color-fg)]">
                        {legLabel(allItineraries, shown[0]!.index)}
                      </span>
                    ) : null}
                    {formatDate(firstItinerary.segments[0].departureAt)}
                  </p>
                  <LegTimes
                    itinerary={firstItinerary}
                    wide
                    formatTime={formatTime}
                    formatDuration={formatDuration}
                  />
                  <OperatedBy itinerary={firstItinerary} />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  {identity}
                  {familySummary ? (
                    <span className="hidden max-w-[14rem] shrink-0 truncate rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-fg-muted)] sm:inline-block">
                      {familySummary}
                    </span>
                  ) : null}
                </div>
                <div>
                  {shown.map(({ itinerary: it, index: i }) => (
                    <LegRow
                      key={i}
                      itinerary={it}
                      label={legLabel(allItineraries, i)}
                      formatTime={formatTime}
                      formatDate={formatDate}
                      formatDuration={formatDuration}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Un solo bloque de precio: barra inferior en el teléfono, columna derecha en
              escritorio. */}
          <div className="flex flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-4 py-3 sm:px-5 md:w-60 md:shrink-0 md:justify-center md:border-l md:border-t-0 md:p-5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {/* Las maletas de la tarifa más barata, la del precio que se muestra abajo. */}
              <BaggageIcons
                attributes={fareAttributes(cheapest, fareChoice?.leg, formatMoney)}
                size="sm"
              />
              {isRoundTripLegs(allItineraries) && fareChoice === undefined ? (
                <span className="rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
                  Ida y vuelta
                </span>
              ) : null}
              {familySummary ? (
                <span
                  className={cn(
                    'max-w-full truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium text-[var(--color-fg-muted)]',
                    !single && 'sm:hidden',
                  )}
                >
                  {familySummary}
                </span>
              ) : null}
            </div>
            <PricePanel
              offer={cheapest}
              fares={fares.length}
              formatMoney={formatMoney}
              {...(fareChoice ? { fareChoice } : {})}
            />
            {/* «Elegir» sólo está dentro: la invitación va siempre, también con una sola tarifa. */}
            <OpenFaresCue fares={fares.length} expanded={expanded} />
          </div>
        </div>
      </button>

      <div id={panelId} hidden={!expanded}>
        {expanded ? (
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/30 p-4 sm:p-5">
            <FareFamilyMatrix
              fares={fares}
              formatMoney={formatMoney}
              onQuote={onQuote}
              {...(fareChoice === undefined ? {} : { mode: fareChoice })}
            />
          </div>
        ) : null}
      </div>
    </article>
  );
}
