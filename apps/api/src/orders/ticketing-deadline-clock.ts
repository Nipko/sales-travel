/**
 * Relojes del plazo de emisión, sin I/O: de la hora de una oficina a un instante, y de un instante a
 * la hora de una zona.
 *
 * El plazo que da el proveedor viene en la hora de su oficina, sin zona. La zona la declara la
 * cuenta con que se hizo la reserva (`TicketingDeadline.timeZone`); con ella el instante se calcula
 * y se guarda en UTC (0084). Para mostrarlo se vuelve a la hora de una zona: la de la oficina, que
 * es la que figura en la reserva, y la de la agencia que lee el aviso.
 *
 * Todo pasa por `Intl`, que trae la base de zonas del runtime: nada de tablas propias de husos.
 */

/** La forma de una zona IANA, la misma que el CHECK de 0084. */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * ¿`value` es una zona IANA que el runtime sabe convertir? La forma primero —es lo que acepta la
 * base— y después `Intl`: una zona que el motor no conoce no sirve para calcular nada.
 */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (!IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Fecha y hora de pared (`YYYY-MM-DD`, `HH:MM`) de un instante en una zona. */
export interface WallClock {
  readonly date: string;
  readonly time: string;
}

function partsIn(epochMs: number, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  return Number(parts.find((p) => p.type === type)?.value ?? NaN);
}

/** Cuánto va la hora de pared de `timeZone` por delante de UTC en ese instante, en ms. */
function offsetAt(epochMs: number, timeZone: string): number {
  const parts = partsIn(epochMs, timeZone);
  const wall = Date.UTC(
    part(parts, 'year'),
    part(parts, 'month') - 1,
    part(parts, 'day'),
    part(parts, 'hour'),
    part(parts, 'minute'),
    part(parts, 'second'),
  );
  // Los milisegundos no salen en las partes: se comparan segundos enteros.
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * La hora de pared de un instante en una zona. `undefined` si la zona no es una zona IANA conocida.
 */
export function wallClockIn(at: Date, timeZone: string): WallClock | undefined {
  if (!isIanaTimeZone(timeZone) || Number.isNaN(at.getTime())) return undefined;
  const parts = partsIn(at.getTime(), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${part(parts, 'year')}-${pad(part(parts, 'month'))}-${pad(part(parts, 'day'))}`,
    time: `${pad(part(parts, 'hour'))}:${pad(part(parts, 'minute'))}`,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * El instante de una fecha y hora de pared en una zona. `undefined` si algo no se entiende.
 *
 * Alrededor de un cambio de hora una hora de pared puede no existir (el salto del verano) o existir
 * dos veces (el regreso). Los candidatos salen del desfase de la zona un día antes y un día después:
 * de los que vuelven a esa hora de pared, el más temprano; si ninguno vuelve (no existe), también el
 * más temprano, una hora ANTES. Al este y al oeste de Greenwich por igual: para un plazo, avisar
 * antes es el error aceptable.
 */
export function instantOfWallClock(date: string, time: string, timeZone: string): Date | undefined {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (d === null || t === null || !isIanaTimeZone(timeZone)) return undefined;
  const asUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (Number.isNaN(asUtc)) return undefined;
  const candidates = [
    ...new Set([
      asUtc - offsetAt(asUtc - DAY_MS, timeZone),
      asUtc - offsetAt(asUtc + DAY_MS, timeZone),
    ]),
  ]
    .filter((at) => !Number.isNaN(at))
    .sort((a, b) => a - b);
  const exact = candidates.filter((at) => {
    const wall = wallClockIn(new Date(at), timeZone);
    return wall?.date === date && wall.time === time;
  });
  const at = exact[0] ?? candidates[0];
  return at === undefined ? undefined : new Date(at);
}

/**
 * La zona en la que vive una agencia, por su país (`tenants.country_code`), para decirle el plazo en
 * su hora. Sólo los países donde la red vende; uno que no está no tiene zona y el aviso usa la de
 * la oficina. Brasil tiene varias: va la de São Paulo, donde opera la red.
 */
const COUNTRY_TIME_ZONES: Readonly<Record<string, string>> = {
  AR: 'America/Argentina/Buenos_Aires',
  BO: 'America/La_Paz',
  BR: 'America/Sao_Paulo',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  CR: 'America/Costa_Rica',
  DO: 'America/Santo_Domingo',
  EC: 'America/Guayaquil',
  GT: 'America/Guatemala',
  MX: 'America/Mexico_City',
  PA: 'America/Panama',
  PE: 'America/Lima',
  PY: 'America/Asuncion',
  UY: 'America/Montevideo',
  VE: 'America/Caracas',
};

/** La zona de la agencia por su país, o `undefined` si el país no está en la lista. */
export function countryTimeZone(countryCode: string | null | undefined): string | undefined {
  if (typeof countryCode !== 'string') return undefined;
  return COUNTRY_TIME_ZONES[countryCode.trim().toUpperCase()];
}

/** «GMT-5»: el desfase de una zona en un instante, como lo escribe `Intl`. */
export function offsetLabel(at: Date, timeZone: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return name === undefined || name.length === 0 ? timeZone : name;
  } catch {
    return timeZone;
  }
}

/** «jue 15 oct»: el día de una fecha de pared, sin depender de la zona del servidor. */
export function dayLabel(date: string): string {
  const d = DATE.exec(date);
  if (d === null) return date;
  return new Intl.DateTimeFormat('es', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))))
    .replace(/\./g, '')
    .replace(/,/g, '');
}
