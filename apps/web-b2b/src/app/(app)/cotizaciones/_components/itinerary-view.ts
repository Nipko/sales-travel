/**
 * Modelo de vista de un itinerario: todo lo que la fila de resultados necesita DECIDIR
 * antes de pintar, separado del JSX para poder probarlo.
 *
 * El origen del problema es que la línea de tiempo se pintaba idéntica para un directo y
 * para uno de dos escalas: el único rastro de la escala era un texto de 9 px. Acá se
 * calcula lo que hace falta para que la línea CODIFIQUE las escalas —una marca por escala,
 * ubicada por tiempo transcurrido— y para que una escala que compromete la venta (larga,
 * corta, o con cambio de aeropuerto) se vea antes de cotizar.
 */

/**
 * Debajo de esto una conexión es riesgosa: en LATAM los mínimos de conexión internacional
 * rondan los 60-90 min y los domésticos los 40. Se prefiere una alarma de más —el vendedor
 * verifica— a una conexión imposible vendida en silencio.
 */
export const TIGHT_LAYOVER_MINUTES = 45;

/** A partir de tres horas la espera deja de ser un trámite y pasa a ser una objeción de venta. */
export const LONG_LAYOVER_MINUTES = 180;

export interface ItinerarySegmentInput {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
}

export interface ItineraryInput {
  segments: ItinerarySegmentInput[];
  totalDurationMinutes: number;
  stops: number;
}

/** Motivo por el que una escala merece la atención del vendedor. */
export type LayoverAlert = 'tight' | 'long' | 'airport-change';

export interface LayoverView {
  /** Aeropuerto donde aterriza el tramo previo. */
  arrivalAirport: string;
  /** Aeropuerto desde donde despega el tramo siguiente; distinto = traslado por tierra. */
  departureAirport: string;
  /** Espera en tierra en minutos. Nunca negativa. */
  minutes: number;
  alerts: LayoverAlert[];
  /**
   * Posición sobre la línea, 0 = salida, 1 = llegada. NO es exactamente la fracción de
   * tiempo transcurrido: se remapea a una banda interior y se separa de sus vecinas para
   * que las marcas no se pisen entre sí ni con los extremos. Conserva el orden y la
   * proporción relativa dentro de esa banda; no sirve para medir, sirve para leer.
   */
  position: number;
}

export interface ItineraryView {
  /**
   * El conteo que se muestra: el mayor entre lo que declara el proveedor y las conexiones
   * que sabemos nombrar. Cuando discrepan —el proveedor cuenta escalas técnicas que no
   * parten el itinerario en dos tramos— el texto se queda con el número alto y el gráfico
   * marca sólo las que puede ubicar: muestra de menos, nunca de más, y nunca se contradicen.
   */
  stops: number;
  /** Una por conexión entre tramos consecutivos, ya con su posición sobre la línea. */
  layovers: LayoverView[];
  /** Alguna escala tiene alerta: la fila puede destacarlo sin recorrer el arreglo. */
  hasAlert: boolean;
  /** Días de calendario local entre la salida del primer tramo y la llegada del último. */
  arrivalDayOffset: number;
}

/** Extremos de la banda donde pueden caer las marcas, para no chocar con los puntos de punta. */
const BAND_START = 0.14;
const BAND_END = 0.86;
/** Separación mínima entre marcas para que dos escalas seguidas se lean como dos. */
const MIN_GAP = 0.11;

const DAY_MS = 86_400_000;

function timeOf(iso: string): number {
  return new Date(iso).getTime();
}

