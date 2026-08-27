import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  OfferPriceResult,
  OrderCancelResult,
  OrderCreateRequest,
  OrderCreateResult,
  OrderPayRequest,
  OrderPayResult,
  OrderReshopRequest,
  OrderReshopResult,
  OrderView,
  SearchContext,
  ServiceListRequest,
  ServiceListResult,
} from '@sales-travel/domain';
import {
  SABRE_HOSTS,
  SabreFlightSearchAdapter,
  SabreHttpClient,
  SabreOfferPriceAdapter,
  SabreOrderCreateAdapter,
  SabreOrderManageAdapter,
  SabreTokenService,
  cancellableItemsOf,
  parseSabreConfig,
  type SabreCancelOptions,
  type SabreCardBinPricingPolicy,
  type SabreConfig,
  type SabreEnvironment,
} from '@sales-travel/sabre';
import { z } from '@sales-travel/validation';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import {
  CallPolicySchema,
  type CallPolicy,
  type CredentialSource,
  type FlightProviderAdapter,
  type OrderCancelAudit,
  type OrderCreateAudit,
  type ProviderCapabilities,
  type ProviderVertical,
  type TenantAdapter,
  type TenantProviderFactory,
} from '../providers/provider.types.js';
import {
  SabreMockBookingError,
  SabreOperationNotSupportedError,
  humanizeSabreError,
} from './sabre-errors.js';

export const SABRE_PROVIDER_CODE = 'sabre';

/**
 * Entorno por defecto cuando la cuenta no lo declara.
 *
 * `cert` y no `prod` a propósito: una cuenta a la que le falte el campo tiene que salir al
 * entorno que NO factura ni emite. El coste de equivocarse hacia `cert` es una búsqueda sin
 * resultados reales —visible—; el de equivocarse hacia `prod` es consumir cuota facturada
 * de una oficina con una configuración que nadie revisó.
 */
const SABRE_DEFAULT_ENVIRONMENT: SabreEnvironment = 'cert';

/** Marcador del PCC en la clave de caché cuando la cuenta no lo trae (sólo cuentas en mock declarado). */
const SIN_PCC = 'sin-pcc';

/**
 * `config.allowCardBinPricing` sólo puede ser un booleano. `optional()` y no `default(false)`:
 * el default vive en {@link SabreProviderFactory.cardBinPolicy}, donde además se registra, y un
 * `default` aquí escondería que la cuenta no dijo nada.
 */
const AllowCardBinPricingSchema = z.boolean().optional();

/**
 * La postura de D1 escrita una sola vez: no se tarifica con datos de tarjeta.
 *
 * Es una constante y no un objeto nuevo por adapter para que no haya dos copias de la misma
 * regla — el paquete ya pagó cinco veces la avería de la copia rancia.
 */
const DENY_ALL_CARD_BIN_PRICING: SabreCardBinPricingPolicy = {
  isAllowedForTenant: () => Promise.resolve(false),
};

/**
 * Los cuatro adapters del ACL de Sabre que componen un proveedor de vuelos, ya construidos sobre
 * el MISMO `SabreHttpClient` — y por tanto sobre el mismo token: el TAM Pool es un límite por
 * contrato de agencia, y cuatro adapters autenticando por su cuenta es la forma de agotarlo.
 */
interface SabreAdapterSet {
  readonly search: SabreFlightSearchAdapter;
  readonly price: SabreOfferPriceAdapter;
  readonly create: SabreOrderCreateAdapter;
  readonly manage: SabreOrderManageAdapter;
}

