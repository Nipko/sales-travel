export interface AgentCarsConfig {
  accessToken: string;
  baseUrl: string;
  suggestUrl: string;
  /** País de origen del agente (alpha-2, ej: CO, AR). Usado como `source` en todos los requests. */
  sourceCountry: string;
  language?: string;
  /** Techo de espera por request, en ms. Por defecto 15 000 (ver el cliente HTTP). */
  timeoutMs?: number;
}

export const AGENT_CARS_BASE_URLS = {
  development: 'https://api.dev.agentcars.com/v2/sites',
  production: 'https://api.agentcars.com/v2/sites',
} as const;

export const AGENT_CARS_SUGGEST_URL = 'https://suggest.agentcars.com/suggest';

export function isConfigured(cfg: AgentCarsConfig): boolean {
  return Boolean(cfg.accessToken && cfg.baseUrl && cfg.sourceCountry);
}

/** La raíz de la API dentro del host: cada operación se le concatena (`/get-matrix`, `/rates`…). */
const API_ROOT = '/v2/sites';
const API_ROOT_RE = /^(.*?\/v2\/sites)(?=\/|$)/i;

/**
 * Lleva la URL base configurada a la raíz de la API (`https://<host>/v2/sites`).
 *
 * La colección Postman oficial publica sólo el host (`api_url = https://api.agentcars.com`) y
 * escribe `/v2/sites` en cada request. Copiar esa variable a la cuenta dejaba todas las llamadas
 * en `https://api.agentcars.com/get-matrix`, que AgentCars contesta con su página HTML de 404
 * ("Page not found.") y la búsqueda salía vacía. Esto la corrige donde se sabe cómo está armada la
 * API:
 *   - host solo o `/v2`       → se completa `/v2/sites`;
 *   - `/v2/sites/<operación>` → se recorta a `/v2/sites`;
 *   - barras finales, query y fragmento → se quitan (a la base se le concatena cada operación).
 * Cualquier otra ruta, por ejemplo la de un proxy propio, se respeta.
 */
export function normalizeAgentCarsBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return trimmed;
  const path = url.pathname.replace(/\/+$/, '');
  const root = API_ROOT_RE.exec(path)?.[1];
  const normalized = root
    ? `${root.slice(0, -API_ROOT.length)}${API_ROOT}`
    : path === '' || path.toLowerCase() === '/v2'
      ? API_ROOT
      : path;
  return `${url.origin}${normalized}`;
}
