/**
 * Coerciones de campos de TBO que NO son dinero (los importes van por `./decimal`).
 *
 * El contrato declara un tipo y los ejemplos traen otro: `HotelRating` como texto o número (p. 62,
 * 67), `Index` declarado String y leído como número (p. 14), `Code` entero o string, `BookingDetail`
 * objeto o array (p. 63-64). La base es `providers/agent-cars/src/internal/coerce.ts`, con una
 * diferencia a propósito: allí un valor ilegible vale `0`, `''` o `false`, y aquí vale `undefined`.
 * Un `false` inventado para `IsRefundable` o un `0` para `Index` son datos falsos con forma de dato
 * real; `undefined` obliga al mapper a decidir qué hacer con la ausencia.
 */

/** String tal cual; un número finito pasa a su forma decimal (TBO manda `HotelCode` de las dos). */
export function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Entero seguro, como número o como string de dígitos. `"23.0"` no es un entero: es texto raro. */
export function optionalInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Número finito, como número o como string decimal sin separador de miles. Sirve para
 * `HotelRating` o coordenadas; nunca para importes, que necesitan el redondeo explícito de
 * `./decimal` y no un float.
 */
export function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Booleano, o su texto `true`/`false` sin distinguir mayúsculas. Nada más: `"Yes"`, `"1"` o
 * `"Confirm"` no tienen evidencia en el contrato y adivinar su sentido es inventar una política.
 */
export function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return undefined;
}

/**
 * Lista a partir de un campo que el contrato declara objeto y el ejemplo trae como array, o al
 * revés (`BookingDetail`, p. 63-64). Ausente o `null` es lista vacía. Un escalar es `undefined` y
 * no `[]`: es una forma que el contrato no admite, y el mapper tiene que poder distinguirla de
 * "no hay nada".
 */
export function toList(value: unknown): readonly unknown[] | undefined {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as readonly unknown[];
  if (typeof value === 'object') return [value];
  return undefined;
}