/**
 * Adapter de vuelos COMPLETO sobre el ACL de Sabre: búsqueda, revalidación de precio, creación,
 * lectura y cancelación.
 *
 * Hasta esta tanda esta clase rechazaba TODO menos `search`, porque `@sales-travel/sabre` sólo
 * implementaba `FlightSearchPort`. Ya no: `price/`, `booking/create.*`, `booking/get.*` y
 * `booking/cancel.*` están escritos y probados, y **este fichero es el único sitio desde el que
 * producción los alcanza**. Sin estas líneas, esos módulos son código muerto con tests verdes,
 * que es exactamente la avería que este paquete ya pagó cinco veces.
 *
 * Lo que sigue rechazando —y por qué NO es un `TODO`—:
 *
 *  - `payOrder`, `listServices`, `reshopWithTickets`, `cancelBnplOrder`: no son operaciones de
 *    este contrato. Fingirlas con un resultado plausible es lo que vende un asiento que no existe.
 *  - Todo el bloque de reserva cuando la cuenta corre en **mock declarado**: las ofertas
 *    sintéticas tienen la misma forma canónica que las reales, y reservar contra un precio
 *    inventado es peor que no poder reservar.
 */
export class SabreFlightProviderAdapter implements FlightProviderAdapter {
  constructor(private readonly inner: SabreAdapterSet) {}

  /** Verdad declarada por el ACL, no recalculada aquí: una segunda copia de la regla deriva. */
  get isMock(): boolean {
    return this.inner.search.isMock;
  }

  get missingCredentials(): readonly string[] {
    return this.inner.search.missingCredentials;
  }

