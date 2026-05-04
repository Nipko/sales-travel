/**
 * Configuración runtime del adapter LATAM NDC. Se inyecta desde la app
 * leyendo variables de entorno. Si las credenciales mínimas no están,
 * el adapter corre en modo MOCK (devuelve fixtures) — útil para dev y CI.
 */
export interface LatamNdcConfig {
  apiUrl: string;
  apiKey?: string;
  apiSecret?: string;
  agencyId?: string;
  agencyIata?: string;
  agencyName?: string;
  travelAgentId?: string;
  country?: string;
  accountCode?: string;
  /** Forzar modo mock incluso con credenciales presentes. */
  mock?: boolean;
}

export function isMockMode(cfg: LatamNdcConfig): boolean {
  if (cfg.mock) return true;
  return !cfg.apiKey || !cfg.apiSecret || !cfg.agencyId || !cfg.agencyIata || !cfg.country;
}