/** Medianoche local del día del ISO, para comparar días de calendario y no bloques de 24 h. */
function localMidnight(iso: string): number {
  const d = new Date(iso);
  const t = d.getTime();
  if (!Number.isFinite(t)) return Number.NaN;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Días de calendario local entre dos instantes. Se compara medianoche contra medianoche
 * —no la diferencia en horas— porque un vuelo de 21:50 a 00:40 cruza el día con menos de
 * tres horas de vuelo, y ese `+1` es justo el dato que el vendedor no puede pasar por alto.
 */
export function dayOffset(fromIso: string, toIso: string): number {
  const a = localMidnight(fromIso);
  const b = localMidnight(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/**
 * Acomoda posiciones crudas (0..1) dentro de la banda visible respetando una separación
 * mínima. Empuja hacia adelante, después corrige hacia atrás si se pasó del final, y si ni
 * así entran reparte parejo: preferimos perder la proporción antes que superponer marcas,
 * porque una marca tapada es una escala que el vendedor no ve.
 */
export function spreadPositions(raw: number[]): number[] {
  const n = raw.length;
  if (n === 0) return [];

  const span = BAND_END - BAND_START;
  const evenly = (): number[] =>
    Array.from({ length: n }, (_, i) => BAND_START + (span * (i + 1)) / (n + 1));

  const out = raw.map((p) => {
    const clamped = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5;
    return BAND_START + clamped * span;
  });

  for (let i = 1; i < n; i += 1) {
    out[i] = Math.max(out[i]!, out[i - 1]! + MIN_GAP);
  }
  if (out[n - 1]! > BAND_END) {
    out[n - 1] = BAND_END;
    for (let i = n - 2; i >= 0; i -= 1) {
      out[i] = Math.min(out[i]!, out[i + 1]! - MIN_GAP);
    }
    if (out[0]! < BAND_START) return evenly();
  }
  return out;
}

function alertsFor(minutes: number, changesAirport: boolean): LayoverAlert[] {
  const alerts: LayoverAlert[] = [];
  if (changesAirport) alerts.push('airport-change');
  if (minutes < TIGHT_LAYOVER_MINUTES) alerts.push('tight');
  else if (minutes >= LONG_LAYOVER_MINUTES) alerts.push('long');
  return alerts;
}

export function buildItineraryView(itinerary: ItineraryInput): ItineraryView {
  const segments = itinerary.segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) {
    return { stops: itinerary.stops, layovers: [], hasAlert: false, arrivalDayOffset: 0 };
  }

  const start = timeOf(first.departureAt);
  const end = timeOf(last.arrivalAt);
  const total = end - start;
  // Sin duración utilizable no hay proporción que respetar; `spreadPositions` reparte parejo.
  const usableSpan = Number.isFinite(total) && total > 0;

  const connections = segments.slice(0, -1).map((seg, i) => {
    const next = segments[i + 1]!;
    const gap = timeOf(next.departureAt) - timeOf(seg.arrivalAt);
    const minutes = Number.isFinite(gap) ? Math.max(0, Math.round(gap / 60_000)) : 0;
    const arrivedAt = timeOf(seg.arrivalAt);
    return {
      arrivalAirport: seg.destination,
      departureAirport: next.origin,
      minutes,
      raw: usableSpan && Number.isFinite(arrivedAt) ? (arrivedAt - start) / total : 0.5,
    };
  });

  const positions = spreadPositions(connections.map((c) => c.raw));

  const layovers: LayoverView[] = connections.map((c, i) => ({
    arrivalAirport: c.arrivalAirport,
    departureAirport: c.departureAirport,
    minutes: c.minutes,
    alerts: alertsFor(c.minutes, c.arrivalAirport !== c.departureAirport),
    position: positions[i] ?? 0.5,
  }));

  return {
    stops: Math.max(itinerary.stops, layovers.length),
    layovers,
    hasAlert: layovers.some((l) => l.alerts.length > 0),
    arrivalDayOffset: dayOffset(first.departureAt, last.arrivalAt),
  };
}

export interface CarrierSummary {
  /** Aerolínea del primer tramo: la que el vendedor nombra primero. */
  main: string;
  /** Códigos distintos en orden de aparición; más de uno = itinerario interlínea. */
  carriers: string[];
  /** Número de vuelo del primer tramo, ya legible: "AV 8020". */
  firstFlight: string;
}

export function summarizeCarriers(itineraries: ItineraryInput[]): CarrierSummary {
  const segments = itineraries.flatMap((it) => it.segments);
  const first = segments[0];
  const carriers = [...new Set(segments.map((s) => s.carrier).filter(Boolean))];
  return {
    main: first?.carrier ?? carriers[0] ?? '',
    carriers,
    firstFlight: first ? `${first.carrier} ${first.flightNumber}` : '',
  };
}

/**
 * Texto de la escala tal como lo lee el vendedor. Se arma acá y no en el JSX porque la
 * regla —qué alerta gana cuando hay varias— es una decisión, no una plantilla.
 *
 * `formatDuration` entra por parámetro: la página ya es dueña del formato de duración.
 */
export function layoverLabel(
  layover: LayoverView,
  formatDuration: (minutes: number) => string,
): string {
  const changesAirport = layover.alerts.includes('airport-change');
  const where = changesAirport
    ? `${layover.arrivalAirport} → ${layover.departureAirport}`
    : layover.arrivalAirport;
  const time = formatDuration(layover.minutes);
  // El cambio de aeropuerto manda: obliga a un traslado por tierra y ya se ve en `where`.
  if (changesAirport) return `${where} ${time} · cambio de aeropuerto`;
  if (layover.alerts.includes('tight')) return `${where} ${time} · conexión corta`;
  if (layover.alerts.includes('long')) return `${where} ${time} · escala larga`;
  return `${where} ${time}`;
}