  search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    return this.inner.search.search(criteria, ctx);
  }

  priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    return this.notInMock('revalidar el precio', () =>
      this.inner.price.priceOffer(offer, criteria, ctx),
    );
  }

  createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult> {
    return this.notInMock('crear la reserva', () => this.inner.create.createOrder(request, ctx));
  }

  /**
   * La creación CON las decisiones que se tomaron al mandarla (`AuditedOrderCreatePort`).
   *
   * `hasVersionStamp` sale siempre `false` con Sabre porque `createBooking` no devuelve
   * `bookingSignature`; el saga lo lee como lo que es: la señal de que la lectura de cierre no
   * es opcional.
   */
  createOrderAudited(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateAudit> {
    return this.notInMock('crear la reserva', async () => {
      const outcome = await this.inner.create.createBooking(request, ctx);
      return {
        result: outcome.result,
        audit: {
          audited: true,
          provider: SABRE_PROVIDER_CODE,
          // La política con la que se pidió. Es un parámetro de ENTRADA de `createBooking`
          // (8 valores, default `HALT_ON_ERROR`): un `PARTIAL` sin ella no se puede explicar.
          errorHandlingPolicy: [...outcome.errorHandlingPolicy],
          asynchronousUpdateWaitTimeMs: outcome.asynchronousUpdateWaitTimeMs,
          advisories: [...outcome.advisories],
          carriers: [...outcome.carriers],
          conversationId: outcome.conversationId,
          hasBookingSignature: outcome.hasBookingSignature,
        },
        providerRaw: outcome.providerRaw,
        hasVersionStamp: outcome.hasBookingSignature,
      };
    });
  }

  retrieveForDisplay(orderId: string, ctx: SearchContext): Promise<OrderView> {
    return this.notInMock('consultar la reserva', () =>
      this.inner.manage.retrieveForDisplay(orderId, ctx),
    );
  }

  cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    return this.notInMock('cancelar la reserva', () => this.inner.manage.cancelOrder(orderId, ctx));
  }

  /**
   * Cancelación auditada, con el ámbito OPCIONAL de la compensación selectiva
   * (`AuditedOrderCancelPort`).
   *
   * Con `scope.itemIds` se cancela **por `itemId`**, nunca con un `cancelAll` ciego: en un éxito
   * parcial hay ítems que sí quedaron confirmados, y tirar de la manta cancela también lo que
   * estaba bien. Para armar ese ámbito hace falta el `kind` de cada ítem, que sólo lo sabe la
   * lectura — de ahí la lectura extra de este camino. Cuesta una llamada más y sólo ocurre en la
   * compensación, que no es el camino caliente.
   *
   * Si NINGUNO de los ítems pedidos sigue vivo en la reserva, **no se cancela nada** y se
   * devuelve el hecho. Degradar a `scope: 'ALL'` porque el filtro salió vacío sería justo el
   * cancelAll ciego, escrito de una forma en la que no se ve.
   */
  async cancelOrderAudited(
    orderId: string,
    ctx: SearchContext,
    scope?: { readonly itemIds?: readonly string[] },
  ): Promise<OrderCancelAudit> {
    return this.notInMock('cancelar la reserva', async () => {
      const itemIds = scope?.itemIds;
      let items: SabreCancelOptions['items'];

      if (itemIds !== undefined && itemIds.length > 0) {
        const snapshot = await this.inner.manage.snapshotForDisplay(orderId, ctx);
        const wanted = new Set(itemIds);
        items = cancellableItemsOf(snapshot).filter((item) => wanted.has(item.itemId));
        if (items.length === 0) {
          return {
            result: {
              success: false,
              warnings: ['compensation-targets-gone'],
              error:
                'ninguno de los ítems a compensar sigue presente en la reserva: no se canceló nada',
            },
            audit: {
              audited: true,
              provider: SABRE_PROVIDER_CODE,
              scope: 'ITEMS',
              requestedItems: itemIds.length,
              matchedItems: 0,
              called: false,
            },
            verified: true,
          };
        }
      }

      const outcome = await this.inner.manage.cancelBooking(
        orderId,
        ctx,
        items === undefined ? {} : { scope: 'ITEMS', items },
      );

      return {
        result: outcome.result,
        audit: {
          audited: true,
          provider: SABRE_PROVIDER_CODE,
          scope: items === undefined ? 'ALL' : 'ITEMS',
          ...(items === undefined ? {} : { matchedItems: items.length }),
          called: true,
          outcome: outcome.outcome,
          errorHandlingPolicy: outcome.errorHandlingPolicy,
          ticketCheckPerformed: outcome.ticketCheckPerformed,
          conversationId: outcome.conversationId,
          ...outcome.shape,
        },
        idempotencyKey: outcome.idempotencyKey,
        // `UNVERIFIED` es "el proveedor no dijo qué pasó": el saga NO puede reintentar a ciegas.
        verified: outcome.outcome !== 'UNVERIFIED',
      };
    });
  }

  cancelBnplOrder(_orderId: string, _ctx: SearchContext): Promise<OrderCancelResult> {
    return Promise.reject(new SabreOperationNotSupportedError('cancelar la reserva diferida'));
  }

  payOrder(_request: OrderPayRequest, _ctx: SearchContext): Promise<OrderPayResult> {
    return Promise.reject(new SabreOperationNotSupportedError('pagar la reserva'));
  }

  listServices(_request: ServiceListRequest, _ctx: SearchContext): Promise<ServiceListResult> {
    return Promise.reject(new SabreOperationNotSupportedError('listar servicios'));
  }

  reshopWithTickets(_request: OrderReshopRequest, _ctx: SearchContext): Promise<OrderReshopResult> {
    return Promise.reject(new SabreOperationNotSupportedError('recotizar con billetes'));
  }

  /**
   * Puerta única del bloque de reserva: una cuenta en mock DECLARADO busca, pero no reserva.
   *
   * Está aquí y no en cada método para que añadir una operación nueva no pueda olvidarse de la
   * comprobación: quien no la pase por `notInMock` se ve a simple vista.
   */
  private notInMock<T>(operation: string, run: () => Promise<T>): Promise<T> {
    if (this.isMock) return Promise.reject(new SabreMockBookingError(operation));
    return run();
  }
}

/**
 * Factory de adapters de Sabre por tenant (BYOC). Espejo de `LatamNdcProviderFactory` **con una
 * diferencia deliberada: no hay rama `env`**.
 *
 * LATAM cae a credenciales de plataforma porque es el proveedor legacy con el que se vendía
 * antes de que existiera la bóveda BYOC. Sabre no tiene ese pasado y no puede heredar ese
 * comportamiento: prestarle la cuenta de la plataforma a un tenant que no la pidió significa
 * consultas facturadas a quien no las encargó y, peor, tarifas de un PCC que no es el suyo
 * saliendo en una cotización con su marca. Sin cuenta resoluble, `resolveForTenant` lanza
 * `NotFoundException` y el registry deja a Sabre **ausente** de la búsqueda
 * (`docs/sabre/11-plan-implementacion.md` §7, D5).
 */
