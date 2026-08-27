'use client';

import { AlertTriangle, FileText, Search, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { advancesFocus, type AirportChangeReason } from '../../../components/ui/airport-combobox';
import { Button } from '../../../components/ui/button';
import {
  DateRangePicker,
  todayIso,
  type DateRange,
  type TripMode,
} from '../../../components/ui/date-range-picker';
import {
  searchFlightsAction,
  type Offer,
  type ProviderOutcome,
  type SearchResult,
} from './actions';
import { createQuotationAction } from './quotation-actions';
import { FlightRow, type FlightGroup } from './_components/flight-row';
import {
  applyFlightFilters,
  EMPTY_FILTERS,
  FlightFilters,
  type FlightFilterState,
} from './_components/flight-filters';
import { PaxField } from './_components/pax-field';
import { ResultsHeader } from './_components/results-header';
import { RouteField } from './_components/route-field';
import {
  DEFAULT_CABIN,
  DEFAULT_PAX,
  returnDateForMode,
  searchEcho,
  validateSearch,
  type PaxCounts,
  type SearchDraft,
  type SearchField,
  type SearchProblem,
} from './_components/search-form-model';
import { CabinSelect, TripModeSwitch } from './_components/search-options';
import { SkeletonFlightRow } from './_components/skeleton-flight-row';
import type { SortKey } from './_components/sort-toggle';

const initialState: SearchResult = { ok: true, offers: [], providers: [] };

/** Ids estables: son la forma de llevar el foco al campo que falta cuando la búsqueda no sale. */
const FIELD_ID: Readonly<Record<SearchField, string>> = {
  origin: 'search-origin',
  destination: 'search-destination',
  dates: 'search-dates',
};
const PAX_ID = 'search-pax';

/** Qué proveedores devolvieron tarifas inventadas en esta búsqueda. */
type SimulatedProviders =
  | { readonly kind: 'all' }
  | { readonly kind: 'codes'; readonly codes: ReadonlySet<string> };

/**
 * Si el sobre no trae `providers[]` —un API anterior al fan-out— se cae al flag global con
 * su semántica vieja: `true` = TODO el resultado es falso. Nunca al revés: la ausencia del
 * parte de daños no se puede leer como "ninguna tarifa es simulada", que es justo el error
 * que dejaría a un vendedor pasándole precios inventados a un cliente.
 */
function simulatedProviders(result: SearchResult): SimulatedProviders {
  if (result.providers.length === 0) {
    return result.simulated === true ? { kind: 'all' } : { kind: 'codes', codes: new Set() };
  }
  return {
    kind: 'codes',
    codes: new Set(result.providers.filter((p) => p.simulated).map((p) => p.code)),
  };
}

function isSimulatedOffer(offer: Offer, simulated: SimulatedProviders): boolean {
  return simulated.kind === 'all' || simulated.codes.has(offer.provider.name);
}

/**
 * El botón que manda.
 *
 * Es el elemento con más peso de la pantalla —alto de talón, ancho propio, el único relleno
 * con el color de marca— porque es el único que hace avanzar la venta. Todo lo demás en esta
 * pantalla es preparar este clic.
 */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      className="h-14 w-full gap-2 rounded-xl px-7 text-[15px] font-semibold xl:w-auto"
    >
      {pending ? (
        <>
          <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          Buscando…
        </>
      ) : (
        <>
          <Search className="size-4" />
          Buscar
        </>
      )}
    </Button>
  );
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function groupOffersByFlight(offers: Offer[]): FlightGroup[] {
  const groups = new Map<string, Offer[]>();

  for (const offer of offers) {
    if (!offer.itineraries?.length) continue;
    const key = offer.itineraries
      .map((it) =>
        it.segments.map((s) => `${s.carrier}${s.flightNumber}-${s.departureAt}`).join('|'),
      )
      .join('//');
    const existing = groups.get(key);
    if (existing) existing.push(offer);
    else groups.set(key, [offer]);
  }

  return Array.from(groups.entries()).map(([key, groupOffers]) => ({
    key,
    offers: groupOffers.sort((a, b) => a.total.amountMinor - b.total.amountMinor),
  }));
}

