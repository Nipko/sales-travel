import type { Money } from '@sales-travel/canonical';

/**
 * Lectura del XML de LATAM ya parseado por `fast-xml-parser` (atributos con prefijo `@_`, texto
 * en `#text`, prefijos de namespace fuera). Un nodo que se repite llega como arreglo y uno solo
 * como objeto: por eso todo lo que puede repetirse pasa por {@link arr}.
 */

export function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}

export function arr<T = unknown>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

export function text(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const t = (val as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
    if (typeof t === 'number' || typeof t === 'boolean') return String(t);
  }
  return undefined;
}

export function attr(val: unknown, name: string): string | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const v = (val as Record<string, unknown>)[`@_${name}`];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

export function collect(obj: unknown, path: readonly string[], leaf: string): unknown[] {
  let cur: unknown = obj;
  for (const p of path) {
    cur = pick(cur, p);
    if (!cur) return [];
  }
  return arr(pick(cur, leaf));
}

/**
 * Monto con su moneda. Sin `CurCode` no hay dinero: devolver una moneda supuesta convertía un
 * precio en COP en uno en USD sin que nadie lo notara.
 *
 * `amountMinor` sigue la convención de la plataforma (`packages/canonical/src/money.ts`): ×100.
 */
export function money(node: unknown, currencyHint?: string): Money | null {
  if (node === undefined || node === null) return null;
  const raw = text(node);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  const currency = attr(node, 'CurCode') ?? attr(node, 'Code') ?? currencyHint;
  if (!currency || !/^[A-Z]{3}$/i.test(currency)) return null;
  return { amountMinor: Math.round(value * 100), currency: currency.toUpperCase() };
}

/**
 * Fecha y hora con offset. LATAM manda la hora LOCAL del aeropuerto como texto y el offset en el
 * atributo `TimeZoneCode` (`<AircraftScheduledDateTime TimeZoneCode="-05:00">2024-10-31T08:15:00`).
 * Agregarle `Z` a la hora local —lo que se hacía— la corría entre 3 y 5 horas.
 *
 * Sin offset declarado devuelve `null`: inventar uno es peor que no tener el dato.
 */
export function dateTimeWithOffset(node: unknown): string | null {
  const value = text(node);
  if (!value) return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const tz = attr(node, 'TimeZoneCode');
  if (tz && /^[+-]\d{2}:\d{2}$/.test(tz)) {
    return tz === '+00:00' || tz === '-00:00' ? `${value}Z` : `${value}${tz}`;
  }
  return null;
}

export interface LatamMessage {
  code: string;
  desc: string;
}

/**
 * Todos los `<Error>` de la raíz. LATAM puede mandar varios (uno por tramo no operado, por
 * ejemplo); leer sólo el primero escondía el resto.
 */
export function latamErrors(root: unknown): LatamMessage[] {
  const nodes = [...arr(pick(root, 'Error')), ...arr(pick(pick(root, 'Errors'), 'Error'))];
  return nodes.map((n) => ({
    code: text(pick(n, 'Code')) ?? '?',
    desc: text(pick(n, 'DescText')) ?? 'sin descripción',
  }));
}

/** Avisos de negocio (`Response/Warning`): recotización 70K, orden anulada 111, etc. */
export function latamWarnings(response: unknown): LatamMessage[] {
  return arr(pick(response, 'Warning')).map((n) => ({
    code: text(pick(n, 'Code')) ?? '?',
    desc: text(pick(n, 'DescText')) ?? '',
  }));
}
