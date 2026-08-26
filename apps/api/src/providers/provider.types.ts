import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type {
  FlightSearchPort,
  OfferPricePort,
  OrderCancelResult,
  OrderCreatePort,
  OrderCreateRequest,
  OrderCreateResult,
  OrderManagePort,
  SearchContext,
} from '@sales-travel/domain';
import { z } from '@sales-travel/validation';

/** Un adapter de vuelos = los cuatro ports del dominio + la señal de modo mock. */
export interface FlightProviderAdapter
  extends FlightSearchPort,
    OfferPricePort,
    OrderCreatePort,
    OrderManagePort {
  readonly isMock: boolean;
}

/**
 * Lo que una creación de reserva entrega ADEMÁS del `OrderCreateResult` del dominio.
 *
 * Existe porque el puerto del dominio no tiene —ni debe tener— sitio para las decisiones con
 * las que se mandó la llamada, y esas decisiones son justo lo que hay que auditar: en Sabre,
 * `errorHandlingPolicy` es un parámetro de ENTRADA de `createBooking` con ocho valores
 * (`booking-management-v1.yml:698`, `:8918-8935`), así que un `PARTIAL` sin saber qué se pidió
 * tolerar es una reserva a medias que nadie puede explicar tres semanas después.
 *
 * Es un puerto OPCIONAL: un proveedor que no lo implemente sigue funcionando y el saga anota
 * en el `domain_event` que la creación no vino auditada, en vez de fingir una política vacía.
 */
export interface OrderCreateAudit {
  readonly result: OrderCreateResult;
  /**
   * Lo que el `domain_event` cita: vocabulario cerrado, códigos propios y conteos. NUNCA texto
   * libre del proveedor, PII ni datos de tarjeta — el payload de `domain_events` se persiste
   * para siempre y se lee desde el panel de red.
   */
  readonly audit: Readonly<Record<string, unknown>>;
  /** Lo que se persiste en `orders.provider_raw`. Lista blanca, nunca un volcado. */
  readonly providerRaw: Readonly<Record<string, unknown>>;
  /**
   * `false` ⇒ la creación no devolvió sello de concurrencia y toda modificación posterior exige
   * encadenar una lectura. Con Sabre es SIEMPRE `false` (`createBooking` no devuelve
   * `bookingSignature`), y es la señal de que el paso de verificación del saga no es opcional.
   */
  readonly hasVersionStamp: boolean;
}