@Injectable()
export class SabreProviderFactory implements TenantProviderFactory<FlightProviderAdapter> {
  readonly code = SABRE_PROVIDER_CODE;
  readonly vertical: ProviderVertical = 'flights';

  /**
   * `opt-in` y no `always`, hasta que la compuerta comercial responda **P-01** (cómo tarifa
   * Sabre: por búsqueda, por `RequestType` o por reserva — `11-plan-implementacion.md` §5.1).
   *
   * BFM está marcado `premium` en el catálogo de Sabre y §5.2 dice literalmente que un fee por
   * búsqueda que no quepa en el margen del waterfall es **NO-GO en `callPolicy: always`**.
   * Arrancar en `always` sería tomar por defecto la decisión que el founder todavía no tomó, y
   * el coste de esa decisión llega en una factura, no en un test rojo.
   *
   * Consecuencia operativa: Sabre se cotiza por defecto cuando la cuenta está activa
   * en provider_accounts, salvo que se configure explícitamente callPolicy: opt-in o fallback.
   */
  readonly defaultCallPolicy: CallPolicy = 'always';

  /**
   * Lo que Sabre sabe hacer HOY, ni más ni menos.
   *
   * `retrieve` y `cancel` en `true` desde esta tanda: `getBooking` (las dos lecturas) y
   * `cancelBooking` están implementados y cableados arriba. `retrieve` además no es sólo una
   * pantalla — es lo que el saga de creación consulta para saber si puede CERRAR una reserva
   * verificándola; con `retrieve: false` toda creación de Sabre acabaría escalada.
   *
   * `pay`, `services` y `reshop` siguen en `false` y no es un olvido: no son operaciones de este
   * contrato. Es lo que hace que `OrdersController.assertSupports` las rechace con un mensaje
   * claro en vez de mandarlas a un adapter que no las implementa.
   */
  readonly capabilities: ProviderCapabilities = {
    retrieve: true,
    cancel: true,
    pay: false,
    services: false,
    reshop: false,
  };

  private readonly logger = new Logger('Sabre');
  private readonly cache = new Map<string, SabreFlightProviderAdapter>();

  constructor(private readonly creds: ProviderCredentialsService) {}

  async forTenant(tenantId: string): Promise<FlightProviderAdapter> {
    return (await this.resolveForTenant(tenantId)).adapter;
  }

  async resolveForTenant(tenantId: string): Promise<TenantAdapter<FlightProviderAdapter>> {
    // Sin `try/catch`: la `NotFoundException` de la bóveda —tenant sin cuenta propia ni
    // heredable, o cuenta todavía en `status: 'sandbox'`— se propaga tal cual y el registry la
    // traduce a "proveedor no habilitado". Atraparla aquí para caer a env es exactamente lo
    // que este factory NO hace.
    const resolved = await this.creds.resolve(tenantId, SABRE_PROVIDER_CODE);
    const cfg = this.toConfig(resolved.credentials, resolved.config);

    // El `homePcc` entra en la clave porque entra en el `clientId` del que se deriva el ATK:
    // dos cuentas del mismo dueño con PCC distinto NO pueden compartir instancia ni token.
    // No es secreto —se imprime en el billete—, así que puede vivir en una clave de caché.
    const key = `byoc:${resolved.ownerTenantId}:${cfg.homePcc ?? SIN_PCC}:${resolved.updatedAt.getTime()}`;
    const credentialSource: CredentialSource = resolved.inherited ? 'inherited' : 'own';
    const callPolicy = this.declaredCallPolicy(resolved.config, resolved.ownerTenantId);

    const cached = this.cache.get(key);
    if (cached) return { adapter: cached, credentialSource, callPolicy };

    const adapter = new SabreFlightProviderAdapter(
      this.buildAdapters(cfg, resolved.ownerTenantId, resolved.config),
    );

    // Se LEE el veredicto del propio adapter en vez de recalcularlo: `isMock` es suyo y una
    // segunda copia de la regla aquí es la avería que este paquete ya pagó cinco veces.
    //
    // Y una cuenta que cae en mock SIN haberlo pedido no se sirve: `SabreFlightSearchAdapter`
    // devuelve fixtures con la misma forma canónica que las tarifas reales, así que el tenant
    // cotizaría precios inventados con aspecto de reales. Un mock DECLARADO (`config.mock`) sí
    // pasa: es una decisión, va marcado como `simulated` en la respuesta y no se cachea.
    if (adapter.isMock && cfg.mock !== true) {
      this.logger.warn(
        `cuenta de Sabre incompleta para ${resolved.ownerTenantId}: faltan [${adapter.missingCredentials.join(', ')}] — proveedor NO habilitado`,
      );
      throw new NotFoundException(
        `la cuenta de Sabre resoluble desde ${tenantId} está incompleta (faltan: ${adapter.missingCredentials.join(', ')})`,
      );
    }

    this.cache.set(key, adapter);
    this.evictStale(key);
    return { adapter, credentialSource, callPolicy };
  }