function sortGroups(groups: FlightGroup[], sort: SortKey): FlightGroup[] {
  const sorted = [...groups];
  sorted.sort((a, b) => {
    const offerA = a.offers[0]!;
    const offerB = b.offers[0]!;
    const itA = offerA.itineraries?.[0];
    const itB = offerB.itineraries?.[0];
    switch (sort) {
      case 'price':
        return offerA.total.amountMinor - offerB.total.amountMinor;
      case 'duration':
        return (itA?.totalDurationMinutes ?? 0) - (itB?.totalDurationMinutes ?? 0);
      case 'departure': {
        const depA = itA?.segments[0]?.departureAt ?? '';
        const depB = itB?.segments[0]?.departureAt ?? '';
        return depA.localeCompare(depB);
      }
      case 'best': {
        const priceScore =
          (offerA.total.amountMinor - offerB.total.amountMinor) /
          Math.max(offerA.total.amountMinor, 1);
        const durScore =
          ((itA?.totalDurationMinutes ?? 0) - (itB?.totalDurationMinutes ?? 0)) /
          Math.max(itA?.totalDurationMinutes ?? 1, 1);
        const stopScore = (itA?.stops ?? 0) - (itB?.stops ?? 0);
        return priceScore * 0.5 + durScore * 0.3 + stopScore * 0.2;
      }
      default:
        return 0;
    }
  });
  return sorted;
}