export interface AuditedOrderCreatePort {
  createOrderAudited(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateAudit>;
}

/** Igual que {@link OrderCreateAudit}, para la cancelación. */
export interface OrderCancelAudit {
  readonly result: OrderCancelResult;
  readonly audit: Readonly<Record<string, unknown>>;
  /**
   * Clave de deduplicación del saga. El cliente HTTP NO reintenta una cancelación —un timeout no
   * dice si se ejecutó—, así que quien reintenta es el saga y necesita reconocer que el segundo
   * intento es el mismo paso.
   */
  readonly idempotencyKey?: string;
  /**
   * `false` ⇒ el proveedor no confirmó qué pasó (`UNVERIFIED`). **PROHIBIDO REINTENTAR**: hay que
   * releer la reserva y comparar. Reintentar a ciegas puede cancelar lo que sobrevivió.
   */
  readonly verified: boolean;
}

/** Ámbito de una compensación selectiva. Ausente = se cancela la reserva entera. */
export interface OrderCancelScope {
  /**
   * Ítems concretos a cancelar. Es la única forma de deshacer un éxito parcial sin tirar de la
   * manta: en un `PARTIAL` hay ítems que sí quedaron confirmados, y un `cancelAll` ciego cancela
   * también lo que estaba bien.
   */
  readonly itemIds?: readonly string[];
}

export interface AuditedOrderCancelPort {
  cancelOrderAudited(
    orderId: string,
    ctx: SearchContext,
    scope?: OrderCancelScope,
  ): Promise<OrderCancelAudit>;
}

/**
 * ¿Este adapter sabe entregar la creación auditada?
 *
 * Se comprueba por la PRESENCIA del método y no por `instanceof`: el registry entrega
 * `FlightProviderAdapter`, y atar el saga a una clase concreta de un proveedor es exactamente
 * el `if (provider === 'x')` que este paquete lleva dos rondas quitando.
 */
export function supportsAuditedCreate<T extends object>(
  adapter: T,
): adapter is T & AuditedOrderCreatePort {
  return typeof (adapter as { createOrderAudited?: unknown }).createOrderAudited === 'function';
}

export function supportsAuditedCancel<T extends object>(
  adapter: T,
): adapter is T & AuditedOrderCancelPort {
  return typeof (adapter as { cancelOrderAudited?: unknown }).cancelOrderAudited === 'function';
}

/**
 * Qué sabe hacer un proveedor. Existe para que la post-venta se gatee por capacidad y no
 * por `if (provider === '<uno concreto>')`: ese `if` hay que tocarlo cada vez que entra un
 * proveedor nuevo y es exactamente lo que rompe cuando alguien se olvida.
 */
export interface ProviderCapabilities {
  readonly retrieve: boolean;
  readonly cancel: boolean;
  /** Pago/emisión diferida (el "compre ahora, pague después" de LATAM). */
  readonly pay: boolean;
  /** Ancillaries: equipaje, asientos y demás servicios sueltos. */
  readonly services: boolean;
  readonly reshop: boolean;
}

export type ProviderCapability = keyof ProviderCapabilities;

/**
 * Cuándo se llama a un proveedor dentro del fan-out.
 *
 * - `always`: en cada búsqueda.
 * - `fallback`: sólo si la primera ola devolvió menos de `FALLBACK_MIN_OFFERS` ofertas.
 * - `opt-in`: sólo si el tenant lo tiene activado por flag.
 *
 * Existe desde el día 1 con un solo proveedor a propósito: el fee por búsqueda de un GDS
 * puede llegar a inviabilizar el endpoint de más volumen, y el día que se conozca ese
 * número el coste tiene que ser gobernable sin volver a tocar el fan-out.
 */
export const CallPolicySchema = z.enum(['always', 'fallback', 'opt-in']);
export type CallPolicy = z.infer<typeof CallPolicySchema>;

/** De dónde salieron las credenciales con las que se construyó el adapter. */
export type CredentialSource = 'own' | 'inherited' | 'env';

export type ProviderVertical = 'flights' | 'hotels' | 'cars';

export interface TenantAdapter<TAdapter> {
  readonly adapter: TAdapter;
  readonly credentialSource: CredentialSource;
  /**
   * `callPolicy` declarada por la CUENTA del tenant (`provider_accounts.config.callPolicy`).
   * `undefined` = la cuenta no opina y manda el `defaultCallPolicy` del factory.
   *
   * Existe porque un proveedor que cobra por consulta no se gobierna igual para todos: un
   * consolidador con volumen puede querer Sabre en cada búsqueda y una agencia pequeña sólo
   * como respaldo, con las MISMAS credenciales heredadas. Sin esto la única palanca era una
   * variable de entorno global, que es una decisión para toda la plataforma.
   *
   * Sólo dice **cuándo** se llama a un proveedor ya encendido; **no** lo enciende: el
   * interruptor por tenant de un proveedor `opt-in` sigue siendo el flag (ver `forTenant`).
   * Y el override de entorno gana sobre esto: es el kill-switch de operaciones.
   */
  readonly callPolicy?: CallPolicy | undefined;
}

/**
 * Contrato que los factories por proveedor ya cumplían de facto, sin declararlo.
 *
 * `forTenant` se conserva porque es la firma que usaba el resto de la app; `resolveForTenant`
 * añade el dato que el registry necesita y `forTenant` no puede dar: si las credenciales son
 * del tenant, heredadas del consolidador o de la plataforma.
 */
export interface TenantProviderFactory<TAdapter> {
  readonly code: string;
  readonly vertical: ProviderVertical;
  readonly capabilities: ProviderCapabilities;
  readonly defaultCallPolicy: CallPolicy;
  /** Lanza `NotFoundException` si el tenant no resuelve credenciales y no hay fallback. */
  forTenant(tenantId: string): Promise<TAdapter>;
  resolveForTenant(tenantId: string): Promise<TenantAdapter<TAdapter>>;
  /**
   * Traduce un error del proveedor a un mensaje para el vendedor. Vive en el factory —y no
   * en el servicio de búsqueda— para que el fan-out no tenga que conocer los tipos de error
   * de ningún proveedor concreto.
   */
  humanizeError(err: unknown): string;
}

export interface ResolvedProvider<TAdapter> {
  readonly code: string;
  readonly adapter: TAdapter;
  /** `adapter.isMock`: el proveedor va a devolver fixtures, no tarifas reales. */
  readonly simulated: boolean;
  readonly credentialSource: CredentialSource;
  readonly capabilities: ProviderCapabilities;
  readonly callPolicy: CallPolicy;
}

/** Por qué un proveedor habilitado no llegó a ser llamado en esta búsqueda. */
export type SkipReason = 'opt-in-disabled' | 'fallback-not-needed';

export interface SkippedProvider {
  readonly code: string;
  readonly reason: SkipReason;
}

export interface FlightProviderResolution {
  /** Proveedores llamables, en orden ESTABLE (alfabético por code). */
  readonly active: ResolvedProvider<FlightProviderAdapter>[];
  /** Habilitados pero no llamados en esta búsqueda, con el motivo. */
  readonly skipped: SkippedProvider[];
}

/**
 * Qué pasó con cada proveedor en una búsqueda. Viaja en la respuesta del endpoint: sin esto,
 * una degradación parcial (un proveedor cayó, otro respondió) se veía como una lista de
 * resultados normal, sólo que más corta, y nadie se enteraba de que faltaba media oferta.
 */
export interface ProviderOutcome {
  readonly code: string;
  readonly status: 'ok' | 'empty' | 'error' | 'simulated' | 'skipped';
  readonly count: number;
  /**
   * Semántica NUEVA, por proveedor: estas tarifas son inventadas. El `simulated` de la
   * raíz de la respuesta conserva la semántica vieja (todo el resultado es falso) porque
   * `apps/web-b2b` la lee hoy.
   */
  readonly simulated: boolean;
  /** Ya humanizado por el factory del proveedor. Sólo si `status === 'error'`. */
  readonly reason?: string;
  /** Sólo si `status === 'skipped'`. */
  readonly skipReason?: SkipReason;
}

/** Token DI del listado de factories de vuelos. Sumar un proveedor = una línea en el módulo. */
export const FLIGHT_PROVIDER_FACTORIES = 'FLIGHT_PROVIDER_FACTORIES';

/** Token DI del gobierno por tenant de `callPolicy: 'opt-in'`. */
export const FLIGHT_PROVIDER_FLAGS = 'FLIGHT_PROVIDER_FLAGS';

export interface ProviderFlagsPort {
  /** ¿El tenant activó este proveedor? Sólo se consulta para `callPolicy: 'opt-in'`. */
  isEnabledForTenant(tenantId: string, providerCode: string): Promise<boolean>;
}

/**
 * Fallo de UN proveedor, ya con el motivo humanizado y con el code del proveedor pegado.
 * Se lanza dentro de la rama del fan-out para que el agregador no tenga que saber traducir
 * errores de nadie.
 */
export class ProviderCallError extends Error {
  constructor(
    readonly providerCode: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

/**
 * TODOS los proveedores fallaron. Es 502 y no 500: el fallo es del sistema de al lado, no
 * nuestro, y devolver una lista vacía sería peor que fallar — el vendedor la leería como
 * "no hay vuelos" y se lo diría a su cliente.
 */
export class AllFlightProvidersFailedError extends BadGatewayException {
  constructor(readonly failures: { code: string; reason: string }[]) {
    super(failures.map((f) => `${f.code}: ${f.reason}`).join('; '));
    this.name = 'AllFlightProvidersFailedError';
  }
}

/**
 * Se pidió operar con un proveedor que este tenant no tiene habilitado. Es 400 y no 500:
 * el dato viene del cliente (`offer.provider.name`, `orders.provider`).
 */
export class ProviderNotAvailableError extends BadRequestException {
  constructor(readonly providerCode: string) {
    super(
      `El proveedor '${providerCode}' no está habilitado para esta agencia. Revisá Mi Red → Credenciales.`,
    );
    this.name = 'ProviderNotAvailableError';
  }
}
