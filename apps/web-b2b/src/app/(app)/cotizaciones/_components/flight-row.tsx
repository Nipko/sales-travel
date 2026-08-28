'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import type { Offer } from '../actions';
import { cn } from '../../../../lib/cn';
import { providerTagFor } from '../../../../lib/provider-disclosure';
import { airlineName } from './airline-names';
import { FareFamilyMatrix } from './fare-family-matrix';
import { fareFamilySummary } from './fare-components-view';
import {
  buildItineraryView,
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

/**
 * Logo de la aerolínea con el código siempre debajo.
 *
 * `pics.avs.io` es un tercero: puede tardar o no tener el código. Antes eso dejaba un hueco
 * en blanco hasta que fallara. Acá el código es la capa base y la imagen se revela sólo
 * cuando carga, así que el hueco no existe en ningún estado.
 *
 * El estado no se reinicia solo: montarlo con `key={carrier}` es lo que garantiza que una
 * fila reordenada no herede el "cargado" de otra aerolínea.
 */
function AirlineLogo({ carrier }: { carrier: string }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <span
        aria-hidden="true"
        className="font-mono text-xs font-bold tracking-wide text-[var(--color-fg-muted)]"
      >
        {carrier}
      </span>
      <img
        src={`https://pics.avs.io/60/60/${carrier}.png`}
        alt=""
        width={44}
        height={44}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          'absolute inset-0 size-full bg-[var(--color-surface)] object-contain p-1.5',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

/**
 * Identidad de la oferta: quién vuela. Visible en TODOS los anchos.
 *
 * Antes vivía en `hidden … lg:block`, o sea que en móvil y tablet —donde el vendedor
 * trabaja— la aerolínea no aparecía, y donde aparecía era una pastilla de 10 px.
 */
function AirlineIdentity({
  itineraries,
  providerLabel,
}: {
  itineraries: ItineraryInput[];
  providerLabel?: string;
}) {
  const { main, carriers, firstFlight } = summarizeCarriers(itineraries);
  const extraCarriers = carriers.length - 1;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <AirlineLogo key={main} carrier={main} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--color-fg)]">
          {airlineName(main)}
          {extraCarriers > 0 ? (
            <span className="font-normal text-[var(--color-fg-muted)]">
              {' '}
              + {extraCarriers} {extraCarriers === 1 ? 'aerolínea' : 'aerolíneas'}
            </span>
          ) : null}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs tabular-nums text-[var(--color-fg-subtle)]">
            {firstFlight}
          </span>
          {providerLabel ? (
            <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg-muted)]">
              {providerLabel}
            </span>
          ) : null}
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

