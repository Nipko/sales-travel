import { Injectable, NotFoundException } from '@nestjs/common';
import { LatamNdcFlightSearchAdapter, type LatamNdcConfig } from '@sales-travel/latam-ndc';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';

const PROVIDER_CODE = 'latam-ndc';

/**
 * Construye el adapter LATAM NDC con las credenciales del tenant (BYOC), resueltas
 * por jerarquía (propia o heredada del consolidador). Si el tenant no tiene ni hereda
 * una `provider_account`, cae a las credenciales globales de entorno (comportamiento
 * legacy) — así el search/órdenes actuales siguen funcionando sin migrar datos.
 *
 * Cachea instancias por credenciales (`ownerTenantId:updatedAt`, o `env`) para
 * preservar el cache de token OAuth que vive por instancia del adapter.
 */
@Injectable()
export class LatamNdcProviderFactory {
  private readonly cache = new Map<string, LatamNdcFlightSearchAdapter>();

  constructor(private readonly creds: ProviderCredentialsService) {}

  async forTenant(tenantId: string): Promise<LatamNdcFlightSearchAdapter> {
    let key: string;
    let cfg: LatamNdcConfig;

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
      adapter = new LatamNdcFlightSearchAdapter(cfg);
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
  ): LatamNdcConfig {
    const c = credentials;
    const g = config;
    return {
      apiUrl: str(g['apiUrl']) ?? process.env['LATAM_API_URL'] ?? 'https://sandbox.api.latam.com',
      apiKey: str(c['apiKey']),
      apiSecret: str(c['apiSecret']),
      agencyId: str(c['agencyId']) ?? str(g['agencyId']),
      agencyIata: str(c['agencyIata']) ?? str(g['agencyIata']),
      agencyName: str(c['agencyName']) ?? str(g['agencyName']),
      travelAgentId: str(c['travelAgentId']) ?? str(g['travelAgentId']),
      country: str(c['country']) ?? str(g['country']),
      accountCode: str(c['accountCode']) ?? str(g['accountCode']),
      mock: g['mock'] === true,
    };
  }

  private envConfig(): LatamNdcConfig {
    return {
      apiUrl: process.env['LATAM_API_URL'] ?? 'https://sandbox.api.latam.com',
      apiKey: process.env['LATAM_API_KEY'],
      apiSecret: process.env['LATAM_API_SECRET'],
      agencyId: process.env['LATAM_AGENCY_ID'],
      agencyIata: process.env['LATAM_AGENCY_IATA'],
      agencyName: process.env['LATAM_AGENCY_NAME'],
      travelAgentId: process.env['LATAM_TRAVEL_AGENT_ID'],
      country: process.env['LATAM_COUNTRY'],
      mock: process.env['LATAM_FORCE_MOCK'] === 'true',
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
