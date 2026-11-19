import type { HotelCancellation, HotelCancellationRule } from '@sales-travel/canonical';

/*
 * Despegar da los plazos de cancelación en HORAS antes del check-in (`hours_before_penalty`,
 * `anticipation { from, to }`), nunca como fecha. La lectura de "no reembolsable en los hechos"
 * (`hotels/hotel-non-refundable.ts` y su espejo en la web) sólo ubica tramos con fecha local, así
 * que un "gratis hasta 72 h antes" con check-in mañana seguía pasando por cancelable y no pedía la
 * aceptación de no reembolsable (auditoría de flujos de venta, H3).
 *
 * Acá, en el borde de Despegar, cada plazo se pasa a la hora local del hotel con la estadía de la
 * consulta. Despegar no dice desde qué hora del día de entrada cuenta: se toma el inicio del día
 * (00:00), que es lo más temprano posible. Equivocarse para este lado adelanta el aviso unas horas;
 * para el otro, cobra el 100 % de una reserva que el vendedor creía gratis.
 */

/** Tipo del tramo que esta capa agrega cuando Despegar da el plazo pero no el cargo. */
export const DESPEGAR_UNDETAILED_PENALTY_TYPE = 'PENALTY_NOT_DETAILED';

const HOUR_MS = 60 * 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DDTHH:mm:ss` de `hours` horas antes del inicio del día de entrada; o nada. */
function hoursBeforeCheckin(checkinDate: string, hours: number): string | undefined {
  if (!DATE_RE.test(checkinDate) || !Number.isFinite(hours) || hours < 0) return undefined;
  const start = Date.parse(`${checkinDate}T00:00:00Z`);
  if (Number.isNaN(start)) return undefined;
  const at = new Date(start - hours * HOUR_MS);
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1000) return undefined;
  return at.toISOString().slice(0, 19);
}

/** El no-show rige después de la entrada: no es un plazo de cancelación y no se ubica. */
function isNoShow(rule: HotelCancellationRule): boolean {
  return /no.?show/i.test(rule.type);
}

function charges(rule: HotelCancellationRule): boolean {
  return (
    (rule.penaltyPercentage ?? 0) > 0 ||
    (rule.penaltyNights ?? 0) > 0 ||
    (rule.penaltyAmount?.amountMinor ?? 0) > 0
  );
}

/**
 * Cuándo empieza un tramo: el extremo más lejano de su ventana de anticipación. Sin ese extremo el
 * tramo rige "desde siempre" y no se le pone fecha.
 */
function startOf(rule: HotelCancellationRule, checkinDate: string): string | undefined {
  const { fromHours, toHours } = rule;
  if (toHours === undefined) return undefined;
  return hoursBeforeCheckin(checkinDate, Math.max(toHours, fromHours ?? 0));
}

/**
 * La cancelación de un pack de Despegar con sus plazos en hora local del hotel:
 *
 * - cada tramo con ventana acotada lleva `fromLocalDateTime` (las horas quedan como llegaron);
 * - en una `fully_refundable`, `freeCancellationUntilLocal` sale de `hours_before_penalty`;
 * - si Despegar da el plazo sin detallar ningún cargo, el cargo pasado el plazo es desconocido y se
 *   lee como el 100 %: se agrega un tramo que lo dice, para que pasado el plazo se pida la misma
 *   aceptación que con una no reembolsable.
 *
 * Una tarifa declarada no reembolsable, o una sin fecha de entrada válida, queda como llegó.
 */
export function withDespegarCancellationDates(
  cancellation: HotelCancellation,
  checkinDate: string,
): HotelCancellation {
  if (!cancellation.refundable || cancellation.status === 'non_refundable') return cancellation;
  if (hoursBeforeCheckin(checkinDate, 0) === undefined) return cancellation;

  const rules: HotelCancellationRule[] = cancellation.rules.map((rule) => {
    if (rule.fromLocalDateTime !== undefined || isNoShow(rule)) return rule;
    const from = startOf(rule, checkinDate);
    return from === undefined ? rule : { ...rule, fromLocalDateTime: from };
  });

  const hours = cancellation.hoursBeforePenalty;
  const freeUntil =
    hours !== undefined && hours > 0 ? hoursBeforeCheckin(checkinDate, hours) : undefined;

  if (
    freeUntil !== undefined &&
    hours !== undefined &&
    cancellation.policySource !== 'none' &&
    !rules.some((r) => !isNoShow(r) && charges(r))
  ) {
    rules.push({
      type: DESPEGAR_UNDETAILED_PENALTY_TYPE,
      penaltyPercentage: 100,
      fromHours: 0,
      toHours: hours,
      fromLocalDateTime: freeUntil,
    });
  }

  const out: HotelCancellation = { ...cancellation, rules };
  if (
    freeUntil !== undefined &&
    out.freeCancellationUntilLocal === undefined &&
    cancellation.status === 'fully_refundable' &&
    cancellation.policySource !== 'none'
  ) {
    out.freeCancellationUntilLocal = freeUntil;
  }
  return out;
}
