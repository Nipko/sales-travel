/** Lo mínimo de un itinerario para saber de dónde sale y a dónde llega. */
interface LegLike {
  readonly segments: readonly { readonly origin: string; readonly destination: string }[];
}

function endpoints(leg: LegLike | undefined): { from?: string; to?: string } {
  const first = leg?.segments[0];
  const last = leg?.segments[leg.segments.length - 1];
  return { ...(first ? { from: first.origin } : {}), ...(last ? { to: last.destination } : {}) };
}

/**
 * ¿Es una ida y vuelta de verdad? Dos tramos, y el segundo vuelve exactamente de donde llegó el
 * primero al punto de partida. Un multidestino de dos tramos (open jaw: BOG→MIA, MEX→BOG) NO lo es,
 * y llamarlo «Ida/Vuelta» le diría al cliente que regresa de donde no está.
 */
export function isRoundTripLegs(legs: readonly LegLike[]): boolean {
  if (legs.length !== 2) return false;
  const ida = endpoints(legs[0]);
  const vuelta = endpoints(legs[1]);
  return ida.from !== undefined && ida.from === vuelta.to && ida.to === vuelta.from;
}

/** El rótulo de un tramo: «Ida»/«Vuelta» en ida y vuelta, «Tramo n» en multidestino, nada en solo ida. */
export function legLabel(legs: readonly LegLike[], index: number): string | undefined {
  if (legs.length <= 1) return undefined;
  if (isRoundTripLegs(legs)) return index === 0 ? 'Ida' : 'Vuelta';
  return `Tramo ${String(index + 1)}`;
}
