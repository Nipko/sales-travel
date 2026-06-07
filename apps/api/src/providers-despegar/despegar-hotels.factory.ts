import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DespegarHotelsAdapter,
  DESPEGAR_BASE_URLS,
  type DespegarHotelsConfig,
} from '@sales-travel/despegar-hotels';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';

const PROVIDER_CODE = 'despegar-hotels';

/**
 * Construye el adapter Despegar Hotels con las credenciales del tenant (BYOC), resueltas por
 * jerarquía (propia o heredada del consolidador). Si el tenant no tiene ni hereda una
 * `provider_account`, cae a las credenciales globales de entorno. Cachea instancias por
 * credenciales (`ownerTenantId:updatedAt`, o `env`).
 */
@Injectable()
export class DespegarHotelsProviderFactory {
  private readonly cache = new Map<string, DespegarHotelsAdapter>();

  constructor(private readonly creds: ProviderCredentialsService) {}

  async forTenant(tenantId: string): Promise<DespegarHotelsAdapter> {
    let key: string;
    let cfg: DespegarHotelsConfig;

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
      adapter = new DespegarHotelsAdapter(cfg);
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
  ): DespegarHotelsConfig {
    const c = credentials;
    const g = config;
    const cfg: DespegarHotelsConfig = {
      apiKey: str(c['apiKey']) ?? str(c['apikey']) ?? process.env['DESPEGAR_API_KEY'] ?? '',
      baseUrl: str(g['baseUrl']) ?? process.env['DESPEGAR_BASE_URL'] ?? DESPEGAR_BASE_URLS.sandbox,
    };
    const language = lang(g['language']) ?? lang(process.env['DESPEGAR_LANGUAGE']);
    if (language) cfg.language = language;
    const countryCode = str(g['countryCode']) ?? process.env['DESPEGAR_COUNTRY'];
    if (countryCode) cfg.countryCode = countryCode;
    const currency = str(g['currency']) ?? process.env['DESPEGAR_CURRENCY'];
    if (currency) cfg.currency = currency;
    const locale = str(g['locale']) ?? process.env['DESPEGAR_LOCALE'];
    if (locale) cfg.locale = locale;
    return cfg;
  }

  private envConfig(): DespegarHotelsConfig {
    const cfg: DespegarHotelsConfig = {
      apiKey: process.env['DESPEGAR_API_KEY'] ?? '',
      baseUrl: process.env['DESPEGAR_BASE_URL'] ?? DESPEGAR_BASE_URLS.sandbox,
    };
    const language = lang(process.env['DESPEGAR_LANGUAGE']);
    if (language) cfg.language = language;
    if (process.env['DESPEGAR_COUNTRY']) cfg.countryCode = process.env['DESPEGAR_COUNTRY'];
    if (process.env['DESPEGAR_CURRENCY']) cfg.currency = process.env['DESPEGAR_CURRENCY'];
    if (process.env['DESPEGAR_LOCALE']) cfg.locale = process.env['DESPEGAR_LOCALE'];
    return cfg;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function lang(v: unknown): 'EN' | 'ES' | 'PT' | undefined {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s === 'EN' || s === 'ES' || s === 'PT' ? s : undefined;
}
