import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AgentCarsAdapter,
  AGENT_CARS_BASE_URLS,
  AGENT_CARS_SUGGEST_URL,
  type AgentCarsConfig,
} from '@sales-travel/agent-cars';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';

const PROVIDER_CODE = 'agent-cars';

/**
 * Construye el adapter AgentCars con las credenciales del tenant (BYOC), resueltas por jerarquía
 * (propia o heredada del consolidador). Si el tenant no tiene ni hereda una `provider_account`,
 * cae a las credenciales globales de entorno. Cachea instancias por credenciales
 * (`byoc:{ownerTenantId}:{updatedAt}`, o `env`).
 */
@Injectable()
export class AgentCarsProviderFactory {
  private readonly cache = new Map<string, AgentCarsAdapter>();

  constructor(private readonly creds: ProviderCredentialsService) {}

  async forTenant(tenantId: string): Promise<AgentCarsAdapter> {
    let key: string;
    let cfg: AgentCarsConfig;

    try {
      const resolved = await this.creds.resolve(tenantId, PROVIDER_CODE);
      cfg = this.toConfig(resolved.credentials, resolved.config);
      key = `byoc:${resolved.ownerTenantId}:${resolved.updatedAt.getTime()}`;
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      cfg = this.envConfig();
      key = 'env';
    }

    let adapter = this.cache.get(key);
    if (!adapter) {
      adapter = new AgentCarsAdapter(cfg);
      this.cache.set(key, adapter);
      this.evictStale(key);
    }
    return adapter;
  }

  /** Conserva sólo la entrada vigente por owner (al rotar credenciales el `updatedAt` cambia la key). */
  private evictStale(currentKey: string): void {
    if (!currentKey.startsWith('byoc:')) return;
    const ownerPrefix = currentKey.split(':').slice(0, 2).join(':') + ':';
    for (const k of this.cache.keys()) {
      if (k !== currentKey && k.startsWith(ownerPrefix)) this.cache.delete(k);
    }
  }

  private toConfig(
    credentials: Record<string, unknown>,
    config: Record<string, unknown>,
  ): AgentCarsConfig {
    return {
      accessToken: str(credentials['accessToken']) ?? process.env['AGENT_CARS_ACCESS_TOKEN'] ?? '',
      baseUrl: str(config['baseUrl']) ?? process.env['AGENT_CARS_BASE_URL'] ?? AGENT_CARS_BASE_URLS.development,
      suggestUrl: str(config['suggestUrl']) ?? process.env['AGENT_CARS_SUGGEST_URL'] ?? AGENT_CARS_SUGGEST_URL,
      sourceCountry: str(config['sourceCountry']) ?? process.env['AGENT_CARS_SOURCE'] ?? '',
      ...(str(config['language']) && { language: str(config['language']) }),
    };
  }

  private envConfig(): AgentCarsConfig {
    const cfg: AgentCarsConfig = {
      accessToken: process.env['AGENT_CARS_ACCESS_TOKEN'] ?? '',
      baseUrl: process.env['AGENT_CARS_BASE_URL'] ?? AGENT_CARS_BASE_URLS.development,
      suggestUrl: process.env['AGENT_CARS_SUGGEST_URL'] ?? AGENT_CARS_SUGGEST_URL,
      sourceCountry: process.env['AGENT_CARS_SOURCE'] ?? '',
    };
    if (process.env['AGENT_CARS_LANGUAGE']) cfg.language = process.env['AGENT_CARS_LANGUAGE'];
    return cfg;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
