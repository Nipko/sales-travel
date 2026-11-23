import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  DespegarActivitiesAdapter,
  DESPEGAR_ACTIVITIES_PROVIDER_CODE,
  type DespegarActivitiesConfig,
} from '@sales-travel/despegar-activities';
import { DESPEGAR_BASE_URLS, type DespegarHttpDeps } from '@sales-travel/despegar-hotels';
import {
  ProviderCredentialsService,
  type ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import {
  PROVIDER_PAYLOAD_WRITER,
  type ProviderPayloadWriter,
} from '../provider-payloads/provider-payloads.types.js';
import type { CredentialSource } from '../providers/provider.types.js';
import { DESPEGAR_HOTELS_PROVIDER_CODE } from './despegar-hotel-provider.adapter.js';
import {
  despegarEnvironmentOf,
  despegarInvoiceOf,
  shouldVaultDespegarPayload,
} from './despegar-hotels.factory.js';

/** La cuenta BYOC de Despegar es UNA para hoteles y actividades: la misma api key. */
const ACCOUNT_PROVIDER_CODE = DESPEGAR_HOTELS_PROVIDER_CODE;

export interface ResolvedActivitiesAdapter {
  readonly adapter: DespegarActivitiesAdapter;
  readonly credentialSource: CredentialSource;
  /** Cuenta de la bóveda con la que se construyó; `null` con la clave de la plataforma. */
  readonly accountId: string | null;
  /** País de venta de la cuenta (`countryCode`), si lo tiene. */
  readonly site?: string;
}

/** La clave de Despegar no está cargada para el tenant ni en la plataforma. */
export class DespegarActivitiesNotConfiguredError extends Error {
  constructor() {
    super('No hay una cuenta de Despegar con api key para este tenant');
    this.name = 'DespegarActivitiesNotConfiguredError';
  }
}

/**
 * Construye el ACL de actividades con la cuenta de Despegar del tenant (BYOC, propia o heredada del
 * consolidador) o, si no tiene, con `DESPEGAR_API_KEY` de la plataforma. Cada RQ/RS de la venta y
 * la post-venta queda en la bóveda de payloads con el código `despegar-activities` (la evidencia de
 * la certificación); las búsquedas, sólo si fallaron.
 */
@Injectable()
export class DespegarActivitiesProviderFactory {
  private readonly cache = new Map<string, ResolvedActivitiesAdapter>();

  constructor(
    private readonly creds: ProviderCredentialsService,
    @Optional()
    @Inject(PROVIDER_PAYLOAD_WRITER)
    private readonly payloadWriter?: ProviderPayloadWriter,
  ) {}

  async forTenant(tenantId: string): Promise<ResolvedActivitiesAdapter> {
    let resolved: ResolvedProviderAccount;
    try {
      resolved = await this.creds.resolve(tenantId, ACCOUNT_PROVIDER_CODE);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      return this.envAdapter(tenantId);
    }
    const key = `byoc:${resolved.ownerTenantId}:${resolved.updatedAt.getTime()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const { credentials, config } = resolved;
    const apiKey = str(credentials['apiKey']) ?? str(credentials['apikey']) ?? platformKey();
    if (!apiKey) throw new DespegarActivitiesNotConfiguredError();
    const baseUrl = str(config['baseUrl']) ?? envBaseUrl();
    const site = str(config['countryCode']);
    const invoice = despegarInvoiceOf(credentials, config);
    const cfg: DespegarActivitiesConfig = {
      apiKey,
      baseUrl,
      site: site ?? '',
      ...langOf(config['language']),
      ...(invoice ? { invoice } : {}),
    };
    const entry: ResolvedActivitiesAdapter = {
      adapter: new DespegarActivitiesAdapter(
        cfg,
        this.httpDeps(resolved.id, resolved.ownerTenantId, baseUrl),
      ),
      credentialSource: resolved.inherited ? 'inherited' : 'own',
      accountId: resolved.id,
      ...(site ? { site } : {}),
    };
    this.cache.set(key, entry);
    this.evictStale(key);
    return entry;
  }

  private envAdapter(tenantId: string): ResolvedActivitiesAdapter {
    const apiKey = platformKey();
    if (!apiKey) throw new DespegarActivitiesNotConfiguredError();
    const cached = this.cache.get('env');
    if (cached) return cached;
    const baseUrl = envBaseUrl();
    const site = str(process.env['DESPEGAR_COUNTRY']);
    const entry: ResolvedActivitiesAdapter = {
      adapter: new DespegarActivitiesAdapter(
        { apiKey, baseUrl, site: site ?? '', ...langOf(process.env['DESPEGAR_LANGUAGE']) },
        this.httpDeps(null, tenantId, baseUrl),
      ),
      credentialSource: 'env',
      accountId: null,
      ...(site ? { site } : {}),
    };
    this.cache.set('env', entry);
    return entry;
  }

  private httpDeps(
    accountId: string | null,
    ownerTenantId: string,
    baseUrl: string,
  ): DespegarHttpDeps {
    const writer = this.payloadWriter;
    const environment = despegarEnvironmentOf(baseUrl);
    return {
      onExchange: (e) => {
        if (writer?.enabled !== true || !shouldVaultActivitiesPayload(e)) return;
        void writer
          .record({
            providerCode: DESPEGAR_ACTIVITIES_PROVIDER_CODE,
            requestId: e.requestId,
            attempt: 1,
            operation: e.operation,
            environment,
            ownerTenantId,
            providerAccountId: accountId,
            sentAt: new Date(e.sentAt),
            durationMs: e.durationMs,
            httpStatus: e.status,
            outcome: e.outcome,
            ...(e.requestBody === undefined ? {} : { requestBody: e.requestBody }),
            ...(e.responseBody === undefined ? {} : { responseBody: e.responseBody }),
          })
          .catch(() => undefined);
      },
    };
  }

  private evictStale(currentKey: string): void {
    const ownerPrefix = currentKey.split(':').slice(0, 2).join(':') + ':';
    for (const k of this.cache.keys()) {
      if (k !== currentKey && k.startsWith(ownerPrefix)) this.cache.delete(k);
    }
  }
}

/** Venta y post-venta siempre; búsquedas sólo si fallaron. */
const ACTIVITIES_VAULTED: ReadonlySet<string> = new Set([
  'activitiesPrebook',
  'activitiesPayments',
  'activitiesBook',
  'activitiesBookStatus',
  'activitiesReservations',
  'activitiesCancelAllowance',
  'activitiesCancelQuote',
  'activitiesCancel',
]);

export function shouldVaultActivitiesPayload(
  e: Parameters<typeof shouldVaultDespegarPayload>[0],
): boolean {
  return ACTIVITIES_VAULTED.has(e.operation) || e.outcome !== 'SUCCESS';
}

function platformKey(): string | undefined {
  return str(process.env['DESPEGAR_API_KEY']);
}

function envBaseUrl(): string {
  return str(process.env['DESPEGAR_BASE_URL']) ?? DESPEGAR_BASE_URLS.sandbox;
}

function langOf(v: unknown): { language?: 'es' | 'pt' | 'en' } {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return s === 'es' || s === 'pt' || s === 'en' ? { language: s } : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