  /** Los errores del ACL ya tienen traducción propia, y NO hace eco del texto de Sabre. */
  humanizeError(err: unknown): string {
    return humanizeSabreError(err);
  }

  /**
   * Construye los cuatro adapters del ACL sobre UN token y UN cliente HTTP.
   *
   * `SabreFlightSearchAdapter` fabrica su propio cliente, pero acepta que le inyecten el proveedor
   * de tokens; así los cuatro comparten el ATK, que es lo que importa: el TAM Pool es un límite
   * **por contrato de agencia** y cuatro adapters autenticando por su cuenta lo agotan
   * (docs/sabre/01 §7.1).
   */
  private buildAdapters(
    cfg: SabreConfig,
    ownerTenantId: string,
    config: Record<string, unknown>,
  ): SabreAdapterSet {
    const tokens = new SabreTokenService(cfg, { cacheNamespace: ownerTenantId });
    const http = new SabreHttpClient(cfg, tokens);
    const cardBinPricing = this.cardBinPolicy(config, ownerTenantId);

    return {
      search: new SabreFlightSearchAdapter(cfg, { cacheNamespace: ownerTenantId, tokens }),
      price: new SabreOfferPriceAdapter(cfg, http, { cardBinPricing }),
      create: new SabreOrderCreateAdapter(cfg, http),
      manage: new SabreOrderManageAdapter(cfg, http),
    };
  }

  /**
   * D1 por tenant: ¿esta cuenta puede tarificar mandando BIN/tipo de tarjeta?
   *
   * **Nace apagada.** El ACL ya trae `DENY_CARD_BIN_PRICING` como default, y esto es lo que
   * convierte ese default en una decisión POR TENANT en vez de un booleano que un llamador pone
   * a `true` porque compila: el único sitio que puede encenderlo es la cuenta de la agencia
   * (`provider_accounts.config.allowCardBinPricing`), que es dato administrado y auditable.
   *
   * El día que Unleash esté aprovisionado, este método pasa a consultarlo y nada más cambia: el
   * ACL sigue viendo un puerto.
   *
   * Ojo con el alcance: la cuenta resuelta puede ser HEREDADA del consolidador, y entonces la
   * sub-agencia hereda también esta decisión — igual que hereda las credenciales. Es la misma
   * jerarquía, no una excepción.
   */
  private cardBinPolicy(
    config: Record<string, unknown>,
    ownerTenantId: string,
  ): SabreCardBinPricingPolicy {
    const parsed = AllowCardBinPricingSchema.safeParse(config['allowCardBinPricing']);
    if (!parsed.success) {
      // Un valor mal tipado NO enciende nada: apagado es la postura por defecto de D1.
      this.logger.warn(
        `config.allowCardBinPricing inválida en la cuenta de Sabre de ${ownerTenantId}: se ignora (queda apagada)`,
      );
      return DENY_ALL_CARD_BIN_PRICING;
    }
    if (parsed.data !== true) return DENY_ALL_CARD_BIN_PRICING;

    // Encenderlo es una excepción a la postura PCI SAQ-A: tiene que verse en el log de arranque.
    this.logger.warn(
      `la cuenta de Sabre de ${ownerTenantId} tiene ACTIVADA la tarificación con BIN de tarjeta (D1: excepción por tenant)`,
    );
    return { isAllowedForTenant: () => Promise.resolve(true) };
  }