function ItineraryLeg({
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
  const last = itinerary.segments[itinerary.segments.length - 1];
  if (!first || !last) return null;

  const view = buildItineraryView(itinerary);

  return (
    <div>
      {/* Cabecera del tramo: la fecha vive acá, una sola vez, y no debajo de cada aeropuerto
          en 10 px. Con ida y vuelta además dice cuál es cuál en todos los anchos. */}
      <p className="mb-1.5 flex items-center gap-2 text-xs font-medium text-[var(--color-fg-muted)]">
        {label ? (
          <span className="font-semibold uppercase tracking-wide text-[var(--color-fg)]">
            {label}
          </span>
        ) : null}
        <span>{formatDate(first.departureAt)}</span>
      </p>

      <div className="flex items-start gap-3 sm:gap-5">
        <div className="min-w-[3.5rem]">
          <p className="text-lg font-semibold leading-tight tabular-nums text-[var(--color-fg)]">
            {formatTime(first.departureAt)}
          </p>
          <p className="text-sm font-semibold leading-tight text-[var(--color-fg-muted)]">
            {first.origin}
          </p>
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-center gap-1 pt-1">
          <p className="text-xs font-medium tabular-nums text-[var(--color-fg-muted)]">
            {formatDuration(itinerary.totalDurationMinutes)}
          </p>
          <StopsTrack layovers={view.layovers} />
          <LayoverChips view={view} formatDuration={formatDuration} />
        </div>

        <div className="min-w-[3.5rem] text-right">
          <p className="text-lg font-semibold leading-tight tabular-nums text-[var(--color-fg)]">
            {formatTime(last.arrivalAt)}
            {/* "+1" es la convención de la industria y ocupa lo que puede ocupar al lado de
                la hora; el lector de pantalla recibe la frase entera, que un `title` no
                garantiza que se anuncie. */}
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
        </div>
      </div>
    </div>
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
}: FlightRowProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const cheapest = group.offers[0];
  const itineraries = cheapest?.itineraries ?? [];
  const firstItinerary = itineraries[0];

  if (!cheapest || !firstItinerary?.segments[0]) return null;

  const isRoundtrip = itineraries.length > 1;
  const hasMultipleFares = group.offers.length > 1;
  // Precio de venta = neto + cascada de markup (si hay reglas configuradas); si no, el neto.
  const sellMinor = cheapest.pricing?.finalMinor ?? cheapest.total.amountMinor;
  const hasMarkup = (cheapest.pricing?.ownMarkupMinor ?? 0) > 0;
  const familySummary = fareFamilySummary(cheapest);

  return (
    <article
      className={cn(
        'overflow-hidden rounded-xl border bg-[var(--color-surface)] transition-colors',
        expanded
          ? 'border-[var(--color-primary)]/45 shadow-[var(--shadow-md)]'
          : 'border-[var(--color-border)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)]',
      )}
    >
      {/* Toda la cabecera abre el detalle. Sin `focus:outline-none`: el anillo global de
          `:focus-visible` es la única señal que tiene quien navega con teclado, y abrir esto
          es el paso obligado para cotizar. */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="block w-full cursor-pointer text-left"
      >
        <div className="flex flex-col md:flex-row md:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-5">
            {/* El color de la pastilla lo decide `providerTagFor` con clases de paleta fija;
                acá se toma sólo la etiqueta y se pinta con los tokens del design system,
                que son los únicos que siguen al tema oscuro. */}
            <AirlineIdentity
              itineraries={itineraries}
              providerLabel={providerTagFor(cheapest.provider.name, showProvider)?.label}
            />
            {itineraries.map((it, i) => (
              <ItineraryLeg
                key={i}
                itinerary={it}
                label={isRoundtrip ? (i === 0 ? 'Ida' : 'Vuelta') : undefined}
                formatTime={formatTime}
                formatDate={formatDate}
                formatDuration={formatDuration}
              />
            ))}
          </div>

          {/* Un solo bloque de precio para los dos layouts: barra inferior en móvil,
              columna derecha en escritorio. Antes había dos copias del precio en el DOM. */}
          <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/30 px-4 py-3 sm:px-5 md:w-48 md:shrink-0 md:flex-col md:items-end md:justify-center md:gap-3 md:border-l md:border-t-0 md:bg-transparent md:p-5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 md:order-2 md:justify-end">
              {isRoundtrip ? (
                <span className="rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
                  Ida y vuelta
                </span>
              ) : null}
              {familySummary ? (
                <span className="truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium text-[var(--color-fg-muted)]">
                  {familySummary}
                </span>
              ) : null}
            </div>

            <div className="shrink-0 text-right md:order-1 md:w-full">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {hasMultipleFares ? 'Desde' : 'Total'}
              </p>
              <p className="text-xl font-bold leading-tight tabular-nums text-[var(--color-fg)]">
                {formatMoney(sellMinor, cheapest.total.currency)}
              </p>
              {hasMarkup ? (
                <p className="mt-0.5 text-xs tabular-nums text-[var(--color-fg-muted)]">
                  neto {formatMoney(cheapest.total.amountMinor, cheapest.total.currency)} + markup
                </p>
              ) : null}
              {/* La única puerta a "Guardar cotización" es abrir esta tarjeta, así que la
                  invitación va siempre — también cuando hay una sola tarifa, que antes no
                  mostraba nada y dejaba la venta escondida. */}
              <span className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-fg-muted)]">
                {hasMultipleFares ? `${group.offers.length} tarifas` : 'Ver tarifa'}
                <ChevronDown
                  aria-hidden="true"
                  className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                />
              </span>
            </div>
          </div>
        </div>
      </button>

      <div id={panelId} hidden={!expanded}>
        {expanded ? (
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/30 p-4 sm:p-5">
            <FareFamilyMatrix fares={group.offers} formatMoney={formatMoney} onQuote={onQuote} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