export default function CotizacionesPage() {
  const router = useRouter();
  const [result, formAction] = useActionState(searchFlightsAction, initialState);
  const today = useMemo(() => todayIso(), []);
  const [hasSearched, setHasSearched] = useState(false);
  const [sort, setSort] = useState<SortKey>('best');
  const [filters, setFilters] = useState<FlightFilterState>(EMPTY_FILTERS);
  const resultsRef = useRef<HTMLDivElement>(null);

  const [tripMode, setTripMode] = useState<TripMode>('roundtrip');
  const [departureDate, setDepartureDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [originCode, setOriginCode] = useState('');
  const [destinationCode, setDestinationCode] = useState('');
  const [pax, setPax] = useState<PaxCounts>(DEFAULT_PAX);
  const [cabin, setCabin] = useState(DEFAULT_CABIN);
  const [problem, setProblem] = useState<SearchProblem | null>(null);
  const [quoteError, setQuoteError] = useState('');
  /** Qué se está buscando, congelado al enviar: si el usuario sigue tocando, el eco no miente. */
  const [echo, setEcho] = useState('');

  const draft = useMemo<SearchDraft>(
    () => ({
      origin: originCode,
      destination: destinationCode,
      departureDate,
      returnDate,
      mode: tripMode,
      pax,
    }),
    [originCode, destinationCode, departureDate, returnDate, tripMode, pax],
  );

  function handleSwap() {
    setOriginCode(destinationCode);
    setDestinationCode(originCode);
    setProblem(null);
  }

  function handleTripMode(mode: TripMode) {
    setTripMode(mode);
    setReturnDate((current) => returnDateForMode(current, mode));
    setProblem(null);
  }

  function handleDates(range: DateRange) {
    setDepartureDate(range.start ?? '');
    setReturnDate(range.end ?? '');
    setProblem(null);
  }

  /**
   * Lleva el foco al campo indicado, en el acto.
   *
   * Sólo se llama tras una elección inequívoca —elegir un aeropuerto de la lista, o pulsar
   * Buscar con un campo mal— nunca mientras alguien escribe. Ese era el bug: `onChange` llega
   * en cada letra y el salto caía en la tercera, con el usuario a medio escribir el código.
   */
  function focusField(id: string) {
    document.getElementById(id)?.focus();
  }

  function handleOriginChange(code: string, reason: AirportChangeReason) {
    setOriginCode(code);
    setProblem(null);
    if (advancesFocus(reason)) focusField(FIELD_ID.destination);
  }

  function handleDestinationChange(code: string, reason: AirportChangeReason) {
    setDestinationCode(code);
    setProblem(null);
    // El siguiente paso es el disparador de fechas, que NO se abre al recibir el foco: quien
    // llega ahí decide si abre el calendario o sigue con Tab.
    if (advancesFocus(reason)) focusField(FIELD_ID.dates);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    setQuoteError('');

    /*
      Los campos del control de fechas y de pasajeros son OCULTOS, y un input oculto no
      participa de la validación nativa del navegador: el `required` que antes frenaba el
      envío ya no existe. Este guardia es el único que queda antes del server action.
    */
    const found = validateSearch(draft, today);
    if (found) {
      e.preventDefault();
      setProblem(found);
      focusField(FIELD_ID[found.field]);
      return;
    }

    setProblem(null);
    setEcho(searchEcho(draft));
    setHasSearched(true);
    // El loader y los resultados aparecen debajo del formulario, fuera del viewport.
    setTimeout(
      () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      60,
    );
  }

  const handleQuote = useCallback(
    async (offer: Offer) => {
      const res = await createQuotationAction(offer, {
        origin: originCode,
        destination: destinationCode,
        departureDate,
        returnDate: returnDate || undefined,
        tripType: tripMode,
        paxCount: { adults: pax.adults, children: pax.children, infants: pax.infants },
        cabin,
        currency: offer.total.currency,
      });
      if (res.ok && res.quotationId) {
        router.push(`/cotizaciones/${res.quotationId}`);
      } else {
        setQuoteError(res.error || 'No se pudo guardar la cotización.');
      }
    },
    [originCode, destinationCode, departureDate, returnDate, tripMode, pax, cabin, router],
  );

  // Los grupos sin filtrar alimentan las OPCIONES de filtro (aerolineas, precio maximo):
  // derivarlas de la lista ya filtrada haria desaparecer las opciones al usarlas.
  const allGroups = useMemo(
    () => sortGroups(groupOffersByFlight(result.offers), sort),
    [result.offers, sort],
  );
  const flightGroups = useMemo(() => applyFlightFilters(allGroups, filters), [allGroups, filters]);

  useEffect(() => {
    setFilters(EMPTY_FILTERS);
  }, [result.offers]);

  const displayError = problem?.message || quoteError || result.error;

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Buscar vuelos
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Tarifas en vivo por conexión directa con los proveedores.
          </p>
        </div>
        <Link
          href="/cotizaciones/guardadas"
          className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
        >
          <FileText className="size-4 text-[var(--color-fg-subtle)]" />
          Cotizaciones guardadas
        </Link>
      </header>

      <form action={formAction} onSubmit={handleSubmit}>
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-sm)] sm:p-5">
          {/* Ajustes: se tocan pocas veces, muestran su valor y se cambian en un clic. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-1">
            <TripModeSwitch value={tripMode} onChange={handleTripMode} />
            <span
              aria-hidden="true"
              className="mx-1 hidden h-4 w-px bg-[var(--color-border-strong)] sm:block"
            />
            <CabinSelect value={cabin} onChange={setCabin} />
          </div>

          {/*
            La franja. Cuatro piezas del mismo alto y el mismo idioma —etiqueta chica arriba,
            valor grande abajo— en el orden en que se dicta un viaje por teléfono: de dónde a
            dónde, cuándo, cuántos. En móvil se apilan; el botón queda último y a lo ancho.
          */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_auto] xl:items-start">
            <div className="sm:col-span-2 xl:col-span-1">
              <RouteField
                originCode={originCode}
                destinationCode={destinationCode}
                onOriginChange={handleOriginChange}
                onDestinationChange={handleDestinationChange}
                onSwap={handleSwap}
                originInputId={FIELD_ID.origin}
                destinationInputId={FIELD_ID.destination}
                autoFocus
              />
            </div>

            <DateRangePicker
              mode={tripMode}
              value={{ start: departureDate || null, end: returnDate || null }}
              onChange={handleDates}
              min={today}
              triggerId={FIELD_ID.dates}
            />

            <PaxField value={pax} onChange={setPax} triggerId={PAX_ID} />

            <div className="sm:col-span-2 xl:col-span-1">
              <SubmitButton />
            </div>
          </div>

          {displayError ? (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 text-sm font-medium text-[var(--color-danger)]"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {displayError}
            </p>
          ) : null}
        </section>

        <div ref={resultsRef} className="scroll-mt-6">
          <SearchResults
            hasSearched={hasSearched}
            echo={echo}
            result={result}
            allGroups={allGroups}
            flightGroups={flightGroups}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            onQuote={handleQuote}
          />
        </div>
      </form>
    </div>
  );
}

