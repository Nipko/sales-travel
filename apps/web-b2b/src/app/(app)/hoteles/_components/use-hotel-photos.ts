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

interface Generation {
  readonly hotels: readonly ResultHotel[];
  readonly states: ReadonlyMap<string, PhotoState>;
}

function initial(hotels: readonly ResultHotel[]): Generation {
  return { hotels, states: new Map(hotels.map((h) => [h.key, initialPhotoState(h.offer)])) };
}

/**
 * El estado de la foto de cada tarjeta, por su clave. `order` son las claves en el orden en que se
 * ven (ya filtradas y ordenadas): lo que el vendedor tiene delante se pide primero.
 */
export function useHotelPhotos(
  hotels: readonly ResultHotel[],
  order: readonly string[],
): ReadonlyMap<string, PhotoState> {
  const [gen, setGen] = useState<Generation>(() => initial(hotels));
  // Una búsqueda nueva empieza de cero, en el mismo render (el patrón de React para reiniciar
  // estado cuando cambia una prop): nunca se ve la foto de un hotel de la búsqueda anterior.
  let current = gen;
  if (gen.hotels !== hotels) {
    current = initial(hotels);
    setGen(current);
  }

  const targets = useMemo(() => {
    const byKey = new Map<string, PhotoTarget>(
      hotels.map((h) => [h.key, { key: h.key, refs: photoRefsOf(h.offer) }]),
    );
    return order.flatMap((key) => byKey.get(key) ?? []);
  }, [hotels, order]);

  const inFlight = useRef(0);
  const [wake, setWake] = useState(0);

  // Los pedidos de una búsqueda se cortan cuando llega otra o se cierra la pantalla.
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const own = new AbortController();
    controller.current = own;
    inFlight.current = 0;
    return () => own.abort();
  }, [hotels]);

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
        prev.hotels !== hotels
          ? prev
          : {
              hotels,
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
            prev.hotels !== hotels
              ? prev
              : {
                  hotels,
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
  }, [current, hotels, targets, wake]);

  return current.states;
}
