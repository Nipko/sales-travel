import type { HotelProviderOutcome } from '../actions';

/*
 * La moneda de la búsqueda de hoteles (docs/tbo/08 D-TBO-15, decisión del 2026-09-29): el vendedor
 * elige entre la moneda de su agencia y USD, sin conversión. Sólo se ven las tarifas que el
 * proveedor cotiza en la moneda elegida; las demás quedan fuera con el motivo, y el aviso ofrece
 * repetir la búsqueda en la moneda del proveedor si la agencia puede usarla.
 *
 * La lista la decide el API (`GET /hotels/currencies`), que es también quien la hace cumplir: esta
 * pantalla sólo la muestra. La última elección se recuerda en la URL (`?moneda=USD`), que no lleva
 * datos del pasajero y sobrevive a recargar la página.
 */

export interface SearchCurrencies {
  /** La moneda de la agencia: la que el selector trae elegida. */
  readonly defaultCurrency: string;
  /** Las que acepta la búsqueda, la de la agencia primero. */
  readonly currencies: readonly string[];
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export const CURRENCY_QUERY_PARAM = 'moneda';

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_RE.test(value);
}

/** Lo que respondió el API, sin confiar en su forma: sin una lista usable, `undefined`. */
export function parseSearchCurrencies(value: unknown): SearchCurrencies | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { defaultCurrency, currencies } = value as {
    defaultCurrency?: unknown;
    currencies?: unknown;
  };
  if (!isCurrencyCode(defaultCurrency) || !Array.isArray(currencies)) return undefined;
  const valid = currencies.filter(isCurrencyCode);
  if (!valid.includes(defaultCurrency)) return undefined;
  return {
    defaultCurrency,
    currencies: [...new Set([defaultCurrency, ...valid])],
  };
}

/**
 * La moneda que eligió el formulario, para mandarla al API. Vacía = la de la agencia, que el API
 * pone sola (así busca también un selector que no llegó a cargar). Otra cosa que no sea un código
 * ISO no se manda: el API la rechazaría igual, y así el vendedor lee un motivo claro.
 */
export function parseCurrencyField(
  raw: string,
): { readonly ok: true; readonly currency?: string } | { readonly ok: false } {
  const value = raw.trim().toUpperCase();
  if (value === '') return { ok: true };
  return isCurrencyCode(value) ? { ok: true, currency: value } : { ok: false };
}

/** La moneda recordada en la URL de la búsqueda, si es un código ISO. */
export function currencyFromQuery(search: string): string | undefined {
  const value = new URLSearchParams(search).get(CURRENCY_QUERY_PARAM)?.trim().toUpperCase();
  return isCurrencyCode(value) ? value : undefined;
}

/** La recordada si la agencia la puede usar; si no, la de la agencia. */
export function initialSearchCurrency(
  options: SearchCurrencies,
  remembered: string | undefined,
): string {
  return remembered !== undefined && options.currencies.includes(remembered)
    ? remembered
    : options.defaultCurrency;
}

/**
 * La URL con la moneda elegida, sin tocar el resto de sus parámetros (`?cliente=` del CRM). La de
 * la agencia no se escribe: es la que ya sale sola.
 */
export function queryWithCurrency(
  search: string,
  currency: string,
  defaultCurrency: string,
): string {
  const params = new URLSearchParams(search);
  if (currency === defaultCurrency) params.delete(CURRENCY_QUERY_PARAM);
  else params.set(CURRENCY_QUERY_PARAM, currency);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** Nombre de una moneda en el idioma del panel; el código si el navegador no sabe nombrarla. */
export function currencyNamer(locale = 'es'): (code: string) => string {
  let names: Intl.DisplayNames | undefined;
  try {
    names = new Intl.DisplayNames([locale], { type: 'currency', fallback: 'code' });
  } catch {
    names = undefined;
  }
  return (code) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
}

/** `COP · peso colombiano`; sólo el código si el navegador no sabe nombrarla. */
export function currencyOptionLabel(code: string, nameOf: (code: string) => string): string {
  const name = nameOf(code);
  return name === code ? code : `${code} · ${name}`;
}

/**
 * Lo que dice el campo debajo: cuál es la moneda de la agencia y que no hay conversión. `null`
 * como opciones = no se pudieron leer, y la búsqueda sale en la de la agencia.
 */
export function currencyFieldMessage(
  options: SearchCurrencies | null | undefined,
  value: string,
): string {
  if (options === null) return 'No pudimos leer las monedas: se busca en la de la agencia.';
  if (options === undefined || !options.currencies.includes(value)) {
    return 'Sin conversión: se ven sólo las tarifas en la moneda elegida.';
  }
  return value === options.defaultCurrency
    ? `La de tu agencia. Sin conversión: se ven sólo las tarifas en ${value}.`
    : `Sin conversión: se ven sólo las tarifas en ${value}. La de tu agencia es ${options.defaultCurrency}.`;
}

/**
 * A qué moneda conviene cambiar la búsqueda cuando un proveedor quedó fuera por moneda
 * (`currency-mismatch`), o `undefined` si no hay a cuál.
 *
 * - La moneda en que cotizó el proveedor, si la agencia la puede usar y no es la que se buscó.
 * - Un API que todavía no informa en qué moneda cotizó: USD, si está en la lista y no se buscó en
 *   USD. Es el caso de TBO, que cotiza en la moneda de su cuenta.
 * - Si cotizó en una moneda que la agencia no puede usar, nada: repetir la búsqueda no lo arregla,
 *   y el motivo del aviso ya dice que se revise la cuenta del proveedor.
 */
export function currencySwitchSuggestion(
  providers: readonly HotelProviderOutcome[],
  allowed: readonly string[] | undefined,
  searched: string | undefined,
): string | undefined {
  if (allowed === undefined) return undefined;
  const mismatched = providers.filter(
    (p) => p.status === 'skipped' && p.skipReason === 'currency-mismatch',
  );
  for (const p of mismatched) {
    const hit = (p.droppedCurrencies ?? []).find((c) => allowed.includes(c) && c !== searched);
    if (hit !== undefined) return hit;
  }
  const unknown = mismatched.some((p) => p.droppedCurrencies === undefined);
  return unknown && allowed.includes('USD') && searched !== 'USD' ? 'USD' : undefined;
}
