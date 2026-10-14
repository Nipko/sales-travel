import {
  dayLabel,
  isIanaTimeZone,
  offsetLabel,
  wallClockIn,
  type WallClock,
} from './ticketing-deadline-clock.js';

/*
 * El aviso de que vence el plazo de emisión de una reserva de vuelo (SAB-14), sin I/O: qué umbral
 * toca y cómo se escribe la hora. El barrido lo ejecuta (`FlightDeadlineAlertService`).
 */

/** Los avisos que salen antes de que venza el plazo: a las 24 h y a las 2 h. */
export const DEADLINE_ALERT_THRESHOLDS = ['24h', '2h'] as const;
export type DeadlineAlertThreshold = (typeof DEADLINE_ALERT_THRESHOLDS)[number];

const HOUR_MS = 60 * 60 * 1000;

/** Cuánto antes del plazo se abre cada aviso. */
export const DEADLINE_ALERT_WINDOW_MS: Readonly<Record<DeadlineAlertThreshold, number>> = {
  '24h': 24 * HOUR_MS,
  '2h': 2 * HOUR_MS,
};

/** Lo que el barrido sabe del plazo de una orden y de los avisos que ya salieron. */
export interface DeadlineAlertState {
  readonly deadlineAt: Date;
  readonly alerted24hAt: Date | null;
  readonly alerted2hAt: Date | null;
}

/**
 * El aviso que toca mandar ahora, o `null`.
 *
 * - Un plazo vencido no se avisa: la aerolínea ya la canceló o está por hacerlo, y la reserva no se
 *   cancela sola aquí; la próxima lectura lo refleja.
 * - Dentro de las 2 h, el de 2 h si no salió. El de 24 h ya no: llegaría con una hora que asusta
 *   menos de lo que corresponde.
 * - Dentro de las 24 h, el de 24 h si no salió ninguno. Una reserva que nace con menos de 24 h de
 *   plazo lo recibe en el primer barrido.
 *
 * La granularidad es la del barrido (15 min): el de 2 h sale entre las 2 h y la 1 h 45 antes.
 */
export function dueDeadlineAlert(
  state: DeadlineAlertState,
  now: number,
): DeadlineAlertThreshold | null {
  const remaining = state.deadlineAt.getTime() - now;
  if (!(remaining > 0)) return null;
  if (remaining <= DEADLINE_ALERT_WINDOW_MS['2h']) {
    return state.alerted2hAt === null ? '2h' : null;
  }
  if (remaining <= DEADLINE_ALERT_WINDOW_MS['24h']) {
    return state.alerted24hAt === null && state.alerted2hAt === null ? '24h' : null;
  }
  return null;
}

/** De quién es la hora con que se escribe el aviso. */
export type DeadlineClockSource = 'agency' | 'office' | 'utc';

/** Una hora del plazo, lista para escribir. */
export interface DeadlineClockLine {
  /** «jue 15 oct». */
  readonly day: string;
  /** «18:00». */
  readonly time: string;
  /** «GMT-5». */
  readonly offset: string;
}

/** Cómo se escribe el plazo en el aviso. */
export interface DeadlineAlertClock extends DeadlineClockLine {
  readonly source: DeadlineClockSource;
  /** «hoy», «mañana» o «el jue 15 oct», en la hora de {@link source}. */
  readonly when: string;
  /**
   * La hora de la oficina del proveedor, cuando se sabe su zona y la principal es otra hora: es la
   * que figura en la reserva, y si la zona de la cuenta estuviera mal configurada, la que manda.
   */
  readonly office?: DeadlineClockLine;
}

function lineOf(at: Date, clock: WallClock, timeZone: string): DeadlineClockLine {
  return { day: dayLabel(clock.date), time: clock.time, offset: offsetLabel(at, timeZone) };
}

function nextDate(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * La hora del plazo para el aviso: en la de la agencia si se sabe (por su país), si no en la de la
 * oficina, y si tampoco, en UTC. Con la zona de la oficina conocida y otra hora de pared, se suma la
 * de la oficina. Lo que se guarda es UTC; esto sólo decide cómo se lee.
 */
export function deadlineAlertClock(input: {
  readonly at: Date;
  readonly now: number;
  readonly officeTimeZone?: string | null;
  readonly agencyTimeZone?: string | null;
}): DeadlineAlertClock {
  const office = isIanaTimeZone(input.officeTimeZone) ? input.officeTimeZone : undefined;
  const agency = isIanaTimeZone(input.agencyTimeZone) ? input.agencyTimeZone : undefined;
  const source: DeadlineClockSource =
    agency !== undefined ? 'agency' : office !== undefined ? 'office' : 'utc';
  const zone = agency ?? office ?? 'UTC';

  // Las zonas ya se validaron: `wallClockIn` sólo falla con una zona que no existe.
  const main = wallClockIn(input.at, zone) ?? { date: '', time: '' };
  const today = wallClockIn(new Date(input.now), zone)?.date;
  const line = lineOf(input.at, main, zone);
  const when =
    main.date === today
      ? 'hoy'
      : today !== undefined && main.date === nextDate(today)
        ? 'mañana'
        : `el ${line.day}`;

  const officeClock =
    office === undefined || office === zone ? undefined : wallClockIn(input.at, office);
  const officeDiffers =
    officeClock !== undefined && (officeClock.date !== main.date || officeClock.time !== main.time);

  return {
    ...line,
    source,
    when,
    ...(officeDiffers && office !== undefined
      ? { office: lineOf(input.at, officeClock, office) }
      : {}),
  };
}

/** Los nombres de pila de los pasajeros de una orden, sin apellidos ni documentos. */
export function passengerFirstNames(passengers: unknown): string[] {
  if (!Array.isArray(passengers)) return [];
  return passengers.flatMap((passenger: unknown) => {
    if (typeof passenger !== 'object' || passenger === null) return [];
    const given = (passenger as { givenName?: unknown }).givenName;
    if (typeof given !== 'string') return [];
    const first = given.trim().split(/\s+/)[0] ?? '';
    return first.length > 0 ? [first] : [];
  });
}

/** Ruta y fecha de salida de una orden de vuelo (`search_criteria`), o `''` si no las tiene. */
export function flightRouteOf(searchCriteria: unknown): { route: string; departureDate: string } {
  const sc =
    typeof searchCriteria === 'object' && searchCriteria !== null
      ? (searchCriteria as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const origin = text(sc['origin']);
  const destination = text(sc['destination']);
  return {
    route: origin !== '' && destination !== '' ? `${origin} → ${destination}` : '',
    departureDate: text(sc['departureDate']),
  };
}

/** El enlace a la reserva en Reservas, que abre su detalle (`?orden=`). */
export function reservasLink(orderId: string, base: string | undefined): string {
  const root = (base ?? 'https://app.planetour.cloud').replace(/\/+$/, '');
  return `${root}/reservas?orden=${encodeURIComponent(orderId)}`;
}
