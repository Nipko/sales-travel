import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { isTboIsoDate } from '../internal/tbo-date';

/**
 * Body de `BookingDetailsbasedondate` y sus ventanas (docs/tbo/04 §5.3 y §9.5; 08 RF-28; PV-25 y
 * PV-26).
 *
 * - **Grafía `FromDate`/`ToDate`**, la de la tabla (p. 62) y la de Postman. El ejemplo de p. 63 usa
 *   `fromdate`/`todate` (fixture `booking-by-date-request.p63.json`). Si el servidor ignorara la
 *   grafía que mandamos y aplicara un rango por defecto, la respuesta sería plausible y falsa: la
 *   salvaguarda es que el mapper rechaza toda fila con `BookingDate` fuera de la ventana (Q-56).
 * - **Hasta 60 días por ventana** ("Maximum of 60 days (about 2 months)", p. 62), contados con los
 *   dos extremos incluidos: el ejemplo pide el 9 y el 10 y devuelve reservas de los dos días
 *   (p. 63-64), así que `ToDate` es inclusivo (INFERIDO). No se documenta qué pasa si se excede
 *   (PV-26): nunca se manda más, y un rango largo se parte con {@link splitTboBookingDateRange}.
 * - Las fechas son de calendario y sin zona, `YYYY-MM-DD` (p. 62). Qué zona usa TBO no está
 *   documentado (Q-57): el solapamiento de ventanas lo decide la conciliación, no este builder.
 */

const BY_DATE_PATH = TBO_OPERATIONS.bookingDetailsByDate.path;

/** Días de calendario de una ventana, con los dos extremos incluidos (p. 62). */
export const TBO_BOOKINGS_BY_DATE_MAX_DAYS = 60;

const DAY_MS = 86_400_000;

/** Una ventana de fechas de CREACIÓN de reserva, `YYYY-MM-DD` y con los extremos incluidos. */
export interface TboBookingDateWindow {
  readonly fromDate: string;
  readonly toDate: string;
}

const IsoDateSchema = z.string().refine(isTboIsoDate, { params: { reason: 'invalid_date' } });

export const TboBookingsByDateRequestSchema = z
  .object({ FromDate: IsoDateSchema, ToDate: IsoDateSchema })
  .strict();

/** Tipo crudo de TBO: no sale del paquete. */
export type TboBookingsByDateRequest = z.infer<typeof TboBookingsByDateRequestSchema>;

/** Día de calendario como número de días desde la época. Sólo sobre fechas ya validadas. */
function epochDay(isoDate: string): number {
  const [year = 0, month = 1, day = 1] = isoDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function isoFromEpochDay(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

/** Los `ruta:código` de una ventana inválida; vacío si vale. */
function windowIssues(window: TboBookingDateWindow): string[] {
  // Se leen como `unknown`: el tipo no llega al runtime y la ventana puede venir de un job.
  const from: unknown = window.fromDate;
  const to: unknown = window.toDate;
  const issues: string[] = [];
  if (typeof from !== 'string' || !isTboIsoDate(from)) issues.push('fromDate:invalid_date');
  if (typeof to !== 'string' || !isTboIsoDate(to)) issues.push('toDate:invalid_date');
  if (issues.length > 0 || typeof from !== 'string' || typeof to !== 'string') return issues;
  const days = epochDay(to) - epochDay(from) + 1;
  if (days < 1) issues.push('toDate:before_from_date');
  else if (days > TBO_BOOKINGS_BY_DATE_MAX_DAYS) issues.push('toDate:window_too_long');
  return issues;
}

/**
 * Construye el body. Lanza `TboRequestBuildError` con `SCHEMA` si alguna fecha no es `YYYY-MM-DD` de
 * calendario, si `toDate` es anterior a `fromDate` o si la ventana pasa de 60 días: nada sale hacia
 * TBO.
 */
export function buildTboBookingsByDateRequest(
  window: TboBookingDateWindow,
): TboBookingsByDateRequest {
  const issues = windowIssues(window);
  if (issues.length > 0) throw new TboRequestBuildError(BY_DATE_PATH, 'SCHEMA', issues);
  return TboBookingsByDateRequestSchema.parse({
    FromDate: window.fromDate,
    ToDate: window.toDate,
  });
}

/**
 * Parte un rango de fechas en ventanas consecutivas de hasta 60 días, sin huecos ni solapes, en
 * orden (tramo B de la conciliación, 04 §9.3). Lanza `TboRequestBuildError` si el rango no es
 * válido: una fecha rota o un rango invertido no son "cero ventanas".
 */
export function splitTboBookingDateRange(
  range: TboBookingDateWindow,
): readonly TboBookingDateWindow[] {
  const issues = windowIssues(range).filter((issue) => issue !== 'toDate:window_too_long');
  if (issues.length > 0) throw new TboRequestBuildError(BY_DATE_PATH, 'SCHEMA', issues);
  const last = epochDay(range.toDate);
  const windows: TboBookingDateWindow[] = [];
  for (let start = epochDay(range.fromDate); start <= last; ) {
    const end = Math.min(start + TBO_BOOKINGS_BY_DATE_MAX_DAYS - 1, last);
    windows.push({ fromDate: isoFromEpochDay(start), toDate: isoFromEpochDay(end) });
    start = end + 1;
  }
  return windows;
}
