'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadMoreHotelsAction, type HotelOffer, type HotelSearchResult } from '../actions';
import {
  canLoadMore,
  moreArrived,
  moreLoading,
  moreStateFor,
  type MoreHotelsResult,
  type MoreState,
} from './hotel-paging';

const CONNECTION_FAILED: MoreHotelsResult = {
  ok: false,
  hotels: [],
  providers: [],
  error: 'No pudimos traer más hoteles. Revisa tu conexión e intenta de nuevo.',
};

/**
 * Los tramos siguientes de una búsqueda (hotel-paging.ts): lo que ya llegó, sumado a la búsqueda,
 * y cómo pedir el siguiente. Una búsqueda nueva empieza de cero, y la respuesta de un tramo que
 * llega después de otra búsqueda no se mezcla con ella.
 */
export function useMoreHotels(search: HotelSearchResult): {
  more: MoreState;
  hotels: readonly HotelOffer[];
  loadMore: () => void;
} {
  const [state, setState] = useState<MoreState>(() => moreStateFor(search));
  // Una búsqueda nueva reinicia en el mismo render (el patrón de React para reiniciar estado
  // cuando cambia una prop): nunca se ven los tramos de la búsqueda anterior.
  let more = state;
  if (state.forSearch !== search) {
    more = moreStateFor(search);
    setState(more);
  }

  const latest = useRef(more);
  useEffect(() => {
    latest.current = more;
  });
  const inFlight = useRef<HotelSearchResult | null>(null);

  const loadMore = useCallback(() => {
    const current = latest.current;
    const sessionId = current.paging?.sessionId;
    if (!canLoadMore(current) || sessionId === undefined) return;
    const forSearch = current.forSearch;
    if (inFlight.current === forSearch) return;
    inFlight.current = forSearch;
    const page = current.nextPage;
    setState((prev) => (prev.forSearch === forSearch ? moreLoading(prev) : prev));
    void loadMoreHotelsAction(sessionId, page)
      .catch(() => CONNECTION_FAILED)
      .then((res) => {
        if (inFlight.current === forSearch) inFlight.current = null;
        setState((prev) => (prev.forSearch === forSearch ? moreArrived(prev, res) : prev));
      });
  }, []);

  const hotels = useMemo(
    () => (more.hotels.length === 0 ? search.hotels : [...search.hotels, ...more.hotels]),
    [search.hotels, more.hotels],
  );

  return { more, hotels, loadMore };
}
