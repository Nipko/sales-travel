/**
 * Hasta cuándo se puede EMITIR una reserva: el dato que decide si el vendedor emite hoy o pierde
 * la reserva esta noche. Una BASIC de LATAM reservada hoy puede vencer a la 01:28 de mañana.
 *
 * Dos fuentes, y no valen lo mismo:
 *
 * - **Instante con zona** (Flight Check `paymentTimeLimit`, NDC `paymentTimeLimitDateTime`): se
 *   puede convertir a la hora de quien mira y calcular cuánto falta.
 * - **Fecha y hora de BFM** (`lastTicketDate` + `lastTicketTime`): el contrato NO dice en qué zona
 *   están (bargain-finder-max-v5.yml:3607-3614). Se muestran tal cual, diciendo de dónde salen,
 *   y nunca se convierten: inventar la zona es imprimir otra hora como fecha límite.
 */
export type TicketingDeadline =
  | { readonly kind: 'instant'; readonly at: string }
  | { readonly kind: 'provider-clock'; readonly date: string; readonly time?: string };

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

export function ticketingDeadline(
  raw: Readonly<Record<string, unknown>> | undefined,
): TicketingDeadline | null {
  if (raw === undefined) return null;
  const at =
    instant(raw['flightCheckPaymentTimeLimit']) ?? instant(raw['paymentTimeLimitDateTime']);
  if (at !== null) return { kind: 'instant', at };

  const date = raw['lastTicketDate'];
  if (typeof date !== 'string' || !DATE.test(date)) return null;
  const time = raw['lastTicketTime'];
  return typeof time === 'string' && TIME.test(time)
    ? { kind: 'provider-clock', date, time }
    : { kind: 'provider-clock', date };
}

export type TicketingState = 'expired' | 'urgent' | 'ok';

const HORA = 60 * 60 * 1000;

function fechaLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Vencido, urgente (menos de 24 h) o con tiempo.
 *
 * Con un instante se calcula. Con el reloj de Sabre la zona es desconocida —puede ir hasta ~14 h
 * por delante o por detrás del navegador—, así que el error tiene que ser siempre avisar de MÁS:
 * - urgente si el día del plazo cae dentro de las próximas 48 h;
 * - vencido sólo cuando ya no puede no haberlo, o sea el día del plazo es anterior a AYER.
 */
export function ticketingState(
  deadline: TicketingDeadline,
  now: Date = new Date(),
): TicketingState {
  if (deadline.kind === 'instant') {
    const falta = Date.parse(deadline.at) - now.getTime();
    if (falta <= 0) return 'expired';
    return falta < 24 * HORA ? 'urgent' : 'ok';
  }
  if (deadline.date < fechaLocal(new Date(now.getTime() - 24 * HORA))) return 'expired';
  return deadline.date <= fechaLocal(new Date(now.getTime() + 48 * HORA)) ? 'urgent' : 'ok';
}

/**
 * De qué reloj sale la hora cuando no hay instante:
 * - `fare`: la fecha y hora de la tarifa (BFM), sin zona en el contrato;
 * - `office`: el plazo que la reserva tiene en el proveedor, en la hora de la oficina que la emite.
 */
export type ProviderClockSource = 'fare' | 'office';

function cuandoTexto(deadline: TicketingDeadline, clock: ProviderClockSource): string {
  if (deadline.kind === 'instant') {
    return new Date(deadline.at).toLocaleString('es-CO', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  const [y, m, d] = deadline.date.split('-').map(Number);
  const dia = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).toLocaleDateString('es-CO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  if (clock === 'office') {
    return deadline.time === undefined
      ? `${dia} (fecha local de la oficina emisora)`
      : `${dia}, ${deadline.time} (hora local de la oficina emisora)`;
  }
  return deadline.time === undefined
    ? `${dia} (según Sabre)`
    : `${dia}, ${deadline.time} (hora informada por Sabre)`;
}

/**
 * El texto completo, con el estado ESCRITO: la urgencia no puede ir sólo en el color (WCAG
 * 1.4.1). `fromOrder`: en una reserva el plazo es el de la tarifa al reservar, no el del PNR.
 * `clock: 'office'`: el plazo es el que la reserva tiene en el proveedor, y su hora es la de la
 * oficina emisora (sin zona: no se convierte).
 */
export function describeTicketingDeadline(
  deadline: TicketingDeadline,
  now: Date = new Date(),
  options: { readonly fromOrder?: boolean; readonly clock?: ProviderClockSource } = {},
): string {
  const cuando = cuandoTexto(deadline, options.clock ?? 'fare');
  const state = ticketingState(deadline, now);
  if (state === 'expired') {
    return `Plazo de emisión vencido el ${cuando}: verifica la reserva`;
  }
  const base = options.fromOrder
    ? `Plazo de la tarifa: emitir antes del ${cuando}`
    : `Emitir antes del ${cuando}`;
  return state === 'urgent' ? `Urgente · ${base}` : base;
}
