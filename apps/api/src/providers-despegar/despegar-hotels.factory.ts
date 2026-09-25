import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DespegarApiError,
  DespegarHotelsAdapter,
  DESPEGAR_BASE_URLS,
  type DespegarHotelsConfig,
} from '@sales-travel/despegar-hotels';
import { humanizeDespegarError } from '../hotels/despegar-hotels-errors.js';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import type {
  HotelProviderAdapter,
  HotelProviderCapabilities,
  HotelProviderFactory,
  HotelSearchProfile,
} from '../providers/hotel-provider.types.js';
import type { CallPolicy, CredentialSource, TenantAdapter } from '../providers/provider.types.js';
import {
  DESPEGAR_HOTELS_PROVIDER_CODE,
  DespegarHotelProviderAdapter,
} from './despegar-hotel-provider.adapter.js';

const PROVIDER_CODE = DESPEGAR_HOTELS_PROVIDER_CODE;

/**
 * El ACL y su envoltorio neutral viven y mueren juntos: son la misma credencial, y rotarla tiene
 * que descartar los dos.
 */
interface CachedAdapters {
  readonly acl: DespegarHotelsAdapter;
  readonly neutral: DespegarHotelProviderAdapter;
}

/**
 * Construye el adapter Despegar Hotels con las credenciales del tenant (BYOC), resueltas por
 * jerarquía (propia o heredada del consolidador). Si el tenant no tiene ni hereda una
 * `provider_account`, cae a las credenciales globales de entorno. Cachea instancias por
 * credenciales (`ownerTenantId:updatedAt`, o `env`).
 *
 * Implementa el contrato de factory de hoteles para el registry SIN cambiar lo que ya hacía:
 *
 *  - `forTenant` sigue entregando el ACL concreto: lo usan las rutas de reserva que todavía
 *    hablan los DTOs de Despegar (`DespegarHotelReservationsService`).
 *  - `resolveForTenant` entrega el mismo ACL detrás del contrato neutral y dice de dónde salieron
 *    las credenciales. Es lo que usa la búsqueda. Con `env`, el registry sólo lo habilita porque
 *    Despegar figura en `PLATFORM_DEFAULT_HOTEL_PROVIDERS`: el fallback es de Despegar, no del
 *    contrato.
 *
 * Sigue sin puerta de credenciales, como opera hoy: a una cuenta sin `apiKey` `toConfig` le
 * completa la `DESPEGAR_API_KEY` de la plataforma (401 de Despegar sólo si tampoco está), y aun
 * así sale como `own`/`inherited`. Quien lea `credentialSource` para atribuir consumo tiene que
 * saberlo. Cambiarlo a "proveedor ausente" es un cambio de comportamiento que se declara aparte.
 */
@Injectable()
export class DespegarHotelsProviderFactory implements HotelProviderFactory {
  readonly code = PROVIDER_CODE;
  readonly vertical = 'hotels' as const;

  /** Es el proveedor con el que se venden hoteles hoy: se llama en cada búsqueda. */
  readonly defaultCallPolicy: CallPolicy = 'always';

  readonly capabilities: HotelProviderCapabilities = {
    retrieve: true,
    cancel: true,
    // El ACL dice que `/book/{id}` también acepta nuestra referencia, pero ningún test ni
    // respuesta grabada lo respalda. Declararlo haría que una verificación confiara en eso.
    retrieveByClientReference: false,
    reconcileByDate: false,
  };

  /**
   * Lo que la búsqueda hacía antes de pasar por el registry, declarado: los 50 primeros hoteles
   * de la ciudad por `hotel_id`. Es su espacio de ids el que usan el autocompletado de destinos y
   * los ids que escribe el vendedor. Cambiar el orden o el límite cambia qué hoteles ve el
   * vendedor, y eso es otro PR con telemetría.
   */
  readonly searchProfile: HotelSearchProfile = {
    idSpace: 'platform',
    maxHotelsPerSearch: 50,
    catalogOrder: 'hotel_id',
  };

  private readonly cache = new Map<string, CachedAdapters>();

  constructor(private readonly creds: ProviderCredentialsService) {}

  async forTenant(tenantId: string): Promise<DespegarHotelsAdapter> {
    return (await this.resolve(tenantId)).adapters.acl;
  }

  async resolveForTenant(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
    const { adapters, credentialSource } = await this.resolve(tenantId);
    return { adapter: adapters.neutral, credentialSource };
  }

  /**
   * Mismo traductor que el filtro de excepciones de la vertical. Un error que no es de Despegar
   * (p. ej. un pedido neutral que no se pudo traducir) ya trae un mensaje nuestro.
   */
  humanizeError(err: unknown): string {
    if (err instanceof DespegarApiError) return humanizeDespegarError(err.status, err.body);
    return err instanceof Error ? err.message : String(err);
  }

  private async resolve(
    tenantId: string,
  ): Promise<{ adapters: CachedAdapters; credentialSource: CredentialSource }> {
    let key: string;
    let cfg: DespegarHotelsConfig;
    let credentialSource: CredentialSource;

    try {
      const resolved = await this.creds.resolve(tenantId, PROVIDER_CODE);
      cfg = this.toConfig(resolved.credentials, resolved.config);
      key = `byoc:${resolved.ownerTenantId}:${resolved.updatedAt.getTime()}`;
      credentialSource = resolved.inherited ? 'inherited' : 'own';
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      cfg = this.envConfig();
      key = 'env';
      credentialSource = 'env';
    }

    let adapters = this.cache.get(key);
    if (!adapters) {
      const acl = new DespegarHotelsAdapter(cfg);
      adapters = { acl, neutral: new DespegarHotelProviderAdapter(acl) };
      this.cache.set(key, adapters);
      this.evictStale(key);
    }
    return { adapters, credentialSource };
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
