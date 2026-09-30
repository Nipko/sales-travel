'use client';

import { ExternalLink, MapPin, Star } from 'lucide-react';
import { mapsUrl } from '../[hotelKey]/_components/hotel-content-view';
import { perNightOf } from './hotel-card-summary';
import { formatMoney } from './hotel-format';
import { HotelPhoto } from './hotel-photo';
import type { PhotoState } from './hotel-photos';
import type { FilteredHotel } from './hotel-results-filters';

/*
 * La vista "Mapa" de los resultados, sin mapa embebido. Un mapa interactivo pide una dependencia
 * nueva y teselas de un tercero: más `img-src`/`connect-src` en la CSP y la posición de cada
 * búsqueda saliendo hacia ese servidor, y las teselas públicas (OpenStreetMap) no admiten el uso de
 * una aplicación comercial sin un proveedor contratado. Hasta que se decida uno, la vista lista los
 * hoteles (con los mismos filtros y el mismo orden) con su dirección o sus coordenadas, y abre cada
 * ubicación en Google Maps, en otra pestaña —lo mismo que ya hace la ficha del hotel—, con las
 * coordenadas del catálogo.
 */

export function HotelResultsMap({
  items,
  photos,
  nights,
}: {
  items: readonly FilteredHotel[];
  photos: ReadonlyMap<string, PhotoState>;
  nights?: number;
}) {
  const located = items.filter((i) => i.hotel.offer.location !== undefined).length;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
        <MapPin
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
        />
        <span>
          {located === items.length
            ? 'Cada hotel se abre en Google Maps, en otra pestaña, con su ubicación del catálogo.'
            : `${located} de ${items.length} hoteles tienen ubicación en el catálogo; se abren en Google Maps, en otra pestaña.`}
        </span>
      </p>
      <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
        {items.map((item) => {
          const { offer, stars, key } = item.hotel;
          const name = offer.name ?? `Hotel ${offer.hotelId}`;
          const cheapest = item.rates[0]?.row.sale;
          const perNight = cheapest ? (perNightOf(cheapest, nights) ?? cheapest) : undefined;
          return (
            <li key={key} className="flex items-center gap-3 px-3 py-3 sm:px-4">
              <HotelPhoto
                state={photos.get(key)}
                sizes="64px"
                className="size-14 shrink-0 rounded-md sm:size-16"
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-1.5 text-sm font-medium text-[var(--color-fg)]">
                  <span className="min-w-0 truncate">{name}</span>
                  {stars > 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-[var(--color-accent)]">
                      <Star aria-hidden="true" className="size-3 fill-current" />
                      <span className="text-xs text-[var(--color-fg-muted)]">
                        {stars}
                        <span className="sr-only"> estrella{stars === 1 ? '' : 's'}</span>
                      </span>
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-[var(--color-fg-muted)]">
                  {offer.address ??
                    (offer.location
                      ? `${offer.location.lat.toFixed(4)}, ${offer.location.lng.toFixed(4)}`
                      : 'Sin ubicación en el catálogo')}
                </p>
                {perNight ? (
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    Desde{' '}
                    <span className="font-semibold tabular-nums text-[var(--color-fg)]">
                      {formatMoney(perNight)}
                    </span>
                    {nights !== undefined && nights >= 1 ? ' por noche' : ' por la estadía'}
                  </p>
                ) : null}
              </div>
              {offer.location ? (
                <a
                  href={mapsUrl(offer.location)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                >
                  <MapPin aria-hidden="true" className="size-3.5" />
                  <span className="hidden sm:inline">Ver en el mapa</span>
                  <span className="sm:hidden">Mapa</span>
                  <ExternalLink aria-hidden="true" className="size-3" />
                  <span className="sr-only"> {name} (se abre en otra pestaña)</span>
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
