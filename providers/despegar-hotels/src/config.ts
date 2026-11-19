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

const DEFAULT_LOCALE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  es: 'es_AR',
  pt: 'pt_BR',
  en: 'en_US',
};

/**
 * `locale` como lo exige Despegar (obligatorio en `/suggestions`): `idioma_PAÍS`, p. ej. `es_AR`.
 * Acepta `es`, `es-CO`, `ES_co`…; sin país usa el del punto de venta o el de ejemplo de la
 * documentación para ese idioma. Sin nada, español: sin `locale` Despegar responde 400.
 */
export function despegarLocale(
  requested: string | undefined,
  cfg: Pick<DespegarHotelsConfig, 'locale' | 'language' | 'countryCode'>,
): string {
  const raw = (requested ?? cfg.locale ?? cfg.language ?? 'es').trim();
  const m = /^([A-Za-z]{2})(?:[-_]([A-Za-z]{2}))?$/.exec(raw);
  const language = (m?.[1] ?? 'es').toLowerCase();
  const country = m?.[2] ?? cfg.countryCode;
  if (country !== undefined && /^[A-Za-z]{2}$/.test(country)) {
    return `${language}_${country.toUpperCase()}`;
  }
  return DEFAULT_LOCALE_BY_LANGUAGE[language] ?? 'es_AR';
}

/** Hay credencial mínima para operar (api key). */
export function isConfigured(cfg: DespegarHotelsConfig): boolean {
  return Boolean(cfg.apiKey && cfg.baseUrl);
}