/**
 * Degradación parcial: alguien no contestó y la lista está incompleta.
 *
 * Antes esto no se veía en ninguna parte —el fan-out descartaba los fallos— y una búsqueda
 * a la que le faltaba medio catálogo se leía igual que una búsqueda normal, sólo que más
 * corta. El vendedor cotizaba el vuelo caro creyendo que era el único.
 */
function DegradedProvidersNotice({ providers }: { providers: ProviderOutcome[] }) {
  const failed = providers.filter((p) => p.status === 'error');
  if (failed.length === 0) return null;

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/8 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
      <div>
        <strong className="font-semibold">
          Resultados incompletos:{' '}
          {failed.length === 1
            ? 'un proveedor no respondió'
            : `${failed.length} proveedores no respondieron`}
          .
        </strong>{' '}
        Puede haber vuelos y tarifas que no se están mostrando. Volvé a buscar en unos minutos antes
        de darle un precio al cliente.
        <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-fg-muted)]">
          {failed.map((p) => (
            <li key={p.code}>
              <span className="font-medium">{p.code}</span>
              {p.reason ? ` · ${p.reason}` : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Aviso de tarifas simuladas. El detalle por vuelo lo lleva el badge de cada fila; esto
 * dice cuánto del resultado es falso, que es lo que decide si la búsqueda sirve para algo.
 */
function SimulatedFaresNotice({ result }: { result: SearchResult }) {
  const simulated = simulatedProviders(result);
  const total = result.offers.length;
  const fake = result.offers.filter((offer) => isSimulatedOffer(offer, simulated)).length;
  if (fake === 0) return null;

  const todas = fake === total;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2.5 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]" />
      <span>
        <strong className="font-semibold">
          {todas ? 'Tarifas simuladas.' : 'Algunas tarifas son simuladas.'}
        </strong>{' '}
        {todas
          ? 'Faltan credenciales del proveedor para esta agencia, así que estos precios son de prueba y '
          : `${fake} de ${total} tarifas vienen de un proveedor sin credenciales cargadas: están marcadas y `}
        <strong className="font-semibold">no se le pueden cotizar a un cliente</strong>. Cargá las
        credenciales en Mi Red → Credenciales.
      </span>
    </div>
  );
}

function SearchResults({
  hasSearched,
  echo,
  result,
  allGroups,
  flightGroups,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  onQuote,
}: {
  hasSearched: boolean;
  echo: string;
  result: SearchResult;
  allGroups: FlightGroup[];
  flightGroups: FlightGroup[];
  filters: FlightFilterState;
  onFiltersChange: (next: FlightFilterState) => void;
  sort: SortKey;
  onSortChange: (key: SortKey) => void;
  onQuote: (offer: Offer) => Promise<void>;
}) {
  const { pending } = useFormStatus();
  const simulated = useMemo(() => simulatedProviders(result), [result]);

  if (pending) {
    /*
      La espera dice QUÉ se está buscando. Antes había cuatro íconos latiendo —vuelo, hotel,
      traslado, asistencia— que no describían nada de lo que estaba pasando: esta pantalla
      sólo busca vuelos. El eco sirve para algo concreto: quien dictó las fechas de memoria
      las ve escritas, y corta antes si se equivocó de mes.
    */
    return (
      <section className="mt-8">
        <div
          role="status"
          className="mb-4 flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
        >
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]"
          />
          <p className="min-w-0 text-sm">
            <span className="font-semibold text-[var(--color-fg)]">Buscando</span>{' '}
            <span className="text-[var(--color-fg-muted)]">{echo}</span>
          </p>
        </div>
        <div className="space-y-4">
          <SkeletonFlightRow />
          <SkeletonFlightRow />
          <SkeletonFlightRow />
        </div>
      </section>
    );
  }

  // Se entra por allGroups, no por flightGroups: si los filtros excluyen todo, la sección
  // tiene que seguir en pantalla para poder limpiarlos. Con la condición sobre los grupos
  // ya filtrados, la UI de filtros desaparecía junto con los resultados y el usuario
  // quedaba encerrado en un estado vacío que él mismo había provocado.
  if (allGroups.length > 0) {
    return (
      <section className="animate-fade-in-up mt-8">
        <DegradedProvidersNotice providers={result.providers} />
        <SimulatedFaresNotice result={result} />
        <FlightFilters
          groups={allGroups}
          value={filters}
          onChange={onFiltersChange}
          formatMoney={formatMoney}
        />
        <ResultsHeader count={flightGroups.length} sort={sort} onSortChange={onSortChange} />
        {flightGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border-strong)]/60 bg-[var(--color-surface)] px-6 py-12 text-center">
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Ningún vuelo coincide con los filtros
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Hay {allGroups.length} {allGroups.length === 1 ? 'resultado' : 'resultados'} en total.
              Probá quitando algún filtro.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {flightGroups.map((group) => (
              <div key={group.key}>
                {/* El badge acompaña a las tarifas de ESTE vuelo, no a la búsqueda entera:
                    con dos proveedores, uno real y otro sin credenciales, el aviso global
                    o mentía sobre las tarifas buenas o callaba sobre las falsas. */}
                {group.offers.some((offer) => isSimulatedOffer(offer, simulated)) && (
                  <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-2.5 py-1 text-[10px] font-bold text-[var(--color-fg)]">
                    <AlertTriangle className="size-3 shrink-0 text-[var(--color-warning)]" />
                    Tarifa simulada · no cotizable
                  </div>
                )}
                <FlightRow
                  group={group}
                  formatMoney={formatMoney}
                  formatTime={formatTime}
                  formatDate={formatDate}
                  formatDuration={formatDuration}
                  onQuote={onQuote}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (hasSearched && result.ok && !result.error) {
    // El aviso de degradación va TAMBIÉN acá, y sobre todo acá: sin él, "no se encontraron
    // vuelos" es una afirmación falsa cuando el proveedor que los tenía se cayó, y el
    // vendedor se la repite al cliente.
    return (
      <div className="mt-8 animate-fade-in-up">
        <DegradedProvidersNotice providers={result.providers} />
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)]/60 bg-[var(--color-surface)] px-6 py-12 text-center">
          <p className="text-sm font-semibold text-[var(--color-fg)]">
            Ningún vuelo disponible para {echo || 'esta búsqueda'}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
            Probá corriendo las fechas un día, un aeropuerto alternativo de la misma ciudad, o
            cambiando la cabina.
          </p>
        </div>
      </div>
    );
  }

  /*
    Sin búsqueda todavía no va nada. Acá había un recuadro de media pantalla —un avión latiendo
    y «Comience su consulta comercial»— que le explicaba el formulario a alguien que ya lo tiene
    delante y usa esta pantalla veinte veces por día. Su único efecto medible era empujar la
    franja de búsqueda hacia arriba y dejar el resto del alto ocupado por un cartel.
  */
  return null;
}
