import type { BookInvoice } from '@sales-travel/despegar-hotels';

/**
 * Configuración del adapter de actividades de Despegar/HotelDO. Es la MISMA cuenta BYOC que
 * hoteles (`provider_code = 'despegar-hotels'`): una api key vale para los dos productos.
 */
export interface DespegarActivitiesConfig {
  apiKey: string;
  /**
   * Base de la API v3, SIN `/activities-api` (p. ej. `https://api-dev.despegar.com/v3`): la búsqueda
   * cuelga de `/activities-api` y la reserva y la post-venta son rutas compartidas de `/v3`.
   */
  baseUrl: string;
  /** País del punto de venta (`site`), dos letras. Despegar lo usa para la moneda local. */
  site: string;
  /** Idioma del contenido. */
  language?: 'es' | 'pt' | 'en';
  /**
   * Facturación de la agencia para el book a cuenta corriente, si la cuenta la tiene cargada
   * (la misma que usa hoteles). Sin ella el book sale con `invoices: []` (sin verificar).
   */
  invoice?: BookInvoice;
}

/** Base de la búsqueda, relativa a `baseUrl`. */
export const ACTIVITIES_API_PREFIX = '/activities-api';

/** Parques de Orlando que acepta `/shopping`. Cualquier otro id es 400. */
export const ORLANDO_PARKS = ['DY_ORL', 'UN_ORL', 'SW_ORL', 'BG_ORL'] as const;
export type OrlandoPark = (typeof ORLANDO_PARKS)[number];

export function isOrlandoPark(id: string): id is OrlandoPark {
  return (ORLANDO_PARKS as readonly string[]).includes(id);
}

/** Ventana máxima de `/shopping`, contando el día inicial. */
export const SHOPPING_WINDOW_DAYS = 7;
