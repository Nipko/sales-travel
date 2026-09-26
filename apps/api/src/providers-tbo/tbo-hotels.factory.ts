import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { LoggerPort } from '@sales-travel/core';
import {
  TBO_SEARCH_LIMITS,
  TboConfigError,
  TboHotelsAdapter,
  TboInMemoryRateLimiter,
  TboStaticContentClient,
  missingTboCredentials,
  parseTboConfig,
  type TBO_HOTELS_PROVIDER_CODE,
  type TboFetch,
  type TboHotelsConfig,
  type TboHttpDeps,
  type TboRateLimiter,
} from '@sales-travel/tbo-hotels';
import type { TenantType } from '../database/database.types.js';
import {
  ProviderCredentialsService,
  type ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import {
  PROVIDER_PAYLOAD_WRITER,
  type ProviderPayloadWriter,
} from '../provider-payloads/provider-payloads.types.js';
import type {
  HotelProviderAdapter,
  HotelProviderCapabilities,
  HotelProviderFactory,
  HotelSearchProfile,
} from '../providers/hotel-provider.types.js';
import {
  ProviderAccountIncompleteError,
  ProviderAccountNotAllowedError,
  type CallPolicy,
  type ProviderErrorContext,
  type TenantAdapter,
} from '../providers/provider.types.js';
import { TboHotelProviderAdapter } from './tbo-hotel-provider.adapter.js';
import { humanizeTboError, tboCircuitEffect } from './tbo-hotels-errors.js';
import { tboPayloadVault } from './tbo-payload-vault.js';

/** Literal para que el guard de órdenes lo encuentre; `satisfies` lo ata al código del ACL. */
const PROVIDER_CODE = 'tbo-hotels' satisfies typeof TBO_HOTELS_PROVIDER_CODE;

/**
 * Token DI opcional del `fetch` con que sale el ACL. En producción no se provee y el cliente usa el
 * global; los tests de integración de la búsqueda inyectan uno que responde con los fixtures.
 */
export const TBO_HOTELS_FETCH = 'TBO_HOTELS_FETCH';

/**
 * Nodos que pueden ser dueños de la cuenta TBO con la que se opera (D-TBO-03 A, firmada el
 * 2026-09-25): la del consolidador, heredada por su red, o la de la plataforma. Las cuentas propias
 * de agencias quedan fuera mientras TBO no diga si la certificación cubre cualquier cuenta que
 * opere por nuestra integración (Q-77, "Postura si no responden: BYOC de TBO deshabilitado").
 */
const ALLOWED_OWNER_TYPES: ReadonlySet<TenantType> = new Set<TenantType>([
  'platform',
  'consolidator',
]);

const OWN_AGENCY_ACCOUNT =
  'TBO opera sólo con la cuenta del consolidador: las cuentas propias de agencias todavía no están habilitadas. Quitá la cuenta de TBO de esta agencia en Mi Red → Credenciales para usar la del consolidador.';

const INHERITED_AGENCY_ACCOUNT =
  'La cuenta de TBO que hereda esta agencia es de otra agencia de la red, y TBO opera sólo con la cuenta del consolidador. Pedile a quien la cargó que la quite para heredar la del consolidador.';

/**
 * Factory del ACL de TBO Hotels por tenant (docs/tbo/06 §5.2; 08 RF-36, RNF-06).
 *
 * **BYOC puro, sin escalón de plataforma** (D-TBO-03 A). A diferencia de Despegar y LATAM no hay
 * `try` que convierta la falta de cuenta en credenciales de entorno: la `NotFoundException` de la
 * bóveda —sin cuenta, o con la cuenta en `sandbox`, que `resolve_provider_account` no devuelve— se
 * propaga y el registry deja a TBO AUSENTE con motivo. `tbo-hotels` tampoco figura en
 * `PLATFORM_DEFAULT_HOTEL_PROVIDERS`, y no hay variables `TBO_*` de venta en el despliegue.
 *
 * Tres puertas, en orden y ANTES de construir nada, ninguna dentro de un `try` que atrape
 * `NotFoundException` (una cuenta incompleta atrapada ahí sería un fallback silencioso):
 *
 * 1. **Dueño admitido**: plataforma o consolidador (`tenants.tenant_type`). Una cuenta de agencia,
 *    propia o heredada de otra agencia, deja a TBO ausente con la acción que corresponde.
 * 2. **Configuración válida** (`parseTboConfig`): `environment` obligatorio, `baseUrl` sin valor
 *    por defecto en live, `http` sólo en el host de test. Una inválida es una cuenta a corregir, no
 *    un 500 que tumbe la búsqueda de Despegar.
 * 3. **Credenciales completas** (`missingTboCredentials`): usuario, contraseña y URL.
 *
 * La caché es por dueño de la cuenta y por versión (`byoc:{ownerTenantId}:{updatedAt}`): las
 * agencias que heredan la cuenta del consolidador comparten el cliente —es la misma credencial y el
 * mismo cupo—, dos dueños nunca, y al rotar la credencial la entrada vieja se descarta. Basic Auth no
 * tiene sesión (p. 7), así que la clave no necesita más que eso.
 */
@Injectable()
export class TboHotelsProviderFactory implements HotelProviderFactory {
  readonly code = PROVIDER_CODE;
  readonly vertical = 'hotels' as const;

  /**
   * `opt-in` hasta conocer el costo por búsqueda (D-TBO-18 A; Q-87): encenderlo para un tenant es
   * `HOTEL_PROVIDERS_OPT_IN=tbo-hotels@<tenantId>`, y con el flag apagado no se toca ni la bóveda.
   */
  readonly defaultCallPolicy: CallPolicy = 'opt-in';

  /**
   * Se encienden a medida que el ACL implementa cada puerto y este factory lo cablea. Ya están la
   * lectura con BookingDetail y la lectura por nuestra referencia —lo que permite verificar un Book
   * sin `ConfirmationNumber`— (PR-4.2). Faltan la cancelación y las reservas por fecha para la
   * conciliación (PR-5.1): anunciarlas antes haría que la post-venta confiara en un método que
   * responde "no disponible".
   */
  readonly capabilities: HotelProviderCapabilities = {
    retrieve: true,
    cancel: false,
    retrieveByClientReference: true,
    reconcileByDate: false,
  };

  /**
   * Espacio de ids propio (`CityCode` y `HotelCode` de TBO), resuelto con las filas `accepted` de
   * `hotel_destination_map` (PR-2.6). Hasta 100 códigos por búsqueda, "Recommended Value" de p. 10,
   * elegidos por relevancia y no por id (D-TBO-17 A).
   *
   * `contentFromCatalog`: Search no trae nombre, estrellas, dirección ni coordenadas (pp. 13-15);
   * salen de la fila de TBO en `hotel_inventory`, que llena el sync de contenido (Fase 3).
   *
   * Los topes de ocupación son los del contrato, leídos de los mismos `TBO_SEARCH_LIMITS` con que
   * el builder del ACL se niega a armar el Search: así el servicio deja a TBO fuera con motivo
   * ("hasta 4 niños por habitación", p. 11) ANTES de llamarlo, en vez de enterarse por un error
   * del ACL, y las dos reglas no se pueden separar (docs/tbo/02 §3.1).
   *
   * `requiresGuestNationality`: TBO tarifa según la nacionalidad del pasajero principal (p. 10) y
   * pide no fijarla en código (KP-1, p. 71). Sin ella, TBO no participa y se dice por qué (RF-06,
   * D-TBO-14 A); ni la cuenta ni el tenant la completan.
   */
  readonly searchProfile: HotelSearchProfile = {
    idSpace: 'provider',
    maxHotelsPerSearch: TBO_SEARCH_LIMITS.maxHotelCodesPerRequest,
    catalogOrder: 'relevance',
    occupancy: {
      maxRooms: TBO_SEARCH_LIMITS.maxRoomsPerSearch,
      maxAdultsPerRoom: TBO_SEARCH_LIMITS.maxAdultsPerRoom,
      maxChildrenPerRoom: TBO_SEARCH_LIMITS.maxChildrenPerRoom,
      maxChildAge: TBO_SEARCH_LIMITS.maxChildAge,
    },
    requiresGuestNationality: true,
    contentFromCatalog: true,
  };

  private readonly logger = new Logger('TboHotels');
  private readonly cache = new Map<string, TboHotelProviderAdapter>();

  /**
   * UNO por proceso y compartido por todos los clientes: el cupo de QPS es de la cuenta TBO, no de
   * cada adapter (RNF-02). Con un limitador por adapter, rotar la credencial duplicaría el cupo.
   */
  private readonly limiter: TboRateLimiter = new TboInMemoryRateLimiter();

  /**
   * @param payloadWriter la bóveda de payloads (PR-4.9). Sin ella, o apagada por falta de clave,
   *   el ACL no guarda RQ/RS y todo lo demás funciona igual.
   */
  constructor(
    private readonly creds: ProviderCredentialsService,
    @Optional() @Inject(TBO_HOTELS_FETCH) private readonly fetchImpl?: TboFetch,
    @Optional()
    @Inject(PROVIDER_PAYLOAD_WRITER)
    private readonly payloadWriter?: ProviderPayloadWriter,
  ) {}

  async resolveForTenant(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
    // Sin `try/catch`: la `NotFoundException` de la bóveda se propaga tal cual y el registry la
    // traduce a "no habilitado". Atraparla aquí para caer a otra cuenta es lo que este factory NO
    // hace (06 §5.2).
    const resolved = await this.creds.resolve(tenantId, PROVIDER_CODE);
    await this.assertOwnerAllowed(resolved);
    const cfg = this.toConfig(resolved);

    const missing = missingTboCredentials(cfg);
    if (missing.length > 0) {
      // Sólo NOMBRES de campo y el dueño: nunca un valor de la credencial.
      this.logger.warn(
        `cuenta de TBO incompleta de ${resolved.ownerTenantId}: faltan [${missing.join(', ')}] — proveedor NO habilitado`,
      );
      throw new ProviderAccountIncompleteError(PROVIDER_CODE, missing);
    }

    const key = `byoc:${resolved.ownerTenantId}:${resolved.updatedAt.getTime()}`;
    let adapter = this.cache.get(key);
    if (!adapter) {
      // Sin `credentialSource` en el contexto del cliente: el adapter es el mismo para el
      // consolidador y para las agencias que heredan su cuenta, y el primero que lo construyó
      // quedaría grabado en cada línea de log de los demás. La huella de la cuenta sí va: es la
      // misma para todos los que la heredan, y el contexto de cada búsqueda la guarda (RF-08).
      const account = { ownerTenantId: resolved.ownerTenantId };
      adapter = new TboHotelProviderAdapter(
        new TboHotelsAdapter(cfg, this.httpDeps(resolved), account),
        { accountId: resolved.id, updatedAt: resolved.updatedAt.toISOString() },
        cfg.environment,
        new TboStaticContentClient(cfg, this.contentDeps(), account),
      );
      this.cache.set(key, adapter);
      this.evictStale(key);
    }

    return {
      adapter,
      credentialSource: resolved.inherited ? 'inherited' : 'own',
      circuit: { accountRef: adapter.accountRef, effectOf: tboCircuitEffect },
      accountOwnerTenantId: resolved.ownerTenantId,
    };
  }

  /** Nunca hace eco de TBO; con el contexto, le habla a quien puede arreglar la cuenta. */
  humanizeError(err: unknown, context?: ProviderErrorContext): string {
    return humanizeTboError(err, context);
  }

  /**
   * Puerta 1. El tipo se lee del DUEÑO de la cuenta resuelta, no del tenant que busca: una
   * sub-agencia que hereda la cuenta de su agencia madre opera con una cuenta de agencia.
   * Un tenant que no aparece cuenta como no admitido: la puerta falla cerrada.
   */
  private async assertOwnerAllowed(resolved: ResolvedProviderAccount): Promise<void> {
    const ownerType = await this.creds.ownerTenantType(resolved.ownerTenantId);
    if (ownerType !== undefined && ALLOWED_OWNER_TYPES.has(ownerType)) return;

    this.logger.warn(
      `cuenta de TBO de ${resolved.ownerTenantId} (${ownerType ?? 'tenant desconocido'}) no admitida: sólo operan las de la plataforma o un consolidador — proveedor NO habilitado`,
    );
    throw new ProviderAccountNotAllowedError(
      PROVIDER_CODE,
      resolved.inherited ? INHERITED_AGENCY_ACCOUNT : OWN_AGENCY_ACCOUNT,
    );
  }

  /**
   * Puerta 2. `username` y `password` se leen SÓLO del blob cifrado: aceptarlos desde `config`
   * abriría la puerta a guardar la contraseña en un JSONB en claro que el panel devuelve.
   * `environment` y `baseUrl` no son secretos y viven en `config` (RF-37). Nada se recorta: un
   * espacio puede ser parte de la contraseña (Q-06).
   */
  private toConfig(resolved: ResolvedProviderAccount): TboHotelsConfig {
    const { credentials, config } = resolved;
    try {
      return parseTboConfig({
        environment: config['environment'],
        baseUrl: text(config['baseUrl']),
        username: text(credentials['username']),
        password: text(credentials['password']),
      });
    } catch (err) {
      if (!(err instanceof TboConfigError)) throw err;
      // `issues` es `ruta:código`, sin valores: al log entero, a la pantalla sólo el campo.
      this.logger.warn(
        `cuenta de TBO inválida de ${resolved.ownerTenantId}: [${err.issues.join(', ')}] — proveedor NO habilitado`,
      );
      const fields = [...new Set(err.issues.map((issue) => issue.split(':', 1)[0] ?? issue))];
      throw new ProviderAccountIncompleteError(PROVIDER_CODE, fields);
    }
  }

  /**
   * La bóveda de payloads va atada a la cuenta con que se construye el cliente: cada RQ/RS queda
   * con su dueño, que es quien lo puede leer después (0043). El cliente la escribe sin esperarla.
   */
  private httpDeps(resolved: ResolvedProviderAccount): TboHttpDeps {
    const writer = this.payloadWriter;
    return {
      logger: this.loggerPort(),
      limiter: this.limiter,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      ...(writer?.enabled === true
        ? {
            payloadVault: tboPayloadVault(writer, {
              accountId: resolved.id,
              ownerTenantId: resolved.ownerTenantId,
            }),
          }
        : {}),
    };
  }

  /**
   * El contenido bajo demanda (PR-3.6) sale por el MISMO limitador que la venta, en su cupo de
   * fondo, así que nunca le quita capacidad a una búsqueda o a un Book (01 §7.2). No va a la bóveda
   * de payloads: `HotelDetails` no mueve dinero ni es un caso de certificación, y guardaría HTML de
   * catálogo junto a los RQ/RS de las reservas.
   */
  private contentDeps(): TboHttpDeps {
    return {
      logger: this.loggerPort(),
      limiter: this.limiter,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    };
  }

  /**
   * `LoggerPort` sobre el `Logger` de Nest. Lo que el ACL escribe ya pasó por su lista blanca
   * (`pickTboLogMeta`): aquí sólo se le da formato. `child()` acumula los bindings en el prefijo
   * porque Nest no tiene loggers hijos con contexto estructurado.
   */
  private loggerPort(bindings: Record<string, unknown> = {}): LoggerPort {
    const nest = this.logger;
    const prefix = Object.keys(bindings).length === 0 ? '' : `${JSON.stringify(bindings)} `;
    const line = (message: string, meta?: Record<string, unknown>): string =>
      `${prefix}${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`;
    return {
      debug: (message, meta) => nest.debug(line(message, meta)),
      info: (message, meta) => nest.log(line(message, meta)),
      warn: (message, meta) => nest.warn(line(message, meta)),
      error: (message, meta) => nest.error(line(message, meta)),
      child: (extra) => this.loggerPort({ ...bindings, ...extra }),
    };
  }

  /** Conserva sólo la entrada vigente por dueño: al rotar la credencial cambia `updatedAt`. */
  private evictStale(currentKey: string): void {
    const ownerPrefix = currentKey.split(':').slice(0, 2).join(':') + ':';
    for (const key of this.cache.keys()) {
      if (key !== currentKey && key.startsWith(ownerPrefix)) this.cache.delete(key);
    }
  }
}

/** Un texto con algo, sin tocarlo; cualquier otra cosa cuenta como ausente. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
