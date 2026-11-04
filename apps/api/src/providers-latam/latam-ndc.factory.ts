import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  LatamApiError,
  LatamNdcFlightSearchAdapter,
  missingLatamCredentials,
  type LatamNdcConfig,
} from '@sales-travel/latam-ndc';
import type { ProviderEnvironment } from '@sales-travel/canonical';
import {
  ProviderCredentialsService,
  type ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import {
  ProviderAccountIncompleteError,
  type CallPolicy,
  type CredentialSource,
  type FlightProviderAdapter,
  type ProviderCapabilities,
  type ProviderVertical,
  type TenantAdapter,
  type TenantProviderFactory,
} from '../providers/provider.types.js';
import { humanizeLatamError } from './latam-ndc-errors.js';

const PROVIDER_CODE = 'latam-ndc';

/**
 * Construye el adapter LATAM NDC con las credenciales del tenant (BYOC), resueltas
 * por jerarquía (propia o heredada del consolidador). Si el tenant no tiene ni hereda
 * una `provider_account`, cae a las credenciales globales de entorno (comportamiento
 * legacy) — así el search/órdenes actuales siguen funcionando sin migrar datos.
 *
 * Cachea instancias por credenciales (`ownerTenantId:updatedAt`, o `env`) para
 * preservar el cache de token OAuth que vive por instancia del adapter.
 *
 * ## Lo que ya NO hace: caer a modo simulado
 *
 * Hasta esta tanda había un tercer escalón después del de entorno: si tampoco había
 * credenciales de plataforma —o si el JSONB de la cuenta traía `mock: true`, o si estaba
 * puesta `LATAM_FORCE_MOCK`—, el adapter devolvía tres ofertas de fixture con la MISMA forma
 * canónica que una tarifa real, y llegaban a la pantalla del vendedor.
 *
 * Ese escalón desapareció. El de entorno se CONSERVA —es como opera hoy producción— y el
 * final es el de Sabre: sin credenciales usables se lanza y el proveedor queda AUSENTE de la
 * búsqueda, nombrado en `providers[]` con el motivo.
 */
@Injectable()
export class LatamNdcProviderFactory implements TenantProviderFactory<FlightProviderAdapter> {
  readonly code = PROVIDER_CODE;
  readonly vertical: ProviderVertical = 'flights';

  /** Es el proveedor con el que se vende hoy: se llama en cada búsqueda. */
  readonly defaultCallPolicy: CallPolicy = 'always';

  /** LATAM NDC cubre el ciclo completo: consulta, cancelación, pago diferido, ancillaries y reshop. */
  readonly capabilities: ProviderCapabilities = {
    retrieve: true,
    cancel: true,
    pay: true,
    services: true,
    reshop: true,
  };

  private readonly logger = new Logger('LatamNdc');
  private readonly cache = new Map<string, LatamNdcFlightSearchAdapter>();

  constructor(private readonly creds: ProviderCredentialsService) {}

  async forTenant(tenantId: string): Promise<FlightProviderAdapter> {
    return (await this.resolveForTenant(tenantId)).adapter;
  }

  async resolveForTenant(tenantId: string): Promise<TenantAdapter<FlightProviderAdapter>> {
    let resolved: ResolvedProviderAccount;
    try {
      resolved = await this.creds.resolve(tenantId, PROVIDER_CODE);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      return this.adapterFor(this.envConfig(), 'env', 'env', tenantId);
    }
    return this.adapterForAccount(resolved, tenantId);
  }

  /**
   * La cuenta con que se hizo la reserva (`orders.provider_account_id`). LATAM sólo reconoce una
   * orden con la agencia que la creó: si el tenant cambia de cuenta o de herencia después, la
   * postventa tiene que seguir saliendo con la anterior. Antes LATAM no lo implementaba y la
   * postventa usaba la cuenta ACTUAL del tenant.
   */
  async resolveForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<TenantAdapter<FlightProviderAdapter>> {
    const resolved = await this.creds.resolveForOrder(tenantId, orderId);
    if (resolved.providerCode !== PROVIDER_CODE) {
      throw new NotFoundException('la cuenta de la orden no es de LATAM NDC');
    }
    return this.adapterForAccount(resolved, tenantId);
  }

  private adapterForAccount(
    resolved: ResolvedProviderAccount,
    tenantId: string,
  ): TenantAdapter<FlightProviderAdapter> {
    const cfg = this.toConfig(resolved.credentials, resolved.config);
    const key = `byoc:${resolved.ownerTenantId}:${resolved.id}:${resolved.updatedAt.getTime()}`;
    const base = this.adapterFor(cfg, key, resolved.inherited ? 'inherited' : 'own', tenantId);
    return {
      ...base,
      providerEnvironment: environmentOf(cfg, resolved.config),
      accountOwnerTenantId: resolved.ownerTenantId,
      accountId: resolved.id,
      accountUpdatedAt: resolved.updatedAt,
    };
  }

  private adapterFor(
    cfg: LatamNdcConfig,
    key: string,
    credentialSource: CredentialSource,
    tenantId: string,
  ): TenantAdapter<FlightProviderAdapter> {
    // Puerta única: sin las credenciales que hacen falta para llamar a LATAM, el proveedor NO
    // se sirve. Se comprueba ANTES de construir para que la negativa salga como
    // `ProviderAccountIncompleteError` —que el registry sabe traducir a una ausencia explicada—
    // y no como el error crudo del constructor del ACL, que sería un 500 para el tenant.
    const missing = missingLatamCredentials(cfg);
    if (missing.length > 0) {
      // Sólo NOMBRES de campo y el origen: nunca valores de credencial.
      this.logger.warn(
        `credenciales de LATAM incompletas para ${tenantId} (origen: ${credentialSource}): faltan [${missing.join(', ')}] — proveedor NO habilitado`,
      );
      // Dos negativas distintas, porque la acción del vendedor es distinta. Si el tenant tenía
      // CUENTA, hay algo que completar y se dice qué. Si se cayó al escalón de plataforma y
      // tampoco hay nada ahí, no existe ninguna cuenta que completar: es una ausencia lisa, y
      // decirle "completa tu cuenta" lo mandaría a una pantalla vacía.
      throw credentialSource === 'env'
        ? new NotFoundException(`no hay credenciales de LATAM resolubles desde ${tenantId}`)
        : new ProviderAccountIncompleteError(PROVIDER_CODE, missing);
    }

    let adapter = this.cache.get(key);
    if (!adapter) {
      adapter = new LatamNdcFlightSearchAdapter(cfg);
      this.cache.set(key, adapter);
      this.evictStale(key);
    }
    return { adapter, credentialSource, providerEnvironment: environmentOf(cfg, {}) };
  }

  /** Los errores LANZADOS por el ACL (red/auth/config) ya tienen traducción propia. */
  humanizeError(err: unknown): string {
    if (err instanceof LatamApiError) return humanizeLatamError(err.status, err.body);
    return err instanceof Error ? err.message : String(err);
  }

  /** Conserva sólo la entrada vigente por owner (al rotar credenciales el `updatedAt` cambia la key). */
  private evictStale(currentKey: string): void {
    if (!currentKey.startsWith('byoc:')) return;
    // Owner + cuenta: dos cuentas del mismo dueño conviven; sólo se descarta la versión vieja.
    const ownerPrefix = currentKey.split(':').slice(0, 3).join(':') + ':';
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
      applicationName: str(g['applicationName']),
      posCity: str(g['posCity']),
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
      applicationName: process.env['LATAM_APPLICATION_NAME'],
      posCity: process.env['LATAM_POS_CITY'],
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Entorno de la cuenta: `test` si la URL es el sandbox de LATAM (`sandbox.api.latam.com`) o la
 * cuenta lo declara (`config.environment`: test | cert | sandbox). Sin esto LATAM no declaraba
 * entorno y sus tarifas de sandbox se presentaban como reales.
 */
function environmentOf(cfg: LatamNdcConfig, config: Record<string, unknown>): ProviderEnvironment {
  const declared =
    typeof config['environment'] === 'string' ? config['environment'].toLowerCase() : '';
  if (['test', 'cert', 'sandbox'].includes(declared)) return 'test';
  if (['live', 'prod', 'production'].includes(declared)) return 'live';
  let host = '';
  try {
    host = new URL(cfg.apiUrl).hostname;
  } catch {
    host = cfg.apiUrl;
  }
  return /sandbox/i.test(host) ? 'test' : 'live';
}
