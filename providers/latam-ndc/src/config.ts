/**
 * Configuración runtime del adapter. Se inyecta desde la app (api) leyendo
 * variables de entorno. Si `apiUrl` o `apiKey` están vacíos, el adapter
 * corre en modo MOCK (devuelve fixtures determinísticas) — útil para dev
 * y para CI sin credenciales reales.
 */
export interface LatamNdcConfig {
  apiUrl?: string;
  apiKey?: string;
  agencyId?: string;
  /** Forzar modo mock incluso con credenciales presentes. */
  mock?: boolean;
}

export function isMockMode(cfg: LatamNdcConfig): boolean {
  if (cfg.mock) return true;
  return !cfg.apiUrl || !cfg.apiKey;
}
