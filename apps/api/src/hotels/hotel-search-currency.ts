import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ApplicableRule } from '../pricing/pricing.service.js';

/*
 * En qué moneda se buscan hoteles (docs/tbo/08 D-TBO-15, decisión del founder del 2026-09-29:
 * selector de moneda, sin conversión).
 *
 * El vendedor elige entre la moneda de su agencia y USD. No hay tasa de cambio en ningún punto: la
 * moneda elegida es la del criterio que se manda a cada proveedor, la de la puerta que descarta las
 * tarifas en otra y, por lo tanto, la del precio de venta, el PreBook y la orden. Un proveedor que
 * cotiza en la moneda de su cuenta (TBO) sólo se ve buscando en esa moneda.
 */

/** Las monedas que la plataforma ofrece además de la de la agencia. */
export const EXTRA_HOTEL_SEARCH_CURRENCIES: readonly string[] = ['USD'];

/** Las monedas de búsqueda de una agencia: la suya primero, sin repetir. */
export function hotelSearchCurrencies(tenantCurrency: string): string[] {
  return [...new Set([tenantCurrency, ...EXTRA_HOTEL_SEARCH_CURRENCIES])];
}

/** Lo que ve la web para armar el selector. */
export interface HotelSearchCurrencyOptions {
  /** La moneda de la agencia: la que el selector trae elegida. */
  readonly defaultCurrency: string;
  /** Todas las que acepta la búsqueda, la de la agencia primero. */
  readonly currencies: readonly string[];
}

export function hotelSearchCurrencyOptions(tenantCurrency: string): HotelSearchCurrencyOptions {
  return { defaultCurrency: tenantCurrency, currencies: hotelSearchCurrencies(tenantCurrency) };
}

/** `COP o USD`, `COP, PEN o USD`: la lista para una frase. */
function listed(currencies: readonly string[]): string {
  if (currencies.length <= 1) return currencies.join('');
  return `${currencies.slice(0, -1).join(', ')} o ${currencies[currencies.length - 1]}`;
}

/**
 * Se pidió una moneda que la agencia no puede usar para buscar. Es 400: la eligió el cliente, y el
 * mensaje dice cuáles puede elegir. Sólo lleva códigos ISO, que no son PII.
 */
export class HotelSearchCurrencyNotAllowedError extends BadRequestException {
  constructor(
    readonly requested: string,
    readonly allowed: readonly string[],
  ) {
    super(
      `Los hoteles se buscan en ${listed(allowed)}: la moneda ${requested} no está disponible para esta agencia.`,
    );
    this.name = 'HotelSearchCurrencyNotAllowedError';
  }
}

/**
 * La red cobra un markup FIJO sobre hoteles y la búsqueda no es en la moneda de la agencia.
 *
 * `markup_rules.value_minor` no tiene moneda: un monto fijo se carga pensando en la de la agencia,
 * y sumarlo tal cual a una tarifa en otra moneda sería un precio que nadie configuró (50.000 COP
 * sumados como 50.000 USD). Convertirlo es lo que D-TBO-15 descarta. Es 409: el pedido es válido,
 * lo que lo impide es la configuración de la red, y el mensaje dice cómo seguir.
 */
export class HotelSearchCurrencyMarkupError extends ConflictException {
  constructor(
    readonly currency: string,
    readonly tenantCurrency: string,
  ) {
    super(
      `El markup de hoteles de tu red incluye un monto fijo, que está en ${tenantCurrency}, y no se puede sumar a tarifas en ${currency} sin convertir la moneda. Buscá en ${tenantCurrency}, o pedí que ese markup se configure como porcentaje.`,
    );
    this.name = 'HotelSearchCurrencyMarkupError';
  }
}

/**
 * El detalle de un hotel volvió con todas sus tarifas en otra moneda: no se muestran, por la misma
 * puerta que el listado (RF-13). Es 409 y no una oferta vacía, que la web leería como "sin
 * disponibilidad"; el motivo es el mismo texto que el listado pone en `providers[]`.
 */
export class HotelRatesCurrencyMismatchError extends ConflictException {
  constructor(reason: string) {
    super(reason);
    this.name = 'HotelRatesCurrencyMismatchError';
  }
}

/**
 * La moneda de una búsqueda (o del detalle de un hotel): la pedida si está permitida, o la de la
 * agencia si no se pidió ninguna.
 *
 * `requested` ya viene normalizada por el esquema (`' usd '` → `'USD'`) y `tenantCurrency` por
 * `tenantDefaults`.
 *
 * @throws HotelSearchCurrencyNotAllowedError si se pidió una moneda fuera de la lista.
 */
export function resolveHotelSearchCurrency(
  requested: string | undefined,
  tenantCurrency: string,
): string {
  if (requested === undefined) return tenantCurrency;
  const allowed = hotelSearchCurrencies(tenantCurrency);
  if (!allowed.includes(requested)) {
    throw new HotelSearchCurrencyNotAllowedError(requested, allowed);
  }
  return requested;
}

/**
 * ¿Las reglas del waterfall se pueden aplicar a tarifas en `currency`? Un porcentaje, siempre; un
 * monto fijo distinto de cero, sólo en la moneda de la agencia ({@link HotelSearchCurrencyMarkupError}).
 *
 * @throws HotelSearchCurrencyMarkupError si hay un fijo y la moneda no es la de la agencia.
 */
export function assertRulesPriceIn(
  rules: readonly Pick<ApplicableRule, 'ruleType' | 'valueMinor'>[],
  currency: string,
  tenantCurrency: string,
): void {
  if (currency === tenantCurrency) return;
  if (rules.some((r) => r.ruleType !== 'percentage' && r.valueMinor !== 0)) {
    throw new HotelSearchCurrencyMarkupError(currency, tenantCurrency);
  }
}
