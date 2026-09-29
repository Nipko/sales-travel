/**
 * Horas y fechas de VUELO, en la hora local del aeropuerto.
 *
 * `departureAt`/`arrivalAt` llegan en ISO con el offset del propio aeropuerto
 * (`2026-10-14T15:15:00-05:00`, `packages/canonical/src/segment.ts`). Pasarlos por `new Date()`
 * los convertía a la zona del navegador —o a UTC en el PDF, que se genera en el servidor— y un
 * vuelo de las 15:15 salía a las 20:15 en el papel que recibe el cliente. La hora que vale es
 * la que está ESCRITA en el string, así que se lee tal cual y no se convierte.
 *
 * Esto NO sirve para instantes (creación de una cotización, vencimientos): esos sí se muestran
 * en la zona de quien mira.
 */
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

function partes(iso: string): { y: number; m: number; d: number; hh: string; mm: string } | null {
  const match = LOCAL_RE.exec(iso);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match;
  if (!y || !m || !d || !hh || !mm) return null;
  return { y: Number(y), m: Number(m), d: Number(d), hh, mm };
}

/** «15:15» del reloj del aeropuerto. */
export function flightTime(iso: string): string {
  const p = partes(iso);
  return p ? `${p.hh}:${p.mm}` : '';
}

type DateStyle = 'short' | 'long';

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { weekday: 'short', day: 'numeric', month: 'short' },
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
};

/** El día del calendario del aeropuerto. Se formatea en UTC para que el día no se corra. */
export function flightDate(iso: string, style: DateStyle = 'short'): string {
  const p = partes(iso);
  if (!p) return '';
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString('es-CO', {
    ...DATE_OPTIONS[style],
    timeZone: 'UTC',
  });
}

/**
 * Monedas que se venden sin centavos. El resto lleva dos decimales: una multa de USD 80,50 no
 * se puede imprimir como «US$ 81» en un documento para el cliente.
 */
const SIN_DECIMALES = new Set(['COP', 'CLP', 'PYG', 'JPY', 'KRW', 'VND', 'ISK', 'UGX']);

/** `amountMinor` es SIEMPRE centésimas (ver `Money.fromMajor`), también en COP. */
export function formatMoney(amountMinor: number, currency: string): string {
  const decimales = SIN_DECIMALES.has(currency.toUpperCase()) ? 0 : 2;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  }).format(amountMinor / 100);
}
