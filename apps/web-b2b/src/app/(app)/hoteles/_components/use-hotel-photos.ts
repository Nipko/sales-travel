'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyPhotoBatch,
  failPhotoBatch,
  initialPhotoState,
  markLoading,
  nextPhotoBatch,
  nextPhotoWakeUp,
  photoRefsOf,
  requestPhotoBatch,
  type PhotoState,
  type PhotoTarget,
} from './hotel-photos';
import type { ResultHotel } from './hotel-results-filters';

/*
 * Las fotos de los resultados, pedidas en segundo plano (hotel-photos.ts tiene las reglas). Dos
 * tandas a la vez como mucho: el API ya reparte el cupo del proveedor, y más pedidos simultáneos
 * sólo competirían con la búsqueda siguiente del vendedor.
 */

const MAX_IN_FLIGHT = 2;

export interface PhotoGeneration {
  /** Cambia con cada búsqueda nueva, no cuando la misma suma un tramo. */
  readonly id: number;
  readonly hotels: readonly ResultHotel[];
  readonly states: ReadonlyMap<string, PhotoState>;
}

export function initialPhotoGeneration(
  hotels: readonly ResultHotel[],
  id: number,
): PhotoGeneration {
  return { id, hotels, states: new Map(hotels.map((h) => [h.key, initialPhotoState(h.offer)])) };
}

/**
 * La misma búsqueda con más hoteles al final (un tramo más, docs/tbo/02 §4.4): las fotos que ya
 * llegaron o están en camino se conservan y sólo empiezan de cero las de los hoteles nuevos. Si la
 * lista no empieza con los mismos hoteles, es otra búsqueda: `undefined`.
 */
export function extendedGeneration(
  gen: PhotoGeneration,
  hotels: readonly ResultHotel[],
): PhotoGeneration | undefined {
  if (hotels.length < gen.hotels.length) return undefined;
  for (let i = 0; i < gen.hotels.length; i += 1) {
    const before = gen.hotels[i];
    const now = hotels[i];
    if (before?.key !== now?.key || before?.offer !== now?.offer) return undefined;
  }
  const states = new Map(gen.states);
  for (const h of hotels.slice(gen.hotels.length)) states.set(h.key, initialPhotoState(h.offer));
  return { id: gen.id, hotels, states };
}

/**
 * El estado de la foto de cada tarjeta, por su clave. `order` son las claves de las tarjetas que se
 * VEN, en el orden en que se ven (ya filtradas, ordenadas y sólo las que se muestran): lo que el
 * vendedor tiene delante se pide primero, y lo que todavía no se muestra no se pide.
 */
export function useHotelPhotos(
  hotels: readonly ResultHotel[],
  order: readonly string[],
): ReadonlyMap<string, PhotoState> {
  const [gen, setGen] = useState<PhotoGeneration>(() => initialPhotoGeneration(hotels, 0));
  // Una búsqueda nueva empieza de cero, en el mismo render (el patrón de React para reiniciar
  // estado cuando cambia una prop): nunca se ve la foto de un hotel de la búsqueda anterior. Un
  // tramo más de la misma búsqueda conserva lo que ya estaba.
  let current = gen;
  if (gen.hotels !== hotels) {
    current = extendedGeneration(gen, hotels) ?? initialPhotoGeneration(hotels, gen.id + 1);
    setGen(current);
  }
  const genId = current.id;

  const targets = useMemo(() => {
    const byKey = new Map<string, PhotoTarget>(
      hotels.map((h) => [h.key, { key: h.key, refs: photoRefsOf(h.offer) }]),
    );
    return order.flatMap((key) => byKey.get(key) ?? []);
  }, [hotels, order]);

  const inFlight = useRef(0);
  const [wake, setWake] = useState(0);

  // Los pedidos de una búsqueda se cortan cuando llega otra o se cierra la pantalla; un tramo más
  // de la misma no corta los que están en camino.
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const own = new AbortController();
    controller.current = own;
    inFlight.current = 0;
    return () => own.abort();
  }, [genId]);

  useEffect(() => {
    const own = controller.current;
    if (own === null || own.signal.aborted || current.hotels !== hotels) return;
    const now = Date.now();
    let states = current.states;
    const started: PhotoTarget[][] = [];
    while (inFlight.current + started.length < MAX_IN_FLIGHT) {
      const batch = nextPhotoBatch(targets, states, now);
      if (batch.length === 0) break;
      states = markLoading(states, batch);
      started.push(batch);
    }
    if (started.length > 0) {
      // Sobre el estado MÁS reciente, no sobre el de este render: una respuesta que ya está en la
      // cola no se pisa (markLoading no toca una foto que ya está lista).
      setGen((prev) =>
        prev.id !== genId
          ? prev
          : {
              ...prev,
              states: started.reduce((acc, batch) => markLoading(acc, batch), prev.states),
            },
      );
      for (const batch of started) {
        inFlight.current += 1;
        void requestPhotoBatch(batch, own.signal).then((outcome) => {
          if (own.signal.aborted) return;
          inFlight.current -= 1;
          const at = Date.now();
          setGen((prev) =>
            prev.id !== genId
              ? prev
              : {
                  ...prev,
                  states: outcome.ok
                    ? applyPhotoBatch(prev.states, batch, outcome.reply, at)
                    : failPhotoBatch(
                        prev.states,
                        batch,
                        at,
                        outcome.retryable,
                        outcome.retryAfterMs,
                      ),
                },
          );
        });
      }
      return;
    }
    // Nada para pedir ahora: si queda alguna en espera, despertarse cuando le toque.
    const wakeAt = nextPhotoWakeUp(states);
    if (wakeAt === undefined || inFlight.current > 0) return;
    const id = window.setTimeout(() => setWake((n) => n + 1), Math.max(0, wakeAt - now));
    return () => window.clearTimeout(id);
  }, [current, genId, hotels, targets, wake]);

  return current.states;
}
