/**
 * Configuración runtime del adapter Despegar Hotels v3. Se inyecta desde la app leyendo las
 * credenciales BYOC del tenant (provider_code='despegar-hotels'). Auth = header `x-apikey`.
 */
export interface DespegarHotelsConfig {
  apiKey: string;
  /** Base URL del entorno. Por defecto sandbox. */
  baseUrl: string;
  /** locale para suggestions (idioma_PAIS), p.ej. 'ES_AR'. */
  locale?: string;
  /** Idioma del contenido en availability/detail. */
  language?: 'EN' | 'ES' | 'PT';
  /** País del punto de venta (POS), p.ej. 'co'. */
  countryCode?: string;
  /** Moneda por defecto, p.ej. 'COP'. */
  currency?: string;
}

export const DESPEGAR_BASE_URLS = {
  sandbox: 'https://api-dev.despegar.com/v3',
  uat: 'https://apis-uat.despegar.com/v3',
  prod: 'https://api.despegar.com/v3',
} as const;

/** Hay credencial mínima para operar (api key). */
export function isConfigured(cfg: DespegarHotelsConfig): boolean {
  return Boolean(cfg.apiKey && cfg.baseUrl);
}
