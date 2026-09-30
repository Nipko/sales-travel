'use client';

import { ArrowLeft, Clock, Globe2, MapPin, RefreshCw, Star } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../../../../components/ui/card';
import { cn } from '../../../../../lib/cn';
import type { HotelProviderHotelRef } from '../../_components/hotel-key';
import { readSearchHandoff, type SearchHandoff } from '../../_components/hotel-search-handoff';
import { countryNamer } from '../../_components/nationality-field';
import {
  hotelContentAction,
  hotelRatesAction,
  type HotelContentResult,
  type HotelDetailRatesResult,
} from '../actions';
import {
  ArrivalCard,
  ContactCard,
  EmptyContent,
  HotelDescription,
  LocationCard,
} from './hotel-content-sections';
import {
  addressLine,
  contentLanguageNote,
  hasArrivalInfo,
  hasContactInfo,
  hasDescriptiveContent,
  mapsUrl,
} from './hotel-content-view';
import { refsToWarm, rereadContent, warmHotelContent } from './hotel-content-warmup';
import { HotelDetailRates, RatesNeedSearch, RatesSkeleton } from './hotel-detail-rates';
import {
  contentToShow,
  detailHeader,
  factsByProvider,
  hotelLocationView,
  stayHoursLine,
  stayNights,
  staySummary,
} from './hotel-detail-view';
import { GallerySkeleton, HotelGallery } from './hotel-gallery';

/*
 * El detalle de un hotel (U-05 en el portal): la ficha del proveedor que puso nombre a la tarjeta
 * (o, si ése no tiene, la de otro que lo vende) y las tarifas de todos, pedidas a la vez. La ficha
 * no espera a las tarifas ni al revés: el contenido acompaña a la venta, no la frena (principio 1).
 *
 * Si la ficha llega sin fotos, se buscan en el proveedor en segundo plano (hotel-content-warmup):
 * la galería dice que las está buscando y aparecen cuando llegan, sin frenar nada más.
 */

const CONTENT_UNREADABLE: HotelContentResult = {
  ok: false,
  outcomes: [],
  error: 'No pudimos cargar la ficha del hotel.',
};

const RATES_UNREACHABLE: HotelDetailRatesResult = {
  ok: false,
  outcomes: [],
  error: 'No pudimos conectar para traer las tarifas. Revisa tu conexión e intenta de nuevo.',
};

interface HotelDetailProps {
  hotelKey: string;
  refs: readonly HotelProviderHotelRef[];
  /** La búsqueda desde la que se abrió, o nada si se llegó por un enlace. */
  searchToken?: string;
}

/** Las fotos de la ficha en el proveedor: sin buscar, buscándose o ya buscadas. */
type PhotoSearch = 'idle' | 'searching' | 'done';

