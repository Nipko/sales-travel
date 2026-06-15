export interface AgentCarsConfig {
  accessToken: string;
  baseUrl: string;
  suggestUrl: string;
  /** País de origen del agente (alpha-2, ej: CO, AR). Usado como `source` en todos los requests. */
  sourceCountry: string;
  language?: string;
}

export const AGENT_CARS_BASE_URLS = {
  development: 'https://api.dev.agentcars.com/v2/sites',
  production: 'https://api.agentcars.com/v2/sites',
} as const;

export const AGENT_CARS_SUGGEST_URL = 'https://suggest.agentcars.com/suggest';

export function isConfigured(cfg: AgentCarsConfig): boolean {
  return Boolean(cfg.accessToken && cfg.baseUrl && cfg.sourceCountry);
}