  /**
   * `callPolicy` declarada por la cuenta del tenant. `undefined` = la cuenta no opina y manda
   * `defaultCallPolicy`.
   *
   * Se valida con el mismo Zod que usa el registry para el override de entorno: un valor mal
   * escrito en el JSONB de la cuenta no puede convertirse en un proveedor que deja de
   * llamarse sin que nadie lo note. Aquí se avisa y se ignora —una credencial mal tipada no
   * puede tumbar la búsqueda de un tenant que sí tiene el resto bien.
   */
  private declaredCallPolicy(
    config: Record<string, unknown>,
    ownerTenantId: string,
  ): CallPolicy | undefined {
    const raw = config['callPolicy'];
    if (raw === undefined) return undefined;

    const parsed = CallPolicySchema.safeParse(raw);
    if (!parsed.success) {
      // Sólo el nombre del campo y el dueño; nunca el valor: el JSONB de la cuenta es del tenant.
      this.logger.warn(
        `config.callPolicy inválida en la cuenta de Sabre de ${ownerTenantId}: se ignora y se usa '${this.defaultCallPolicy}'`,
      );
      return undefined;
    }
    return parsed.data;
  }

  /** Conserva sólo la entrada vigente por owner: al rotar credenciales cambia el `updatedAt`. */
  private evictStale(currentKey: string): void {
    const ownerPrefix = currentKey.split(':').slice(0, 2).join(':') + ':';
    for (const k of this.cache.keys()) {
      if (k !== currentKey && k.startsWith(ownerPrefix)) this.cache.delete(k);
    }
  }

  /**
   * Une las dos mitades de `provider_accounts` (secreto descifrado + `config` en claro) y las
   * valida con Zod, que es el borde. `epr`, `password` y `homePcc` se aceptan desde cualquiera
   * de las dos mitades porque el formulario del panel las guarda juntas y el `homePcc` no es
   * secreto: quien lo tenga en `config` no está haciendo nada malo.
   */
  private toConfig(
    credentials: Record<string, unknown>,
    config: Record<string, unknown>,
  ): SabreConfig {
    const c = credentials;
    const g = config;
    const environment = g['environment'] === 'prod' ? 'prod' : SABRE_DEFAULT_ENVIRONMENT;
    const hosts = SABRE_HOSTS[environment];

    // `password` sólo se lee del blob CIFRADO. Aceptarlo también desde `config` —como sí se
    // hace con `epr` y `homePcc`, que no son secretos— abriría una puerta para guardar la
    // contraseña de la oficina en un JSONB en claro que además se devuelve por `listSafe`.
    return parseSabreConfig({
      host: str(g['host']) ?? hosts.rest,
      soapHost: str(g['soapHost']) ?? hosts.soap,
      environment,
      epr: str(c['epr']) ?? str(g['epr']),
      password: str(c['password']),
      homePcc: str(c['homePcc']) ?? str(g['homePcc']),
      ticketingPcc: str(c['ticketingPcc']) ?? str(g['ticketingPcc']),
      agencyIata: str(g['agencyIata']),
      domain: str(g['domain']),
      applicationId: str(g['applicationId']),
      sabreGroup: str(g['sabreGroup']),
      sabreCurrentCity: str(g['sabreCurrentCity']),
      mock: g['mock'] === true ? true : undefined,
    });
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