export function HotelDetail({ hotelKey, refs, searchToken }: HotelDetailProps) {
  const [content, setContent] = useState<HotelContentResult | undefined>(undefined);
  const [photoSearch, setPhotoSearch] = useState<PhotoSearch>('idle');
  // `undefined` mientras no se leyó el almacenamiento; `null` si no hay búsqueda de origen.
  const [handoff, setHandoff] = useState<SearchHandoff | null | undefined>(undefined);
  const [rates, setRates] = useState<HotelDetailRatesResult | undefined>(undefined);
  const [ratesLoading, setRatesLoading] = useState(false);
  // La lectura en curso de la ficha y su búsqueda de fotos: se corta al reintentar o al salir.
  const contentRun = useRef<AbortController | null>(null);

  const loadContent = useCallback(() => {
    contentRun.current?.abort();
    const run = new AbortController();
    contentRun.current = run;
    setContent(undefined);
    setPhotoSearch('idle');
    void (async () => {
      const first = await hotelContentAction(hotelKey).catch(() => CONTENT_UNREADABLE);
      if (run.signal.aborted) return;
      setContent(first);
      const targets = refsToWarm(refs, first);
      if (targets.length === 0) return;
      setPhotoSearch('searching');
      const outcome = await warmHotelContent(targets, run.signal);
      if (run.signal.aborted) return;
      if (outcome === 'ready') {
        // Ya quedó en el catálogo: la ficha se vuelve a leer, ahora con sus fotos.
        const next = await hotelContentAction(hotelKey).catch(() => undefined);
        if (run.signal.aborted) return;
        setContent((prev) => rereadContent(refs, prev ?? first, next));
      }
      setPhotoSearch('done');
    })().catch(() => {
      // Las fotos acompañan a la ficha: si algo falla al buscarlas, la ficha queda como estaba.
      if (!run.signal.aborted) setPhotoSearch('done');
    });
  }, [hotelKey, refs]);

  useEffect(() => () => contentRun.current?.abort(), []);

  const loadRates = useCallback(
    (from: SearchHandoff) => {
      setRatesLoading(true);
      hotelRatesAction(hotelKey, from.stay)
        .then(setRates)
        .catch(() => setRates(RATES_UNREACHABLE))
        .finally(() => setRatesLoading(false));
    },
    [hotelKey],
  );

  useEffect(() => {
    loadContent();
    const found = searchToken === undefined ? undefined : readSearchHandoff(searchToken);
    setHandoff(found ?? null);
    if (found !== undefined) loadRates(found);
  }, [loadContent, loadRates, searchToken]);

  const header = detailHeader(refs, content, rates);
  const facts = useMemo(() => factsByProvider(refs, content, rates), [refs, content, rates]);
  const primary = refs[0];
  const primaryContent = content?.outcomes.find(
    (o) => o.ref.provider === primary?.provider,
  )?.content;
  // Sin la ficha del primer hotel no se muestra la de otro proveedor: nombre y fotos podrían no
  // ser los del hotel de la tarjeta. Se dice que falló y se puede reintentar.
  const shown = contentToShow(refs, content);
  const contentError =
    content === undefined || primaryContent !== undefined
      ? undefined
      : (content.error ?? CONTENT_UNREADABLE.error);
  const loadingHeader = content === undefined && rates === undefined;
  const address = primaryContent?.address ? addressLine(primaryContent) : (header.address ?? null);
  const stars = header.stars ? Math.min(5, Math.round(header.stars)) : 0;
  const languageNote = shown ? contentLanguageNote(shown) : undefined;
  const hasContent = shown !== undefined && hasDescriptiveContent(shown);
  const searchingPhotos = photoSearch === 'searching';
  const nameCountry = useMemo(() => countryNamer('es'), []);
  const location = hotelLocationView(header, primaryContent, nameCountry);
  const hasArrival = shown !== undefined && hasArrivalInfo(shown);
  const hasContact = shown !== undefined && hasContactInfo(shown);
  const hasAside = hasArrival || hasContact || location !== undefined;
  const hours = shown === undefined ? undefined : stayHoursLine(shown);

  // El detalle se abre en otra pestaña para comparar hoteles: con el título del panel en todas,
  // las pestañas no se distinguen entre sí.
  const headerName = header.name;
  useEffect(() => {
    if (loadingHeader) return;
    const previous = document.title;
    document.title = `${headerName} · Hoteles`;
    return () => {
      document.title = previous;
    };
  }, [loadingHeader, headerName]);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <nav aria-label="Ruta">
        <Link
          href="/hoteles"
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Hoteles
        </Link>
      </nav>

      <header className="space-y-1.5">
        {loadingHeader ? (
          <>
            <h1 className="sr-only">Cargando hotel…</h1>
            <div
              aria-hidden="true"
              className="h-6 w-64 max-w-full animate-pulse rounded bg-[var(--color-surface-muted)]"
            />
            <div
              aria-hidden="true"
              className="h-4 w-80 max-w-full animate-pulse rounded bg-[var(--color-surface-muted)]"
            />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
                {header.name}
              </h1>
              {stars > 0 ? (
                <span className="flex items-center gap-0.5 text-[var(--color-accent)]">
                  {Array.from({ length: stars }, (_, i) => (
                    <Star key={i} aria-hidden="true" className="size-3.5 fill-current" />
                  ))}
                  <span className="sr-only">
                    {stars} estrella{stars === 1 ? '' : 's'}
                  </span>
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-fg-muted)]">
              {address ? (
                <span className="inline-flex items-start gap-1">
                  <MapPin aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                  {address}
                </span>
              ) : null}
              {/* A la vista: es lo primero que pregunta el cliente, y en el teléfono la tarjeta de
                  llegada queda debajo de las tarifas. */}
              {hours ? (
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Clock aria-hidden="true" className="size-3 shrink-0" />
                  {hours}
                </span>
              ) : null}
              {header.location ? (
                <a
                  href={mapsUrl(header.location)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                >
                  Ver en el mapa
                  <span className="sr-only"> (se abre en otra pestaña)</span>
                </a>
              ) : null}
            </div>
          </>
        )}
      </header>

      {content === undefined ? <GallerySkeleton searching={false} /> : null}
      {shown !== undefined && shown.images.length > 0 ? (
        <HotelGallery
          key={`${shown.providerCode}:${shown.hotelId}`}
          images={shown.images}
          name={header.name}
        />
      ) : searchingPhotos ? (
        <GallerySkeleton searching />
      ) : null}

      {/* Las tarifas a todo el ancho: son lo que el vendedor viene a mirar, y sus políticas se
          leen mejor sin columna al lado. */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-1 border-b border-[var(--color-border)] px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">Tarifas</h2>
          {handoff ? <StayLine handoff={handoff} /> : null}
        </div>
        {handoff === undefined ? <RatesSkeleton /> : null}
        {handoff === null ? <RatesNeedSearch /> : null}
        {handoff ? (
          <HotelDetailRates
            hotelKey={hotelKey}
            searchToken={searchToken}
            stay={handoff.stay}
            nights={stayNights(handoff.stay)}
            showProvider={handoff.showProviderInResults}
            rates={rates}
            loading={ratesLoading}
            onReload={() => loadRates(handoff)}
            facts={facts}
            shownFacts={{
              ...(header.name ? { name: header.name } : {}),
              ...(header.address ? { address: header.address } : {}),
            }}
          />
        ) : null}
      </Card>

      {contentError ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{contentError}</p>
          <button
            type="button"
            onClick={loadContent}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Reintentar
          </button>
        </div>
      ) : null}

      {shown !== undefined || location !== undefined ? (
        <div
          className={cn(
            'grid grid-cols-1 gap-5 lg:items-start',
            hasAside && 'lg:grid-cols-[minmax(0,1fr)_300px]',
          )}
        >
          {/* Primero en el DOM: en el teléfono, horarios e instrucciones de llegada (depósito,
              documento) van antes que la descripción; en escritorio, a la derecha. */}
          {hasAside ? (
            <aside
              className="space-y-5 lg:col-start-2 lg:row-start-1"
              aria-label="Llegada, ubicación y contacto"
            >
              {shown !== undefined && hasArrival ? <ArrivalCard content={shown} /> : null}
              {location !== undefined ? <LocationCard view={location} /> : null}
              {shown !== undefined && hasContact ? <ContactCard content={shown} /> : null}
            </aside>
          ) : null}
          <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-start-1">
            {languageNote ? (
              <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
                <Globe2 aria-hidden="true" className="size-3.5 shrink-0" />
                {languageNote}
              </p>
            ) : null}
            {/* Mientras se buscan en el proveedor, "no tiene fotos ni descripción" sería falso. */}
            {shown === undefined ? null : hasContent ? (
              <HotelDescription content={shown} />
            ) : searchingPhotos ? null : (
              <EmptyContent />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Con qué estadía se cotiza, a la vista: la nacionalidad cambia el precio (D-TBO-14 A). */
function StayLine({ handoff }: { handoff: SearchHandoff }) {
  const summary = useMemo(() => staySummary(handoff.stay, countryNamer('es')), [handoff]);
  return (
    <p className="text-[11px] text-[var(--color-fg-muted)]">
      <span className="font-medium text-[var(--color-fg)]">{summary.dates}</span> ·{' '}
      {summary.details} · Nacionalidad: {summary.nationality}
      {summary.currency ? ` · Moneda: ${summary.currency}` : null}
    </p>
  );
}
