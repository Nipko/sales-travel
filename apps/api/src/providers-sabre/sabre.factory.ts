import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { LoggerPort } from '@sales-travel/core';
import type {
  AncillaryCatalog,
  Offer,
  ProviderEnvironment,
  SeatMap,
} from '@sales-travel/canonical';
import {
  OrderCreateNotSentError,
  type AncillaryAddResult,
  type AncillaryOrderRef,
  type AncillaryPort,
  type AncillaryRemoveResult,
  type AncillarySelection,
  type FlightSearchCriteria,
  type OfferPriceResult,
  type OrderCancelResult,
  type OrderCreateRequest,
  type OrderCreateResult,
  type OrderModifyPort,
  type OrderModifyRef,
  type OrderModifyResult,
  type OrderPayRequest,
  type OrderPayResult,
  type OrderReshopRequest,
  type OrderReshopResult,
  type OrderTravelersView,
  type OrderView,
  type SearchContext,
  type SeatMapPort,
  type ServiceListRequest,
  type ServiceListResult,
  type TicketCheckResult,
  type TicketIssueOptions,
  type TicketIssueResult,
  type TicketingPort,
  type TravelerChange,
  type TravelerModification,
} from '@sales-travel/domain';
import {
  SABRE_HOSTS,
  SABRE_PCC_PATTERN,
  SabreAncillaryAdapter,
  SabreFlightCheckAdapter,
  SabreFlightSearchAdapter,
  SabreCancelBookingBuildError,
  SabreHttpClient,
  SabreOfferPriceAdapter,
  SabreOrderCreateAdapter,
  SabreOrderManageAdapter,
  SabreSeatMapAdapter,
  SabreShopOptionsSchema,
  SabreTicketingAdapter,
  SabreTicketingSettingsSchema,
  SabreTokenService,
  cancellableItemsOf,
  isSabrePccTimeZone,
  missingSabreCredentials,
  parseSabreConfig,
  sabreEnvironmentOfHosts,
  type SabreCancelOptions,
  type SabreCardBinPricingPolicy,
  type SabreConfig,
  type SabreEnvironment,
  type SabreOrderCreateOptions,
  type SabreShopOptions,
  type SabreTicketingSettings,
} from '@sales-travel/sabre';
import { z } from '@sales-travel/validation';
import {
  ProviderCredentialsService,
  type ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import {
  CallPolicySchema,
  ProviderAccountIncompleteError,
  ProviderAccountNotAllowedError,
  TicketVoidNotAvailableError,
  type CallPolicy,
  type CredentialSource,
  type FlightProviderAdapter,
  type OrderCancelAudit,
  type OrderCancelScope,
  type OrderCreateAudit,
  type ProviderCapabilities,
  type ProviderSettlement,
  type ProviderVertical,
  type TenantAdapter,
  type TenantProviderFactory,
} from '../providers/provider.types.js';
import { SabreOperationNotSupportedError, humanizeSabreError } from './sabre-errors.js';

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

/** El entorno que la cuenta DECLARA: sólo `prod` explícito es producción; lo demás, CERT. */
function declaredSabreEnvironment(config: Record<string, unknown>): SabreEnvironment {
  return config['environment'] === 'prod' ? 'prod' : SABRE_DEFAULT_ENVIRONMENT;
}

/**
 * Lo que ve el vendedor cuando la cuenta se declara de pruebas y sus hosts no lo son. Sin hosts ni
 * valores: el detalle de qué corregir está en el formulario de la cuenta.
 */
export const SABRE_ENVIRONMENT_MISMATCH_DETAIL =
  'La cuenta de este proveedor está marcada de pruebas (CERT), pero sus hosts no son los de CERT. No se vende con ella hasta corregirla en Mi Red → Credenciales.';

/**
 * Las palancas comerciales de BFM que una cuenta puede declarar en su `config`.
 *
 * Se guardan planas porque el formulario BYOC trabaja con campos escalares. El objeto tipado que
 * consume el ACL se reconstruye acá, en el borde del factory, para que un POST directo no pueda
 * colar strings o valores fuera de rango hasta el request de Sabre.
 *
 * `ndcContent` es la quinta: pide contenido NDC a Sabre, que el ACL todavía descarta al mapear.
 */
const SABRE_ACCOUNT_SHOP_OPTION_KEYS = [
  'brandedFares',
  'brandLadderRounds',
  'upsellLimit',
  'multipleFares',
  'ndcContent',
] as const;

export interface SabreAccountShopOptionsResult {
  readonly options: SabreShopOptions;
  /** Rutas de configuración inválidas, nunca sus valores. */
  readonly invalidFields: readonly string[];
}

/** Convierte el texto de un `select` numérico sin aceptar decimales, signos ni overflow. */
function integerConfigValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return value;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

/**
 * Convierte el texto de un `select` booleano. Sólo `"true"` y `"false"`, que son los valores que
 * ofrece el formulario; un booleano de verdad (POST directo) pasa tal cual.
 *
 * No es `Boolean(value)`: `"false"` es una cadena no vacía y encendería lo que se pidió apagar.
 * Cualquier otra cosa sigue de largo para que el esquema la rechace y caiga al conjunto
 * conservador.
 */
function booleanConfigValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return value;
}

function shopOptionConfigValue(
  key: (typeof SABRE_ACCOUNT_SHOP_OPTION_KEYS)[number],
  value: unknown,
): unknown {
  if (key === 'brandLadderRounds' || key === 'upsellLimit') return integerConfigValue(value);
  if (key === 'ndcContent') return booleanConfigValue(value);
  return value;
}

/**
 * `provider_accounts.config` → opciones de shop validadas.
 *
 * Ante cualquier entrada inválida se vuelve al conjunto conservador del ACL (`single`, sin MFPI,
 * sin rondas pagadas y sin NDC) y se entregan sólo los nombres de campo para el log. No se hace
 * coerción permisiva: `2.5`, `-1` o una palabra desconocida no pueden cambiar la petición real.
 */
export function sabreShopOptionsFromAccountConfig(
  config: Readonly<Record<string, unknown>>,
): SabreAccountShopOptionsResult {
  const candidate: Record<string, unknown> = {};
  for (const key of SABRE_ACCOUNT_SHOP_OPTION_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    candidate[key] = shopOptionConfigValue(key, value);
  }

  const parsed = SabreShopOptionsSchema.safeParse(candidate);
  if (parsed.success) return { options: parsed.data, invalidFields: [] };

  const fallback = SabreShopOptionsSchema.parse({});
  const invalidFields = [
    ...new Set(
      parsed.error.issues.map((issue) =>
        issue.path.length === 0 ? 'shopOptions' : issue.path.map(String).join('.'),
      ),
    ),
  ].sort();
  return { options: fallback, invalidFields };
}

/**
 * Las operaciones de post-venta de Sabre que mueven dinero o cambian la reserva, y que la plataforma
 * enciende una por una con `SABRE_OPERATIONS` (lista separada por comas). Vacía, o sin definir, no
 * enciende ninguna: así nacen, y así se quedan hasta pasar su certificación en CERT (SAB-13 para
 * `issue` y `void`; `refund` espera además la decisión D9).
 */
export const SABRE_OPERATIONS = ['issue', 'void', 'refund', 'seats', 'services', 'modify'] as const;
export type SabreOperation = (typeof SABRE_OPERATIONS)[number];

const SabreOperationsSchema = z.array(z.enum(SABRE_OPERATIONS));

/** Una lista de `SABRE_OPERATIONS` que no se entiende. Tumba el arranque: no se adivina. */
export class SabreOperationsConfigError extends Error {
  constructor(readonly invalid: readonly string[]) {
    super(
      `SABRE_OPERATIONS tiene valores que no se reconocen: [${invalid.join(', ')}]. Se admiten: ${SABRE_OPERATIONS.join(', ')}.`,
    );
    this.name = 'SabreOperationsConfigError';
  }
}

/**
 * `SABRE_OPERATIONS` → las operaciones encendidas.
 *
 * Un valor que no está en {@link SABRE_OPERATIONS} LANZA, y lo hace al construir el factory: el
 * arranque falla ruidoso. Ignorarlo convertiría una errata (`isue`) en una emisión que nadie sabe
 * por qué no aparece, o al revés, en un despliegue que cree tenerla apagada. Distingue mayúsculas
 * por lo mismo. Los valores repetidos y los espacios no importan.
 */
export function parseSabreOperations(raw: string | undefined): ReadonlySet<SabreOperation> {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const parsed = SabreOperationsSchema.safeParse(values);
  if (!parsed.success) {
    const known: readonly string[] = SABRE_OPERATIONS;
    throw new SabreOperationsConfigError([
      ...new Set(values.filter((value) => !known.includes(value))),
    ]);
  }
  return new Set(parsed.data);
}

/**
 * Quién firma el PNR (`createBooking.receivedFrom`, `booking-management-v1.yml:709`). Sin él, Sabre
 * escribe «Create Booking» y el historial del PNR no dice desde qué plataforma se reservó.
 */
export const SABRE_RECEIVED_FROM = 'PLANETOUR';

/**
 * La política de emisión que una cuenta puede declarar en su `config`, con el nombre plano del
 * formulario a la izquierda y el campo del ACL a la derecha.
 */
const SABRE_ACCOUNT_TICKETING_KEYS = {
  ticketingPolicy: 'policy',
  ticketingLeadHours: 'leadHours',
  ticketingFormOfPayment: 'formOfPayment',
  pccTimeZone: 'pccTimeZone',
} as const satisfies Record<string, keyof SabreTicketingSettings>;

export interface SabreAccountTicketingResult {
  readonly settings: SabreTicketingSettings;
  /** Claves de `config` inválidas, nunca sus valores. */
  readonly invalidFields: readonly string[];
}

/**
 * `provider_accounts.config` → política de emisión validada.
 *
 * Campo a campo y no en bloque, a diferencia de {@link sabreShopOptionsFromAccountConfig}: un margen
 * mal escrito no puede devolver a «con plazo» a una cuenta que eligió bien la emisión futura. Cada
 * valor inválido vuelve a SU default (con plazo, 2 h, CASH, America/Bogota) y sólo se informa el
 * nombre del campo. Nunca se coerciona de más: `2.5`, `-1` o una forma de pago con tarjeta no
 * pueden cambiar el PNR.
 */
export function sabreTicketingSettingsFromAccountConfig(
  config: Readonly<Record<string, unknown>>,
): SabreAccountTicketingResult {
  const candidate: Record<string, unknown> = {};
  const configKeyBySetting = new Map<string, string>();
  for (const [configKey, settingKey] of Object.entries(SABRE_ACCOUNT_TICKETING_KEYS)) {
    const value = config[configKey];
    if (value === undefined || value === null) continue;
    candidate[settingKey] = settingKey === 'leadHours' ? integerConfigValue(value) : value;
    configKeyBySetting.set(settingKey, configKey);
  }

  const parsed = SabreTicketingSettingsSchema.safeParse(candidate);
  if (parsed.success) return { settings: parsed.data, invalidFields: [] };

  const invalid = new Set<string>();
  for (const issue of parsed.error.issues) {
    const settingKey = String(issue.path[0] ?? 'ticketing');
    delete candidate[settingKey];
    invalid.add(configKeyBySetting.get(settingKey) ?? settingKey);
  }
  const retried = SabreTicketingSettingsSchema.safeParse(candidate);
  return {
    settings: retried.success ? retried.data : SabreTicketingSettingsSchema.parse({}),
    invalidFields: [...invalid].sort(),
  };
}

/**
 * `config.allowCardBinPricing` sólo puede ser un booleano. `optional()` y no `default(false)`:
 * el default vive en {@link SabreProviderFactory.cardBinPolicy}, donde además se registra, y un
 * `default` aquí escondería que la cuenta no dijo nada.
 */
const AllowCardBinPricingSchema = z.boolean().optional();

/** Mismo dominio que `SabreConfigSchema.maxConcurrentRequests`: entero positivo. */
const MaxConcurrentRequestsSchema = z.number().int().positive();

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
  readonly price: SabreOfferRevalidationRouter;
  readonly create: SabreOrderCreateAdapter;
  readonly manage: SabreOrderManageAdapter;
  /** La política de emisión de la cuenta, ya validada: viaja en cada reserva. */
  readonly ticketing: SabreTicketingSettings;
  /**
   * La emisión (`fulfillFlightTickets`) y las condiciones de los tiquetes, sobre el mismo cliente y
   * la misma post-venta: la lectura previa a emitir comparte token y cupo con todo lo demás.
   */
  readonly issue: TicketingPort;
  /** Las operaciones de `SABRE_OPERATIONS` encendidas en este despliegue. */
  readonly operations: ReadonlySet<SabreOperation>;
  /** El mapa de asientos antes de reservar (Get Seats v3, SAB-15), sobre el mismo cliente. */
  readonly seats: SeatMapPort;
  /**
   * Maletas y servicios sobre una reserva ATPCO hecha (Stateless Ancillaries, SAB-19), sobre el
   * mismo cliente: el alta vuelve a consultar el catálogo y comparte token y cupo.
   */
  readonly ancillaries: AncillaryPort;
}

/**
 * El plazo de emisión de una lectura con la zona de la oficina de la cuenta. Sólo un plazo en la
 * hora de la oficina (`PROVIDER_LOCAL`) la recibe: uno en UTC ya tiene instante, y una lectura sin
 * plazo no gana uno. Una zona que el motor no conoce no se pega: la cuenta la valida al leerse
 * (`sabreTicketingSettingsFromAccountConfig`), y esto es la segunda puerta.
 */
export function withOfficeTimeZone(view: OrderView, pccTimeZone: string): OrderView {
  const deadline = view.ticketingDeadline;
  if (deadline === undefined || deadline.zone !== 'PROVIDER_LOCAL') return view;
  if (!isSabrePccTimeZone(pccTimeZone)) return view;
  return { ...view, ticketingDeadline: { ...deadline, timeZone: pccTimeZone } };
}

/**
 * El checkout de Sabre tiene dos entradas según el contenido.
 *
 * - NDC ya transporta `offerItemId` y conserva `/offers/price`.
 * - ATPCO nace de caché: necesita `/offers/flightCheck` para materializar una oferta viva y
 *   obtener los ids compatibles con Booking Management.
 * - LCC no pertenece al contrato ATPCO de Flight Check y se rechaza antes de salir a la red.
 *
 * Separarlo aquí evita que `OrdersService` conozca vocabulario de Sabre y deja una única puerta
 * `priceOffer` para la UI y para la revalidación obligatoria justo antes de reservar.
 */
export class SabreOfferRevalidationRouter {
  constructor(
    private readonly ndc: Pick<SabreOfferPriceAdapter, 'priceOffer'>,
    private readonly atpco: Pick<SabreFlightCheckAdapter, 'priceOffer'>,
  ) {}

  priceOffer(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    if (offer.provider.source === 'LCC') {
      return Promise.reject(
        new SabreOperationNotSupportedError('revalidar una oferta LCC con Flight Check'),
      );
    }
    return offer.provider.source === 'NDC'
      ? this.ndc.priceOffer(offer, criteria, ctx)
      : this.atpco.priceOffer(offer, criteria, ctx);
  }
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
 *  - `issueTickets` mientras `issue` no esté en `SABRE_OPERATIONS`: la emisión está escrita y
 *    probada contra el contrato, pero no se enciende hasta certificarla (SAB-13).
 *  - `getSeatMap` mientras `seats` no esté en `SABRE_OPERATIONS`: el mapa y la reserva de asientos
 *    están escritos y probados contra el contrato, y se encienden al certificarlos (SAB-21).
 *  - `listAncillaries`, `addAncillaries` y `removeAncillaries` mientras `services` no esté en
 *    `SABRE_OPERATIONS` (SAB-20): lo mismo, hasta certificar Stateless Ancillaries en CERT.
 *  - `readTravelers` y `modifyTravelers` mientras `modify` no esté en `SABRE_OPERATIONS` (SAB-25):
 *    `modifyBooking` cambia la reserva en la aerolínea y se certifica en CERT antes de encenderlo.
 *
 * Lo que ya no hace falta gatear: el bloque de reserva contra una cuenta en modo simulado. Ese
 * modo no existe —el ACL no se construye sin credenciales usables— así que un adapter que llega
 * hasta aquí reserva contra Sabre o falla, y no hay tercer camino que cerrar.
 */
export class SabreFlightProviderAdapter
  implements FlightProviderAdapter, TicketingPort, SeatMapPort, AncillaryPort, OrderModifyPort
{
  constructor(private readonly inner: SabreAdapterSet) {}

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
    return this.inner.price.priceOffer(offer, criteria, ctx);
  }

  /**
   * Por `createBooking` y no por el `createOrder` del puerto: las dos entradas tienen que mandar la
   * MISMA política de emisión y la misma firma, o una reserva quedaría sin plazo según el camino.
   */
  async createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult> {
    this.assertSeatsEnabled(request);
    return (await this.inner.create.createBooking(request, ctx, this.bookingOptions())).result;
  }

  /**
   * Tercera línea detrás de la capacidad `seatMap` y de {@link getSeatMap}: con `seats` apagado en
   * este despliegue, una reserva con asientos no sale (SAB-16). Hoy no llega ninguna —sin mapa no
   * hay asiento atado—, pero la reserva es la llamada que mueve dinero y no puede depender de que el
   * servicio de arriba no cambie. `OrderCreateNotSentError`: el saga lo lee como «no salió», no como
   * un resultado incierto.
   */
  private assertSeatsEnabled(request: OrderCreateRequest): void {
    if ((request.seats?.length ?? 0) > 0 && !this.inner.operations.has('seats')) {
      throw new OrderCreateNotSentError(
        'la elección de asiento no está encendida para Sabre en este despliegue',
      );
    }
  }

  /** Lo que toda reserva de esta cuenta lleva además del pedido: su política de emisión y su firma. */
  private bookingOptions(): SabreOrderCreateOptions {
    return { ticketing: this.inner.ticketing, receivedFrom: SABRE_RECEIVED_FROM };
  }

  /**
   * La creación CON las decisiones que se tomaron al mandarla (`AuditedOrderCreatePort`).
   *
   * `hasVersionStamp` sale siempre `false` con Sabre porque `createBooking` no devuelve
   * `bookingSignature`; el saga lo lee como lo que es: la señal de que la lectura de cierre no
   * es opcional.
   */
  async createOrderAudited(
    request: OrderCreateRequest,
    ctx: SearchContext,
  ): Promise<OrderCreateAudit> {
    this.assertSeatsEnabled(request);
    const outcome = await this.inner.create.createBooking(request, ctx, this.bookingOptions());
    const ticketing = outcome.ticketing;

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
        // Con qué política de emisión quedó el PNR: es lo primero que se pregunta cuando una
        // reserva vence sin emitir. Vocabulario cerrado; el PCC de emisión no entra.
        ...(ticketing === undefined
          ? {}
          : {
              ticketingPolicy: ticketing.policy,
              ...(ticketing.fallback === undefined
                ? {}
                : { ticketingPolicyFallback: ticketing.fallback }),
              ...(ticketing.deadline === undefined
                ? {}
                : { ticketingDeadlineSource: ticketing.deadline.source }),
            }),
      },
      providerRaw: outcome.providerRaw,
      hasVersionStamp: outcome.hasBookingSignature,
    };
  }

  /**
   * La lectura de la reserva, con la zona de la oficina en el plazo de emisión: Sabre da la fecha y
   * la hora del PCC sin decir su zona (`futureTicketingPolicy`, docs/sabre/06 §5.3), y la cuenta sí
   * la declara (`pccTimeZone`, la misma con que se pidió el plazo al reservar). Con ella la
   * post-venta calcula el instante y avisa antes de que venza (SAB-14).
   */
  async retrieveForDisplay(orderId: string, ctx: SearchContext): Promise<OrderView> {
    return withOfficeTimeZone(
      await this.inner.manage.retrieveForDisplay(orderId, ctx),
      this.inner.ticketing.pccTimeZone,
    );
  }

  cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    return this.inner.manage.cancelOrder(orderId, ctx);
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
   *
   * Con `scope.ticketOperation: 'VOID'` se cancela la reserva entera anulando sus tiquetes, y sólo
   * si `void` está en `SABRE_OPERATIONS` (segunda defensa detrás de la capacidad). El ACL vuelve a
   * comprobar los tiquetes justo antes y, si ya no se pueden anular, no manda nada: se traduce a
   * {@link TicketVoidNotAvailableError}. Una anulación a medias (unos tiquetes sí, otros no) sale
   * con `partial`, para que se concilie y nunca se reintente.
   */
  async cancelOrderAudited(
    orderId: string,
    ctx: SearchContext,
    scope?: OrderCancelScope,
  ): Promise<OrderCancelAudit> {
    const itemIds = scope?.itemIds;
    const ticketOperation = scope?.ticketOperation;
    if (ticketOperation !== undefined) {
      if (!this.inner.operations.has('void')) {
        throw new SabreOperationNotSupportedError('anular tiquetes');
      }
      if (itemIds !== undefined && itemIds.length > 0) {
        // La anulación se lleva la reserva entera: no hay "anular una parte" en este contrato.
        throw new SabreOperationNotSupportedError('anular los tiquetes de una parte de la reserva');
      }
      return this.voidTickets(orderId, ctx);
    }
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
  }

  /**
   * La anulación (VOID) de la reserva entera. `HALT_ON_ERROR`, como toda cancelación: la
   * documentación de Sabre se contradice sobre si deshace los documentos ya anulados (docs/sabre/06
   * §5.2), así que un fallo con tiquetes anulados en la respuesta se trata como lo que es, parcial.
   */
  private async voidTickets(orderId: string, ctx: SearchContext): Promise<OrderCancelAudit> {
    let outcome: Awaited<ReturnType<SabreOrderManageAdapter['cancelBooking']>>;
    try {
      outcome = await this.inner.manage.cancelBooking(orderId, ctx, { ticketOperation: 'VOID' });
    } catch (error) {
      // La comprobación previa dijo que no: nada salió al cable. El rechazo es neutral para que la
      // API le diga al vendedor qué hacer sin conocer el vocabulario de Sabre.
      if (error instanceof SabreCancelBookingBuildError && error.rule === 'VOID_NOT_AVAILABLE') {
        throw new TicketVoidNotAvailableError();
      }
      throw error;
    }
    const voided = outcome.detail.voidedTickets.length;
    const partial =
      outcome.outcome === 'PARTIALLY_CANCELLED' || (!outcome.result.success && voided > 0);
    // `ALREADY_CANCELLED` es éxito para una cancelación (el estado final es el buscado), pero no
    // para una anulación: la reserva ya estaba cancelada antes de esta llamada —desde otro canal— y
    // nada dice qué pasó con sus tiquetes. Darla por anulada liberaría la cartera con tiquetes que
    // pueden seguir emitidos y cobrados. No se sabe: se concilia.
    const verified = outcome.outcome !== 'UNVERIFIED' && outcome.outcome !== 'ALREADY_CANCELLED';
    return {
      result: outcome.result,
      audit: {
        audited: true,
        provider: SABRE_PROVIDER_CODE,
        scope: 'ALL',
        called: true,
        ticketOperation: 'VOID',
        outcome: outcome.outcome,
        // Conteo, nunca los números: el evento lo ve cualquier admin del subárbol.
        voidedTickets: voided,
        errorHandlingPolicy: outcome.errorHandlingPolicy,
        ticketCheckPerformed: outcome.ticketCheckPerformed,
        conversationId: outcome.conversationId,
        ...outcome.shape,
      },
      idempotencyKey: outcome.idempotencyKey,
      verified,
      ...(partial ? { partial: true } : {}),
    };
  }

  /**
   * Emite los tiquetes de la reserva sin tarjeta, con la forma de pago de la cuenta
   * (`TicketingPort`). Segunda línea de defensa detrás de la capacidad `issue`: con la emisión
   * apagada en este despliegue, rechaza antes de leer nada, aunque un job viejo llegue hasta aquí.
   */
  issueTickets(
    orderId: string,
    ctx: SearchContext,
    options: TicketIssueOptions,
  ): Promise<TicketIssueResult> {
    if (!this.inner.operations.has('issue')) {
      return Promise.reject(new SabreOperationNotSupportedError('emitir tiquetes'));
    }
    return this.inner.issue.issueTickets(orderId, ctx, options);
  }

  /** Las condiciones de los tiquetes emitidos (`checkFlightTickets`). Es una lectura. */
  checkTickets(orderId: string, ctx: SearchContext): Promise<TicketCheckResult> {
    return this.inner.issue.checkTickets(orderId, ctx);
  }

  /**
   * El mapa de asientos de una oferta antes de reservarla (SAB-16). Segunda línea de defensa detrás
   * de la capacidad `seatMap`: con `seats` apagado en este despliegue, rechaza sin consultar a
   * Sabre (cada Get Seats es una llamada facturable). Los asientos elegidos viajan después con la
   * reserva (`createBooking`), que los pide en el bloque que corresponda a la oferta.
   */
  getSeatMap(offer: Offer, criteria: FlightSearchCriteria, ctx: SearchContext): Promise<SeatMap> {
    if (!this.inner.operations.has('seats')) {
      return Promise.reject(new SabreOperationNotSupportedError('elegir asiento'));
    }
    return this.inner.seats.getSeatMap(offer, criteria, ctx);
  }

  /**
   * El catálogo de maletas y servicios de una reserva hecha (SAB-20). Segunda línea de defensa
   * detrás de la capacidad `addServices`: con `services` apagado en este despliegue, rechaza sin
   * consultar a Sabre, aunque un pedido viejo llegue hasta aquí.
   */
  listAncillaries(order: AncillaryOrderRef, ctx: SearchContext): Promise<AncillaryCatalog> {
    if (!this.inner.operations.has('services')) {
      return Promise.reject(new SabreOperationNotSupportedError('servicios adicionales'));
    }
    return this.inner.ancillaries.listAncillaries(order, ctx);
  }

  /** Agrega lo elegido a la reserva. Mueve dinero: la misma compuerta que el catálogo. */
  addAncillaries(
    order: AncillaryOrderRef,
    selections: readonly AncillarySelection[],
    ctx: SearchContext,
  ): Promise<AncillaryAddResult> {
    if (!this.inner.operations.has('services')) {
      return Promise.reject(new SabreOperationNotSupportedError('servicios adicionales'));
    }
    return this.inner.ancillaries.addAncillaries(order, selections, ctx);
  }

  /** Quita servicios agregados, por los ids que devolvió el alta. La misma compuerta. */
  removeAncillaries(
    order: AncillaryOrderRef,
    providerItemIds: readonly string[],
    ctx: SearchContext,
  ): Promise<AncillaryRemoveResult> {
    if (!this.inner.operations.has('services')) {
      return Promise.reject(new SabreOperationNotSupportedError('servicios adicionales'));
    }
    return this.inner.ancillaries.removeAncillaries(order, providerItemIds, ctx);
  }

  /** Lo que `modifyBooking` cambia de un pasajero (SAB-25). Es una declaración: no llama a nadie. */
  supportedModifications(): readonly TravelerModification[] {
    return this.inner.manage.supportedModifications();
  }

  /**
   * Los datos de los pasajeros de la reserva, enmascarados, para corregirlos (SAB-25). Segunda línea
   * de defensa detrás de la capacidad `modify`: con `modify` apagado en este despliegue, rechaza
   * sin leer la reserva (la lectura trae documentos enteros, y sin poder cambiarlos no hace falta).
   */
  readTravelers(order: OrderModifyRef, ctx: SearchContext): Promise<OrderTravelersView> {
    if (!this.inner.operations.has('modify')) {
      return Promise.reject(
        new SabreOperationNotSupportedError('modificar los datos de los pasajeros'),
      );
    }
    return this.inner.manage.readTravelers(order, ctx);
  }

  /**
   * Corrige el documento, el viajero frecuente y los servicios especiales de una reserva
   * (`modifyBooking`, SAB-25). La misma compuerta que la lectura. El cambio va firmado en el historial
   * del PNR con la plataforma (`receivedFrom`), como la reserva.
   */
  modifyTravelers(
    order: OrderModifyRef,
    changes: readonly TravelerChange[],
    ctx: SearchContext,
  ): Promise<OrderModifyResult> {
    if (!this.inner.operations.has('modify')) {
      return Promise.reject(
        new SabreOperationNotSupportedError('modificar los datos de los pasajeros'),
      );
    }
    return this.inner.manage.modifyTravelers(order, changes, ctx, {
      receivedFrom: SABRE_RECEIVED_FROM,
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
}

/**
 * Factory de adapters de Sabre por tenant (BYOC). Espejo de `LatamNdcProviderFactory` **con una
 * diferencia deliberada: no hay rama `env`**.
 *
 * LATAM cae a credenciales de plataforma porque es el proveedor legacy con el que se vendía
 * antes de que existiera la bóveda BYOC. Sabre no tiene ese pasado y no puede heredar ese
 * comportamiento: prestarle la cuenta de la plataforma a un tenant que no la pidió significa
 * consultas facturadas a quien no las encargó y, peor, tarifas de un PCC que no es el suyo
 * saliendo en una cotización con su marca. Sin cuenta resoluble —o con una cuenta a la que le
 * falten credenciales— `resolveForTenant` lanza y el registry deja a Sabre **ausente** de la
 * búsqueda, nombrado en `providers[]` con el motivo
 * (`docs/sabre/11-plan-implementacion.md` §7, D5).
 *
 * Desde esta tanda LATAM hace lo mismo en su último escalón: la única diferencia que queda es
 * el escalón intermedio de credenciales de plataforma, que LATAM conserva y Sabre no tiene.
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
   * Lo que se reserva con Sabre lo liquida la red: el tiquete sale en CASH o a crédito (D1, nunca
   * con tarjeta) y lo paga por BSP el dueño de la cuenta. Por eso la reserva retiene la cartera del
   * nodo que vende y la de su red hasta ese dueño, como un hotel (SAB-FD-2 A; docs/platform/12
   * §14). Una cuenta de pruebas (CERT) no retiene, y con la cuenta propia del nodo la base no
   * retiene a nadie.
   */
  readonly settlement: ProviderSettlement = 'network-wallet';

  /**
   * Lo que Sabre sabe hacer HOY, ni más ni menos.
   *
   * `retrieve` y `cancel` en `true` desde esta tanda: `getBooking` (las dos lecturas) y
   * `cancelBooking` están implementados y cableados arriba. `retrieve` además no es sólo una
   * pantalla — es lo que el saga de creación consulta para saber si puede CERRAR una reserva
   * verificándola; con `retrieve: false` toda creación de Sabre acabaría escalada.
   *
   * `pay` y `reshop` siguen en `false` y no es un olvido: no son operaciones de este contrato. Es lo
   * que hace que `OrdersController.assertSupports` las rechace con un mensaje claro en vez de
   * mandarlas a un adapter que no las implementa.
   *
   * `services` (ver el catálogo) y `addServices` (agregar y quitar antes de emitir, SAB-20) salen de
   * `services` en `SABRE_OPERATIONS`: los servicios se cobran como EMD al emitir, así que mueven
   * dinero y nacen apagados hasta certificarlos en CERT (SAB-21).
   *
   * `modify` (corregir los datos de los pasajeros, SAB-25) sale de `modify`: no mueve dinero, pero
   * cambia la reserva en la aerolínea, y nace apagado hasta certificarlo en CERT.
   *
   * `issue` sale de `SABRE_OPERATIONS`: la emisión está cableada, pero nace apagada y se enciende
   * por despliegue, después de certificarla. `ticketCheck` y `void` van juntas detrás de `void`: las
   * condiciones de los tiquetes sólo se ofrecen donde se puede actuar sobre ellas.
   */
  readonly capabilities: ProviderCapabilities;

  private readonly logger = new Logger('Sabre');
  private readonly cache = new Map<string, SabreFlightProviderAdapter>();
  /** Lo encendido en `SABRE_OPERATIONS`, leído una vez: un valor inválido tumba el arranque. */
  private readonly operations: ReadonlySet<SabreOperation>;

  constructor(private readonly creds: ProviderCredentialsService) {
    this.operations = parseSabreOperations(process.env['SABRE_OPERATIONS']);
    this.capabilities = {
      retrieve: true,
      cancel: true,
      pay: false,
      services: this.operations.has('services'),
      reshop: false,
      issue: this.operations.has('issue'),
      ticketCheck: this.operations.has('void'),
      void: this.operations.has('void'),
      // El mapa y la reserva de asientos sin cargo (SAB-16), apagados hasta certificarlos en CERT.
      seatMap: this.operations.has('seats'),
      // Maletas y servicios antes de emitir (SAB-20), apagados hasta certificarlos en CERT.
      addServices: this.operations.has('services'),
      // Corregir documento, viajero frecuente y servicios especiales (SAB-25), apagado hasta
      // certificar modifyBooking en CERT.
      modify: this.operations.has('modify'),
    };
    if (this.operations.size > 0) {
      // Encender una operación que mueve dinero tiene que verse en el log de arranque.
      this.logger.warn(
        `operaciones de Sabre encendidas por SABRE_OPERATIONS: [${[...this.operations].sort().join(', ')}]`,
      );
    }
  }

  async forTenant(tenantId: string): Promise<FlightProviderAdapter> {
    return (await this.resolveForTenant(tenantId)).adapter;
  }

  async resolveForTenant(tenantId: string): Promise<TenantAdapter<FlightProviderAdapter>> {
    // Sin `try/catch`: la `NotFoundException` de la bóveda —tenant sin cuenta propia ni
    // heredable, o cuenta todavía en `status: 'sandbox'`— se propaga tal cual y el registry la
    // traduce a "proveedor no habilitado". Atraparla aquí para caer a env es exactamente lo
    // que este factory NO hace.
    return this.adapterFor(await this.creds.resolve(tenantId, SABRE_PROVIDER_CODE), 'sale');
  }

  /**
   * La post-venta de una orden sale con la cuenta (y el PCC) con que se creó la reserva (RF-29): un
   * PNR sólo se lee, se cancela o se emite desde la oficina que lo creó, y una agencia que después
   * cargó su propia cuenta seguiría viendo "no existe" en las reservas que hizo con la heredada. La
   * bóveda resuelve la cuenta desde la orden, con el tenant fijado y sólo si sigue en su red.
   *
   * Pasa por la misma puerta de credenciales y la misma caché que la venta: con la misma cuenta, el
   * mismo cliente, el mismo token y el mismo cupo de concurrencia. Sin `try/catch` por lo mismo que
   * {@link resolveForTenant}: el registry traduce la `NotFoundException` a "la cuenta de la reserva
   * ya no está disponible".
   */
  async resolveForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<TenantAdapter<FlightProviderAdapter>> {
    const resolved = await this.creds.resolveForOrder(tenantId, orderId);
    if (resolved.providerCode !== SABRE_PROVIDER_CODE) {
      // La bóveda ya exige el proveedor de la orden; esto cubre un cableado equivocado del registry.
      throw new NotFoundException('la cuenta de la orden no es de Sabre');
    }
    return this.adapterFor(resolved, 'order');
  }

  /**
   * El adapter de UNA cuenta ya resuelta (la vigente del tenant o la de una orden), con lo que el
   * registry necesita saber de ella: origen, política, entorno y cuál es.
   *
   * `purpose` separa la venta (`resolveForTenant`) de la post-venta de una orden hecha
   * (`resolveForOrder`): una cuenta que se contradice corta la venta, no lo ya vendido.
   */
  private adapterFor(
    resolved: ResolvedProviderAccount,
    purpose: 'sale' | 'order',
  ): TenantAdapter<FlightProviderAdapter> {
    const cfg = this.toConfig(resolved.credentials, resolved.config, resolved.ownerTenantId);
    this.assertEnvironmentCoherent(resolved, cfg, purpose);

    // Puerta de credenciales, ANTES de construir nada. Hasta esta tanda esta comprobación
    // vivía después de instanciar el ACL y dejaba pasar un caso: la cuenta que declaraba
    // `config.mock: true` se servía igual, marcada como simulada, y cotizaba fixtures. Ese
    // permiso ya no existe —ni el campo—: sin `epr`, `password` u `homePcc` no hay adapter.
    const missing = missingSabreCredentials(cfg);
    if (missing.length > 0) {
      // Sólo NOMBRES de campo: el valor de una credencial nunca entra en un log.
      this.logger.warn(
        `cuenta de Sabre incompleta para ${resolved.ownerTenantId}: faltan [${missing.join(', ')}] — proveedor NO habilitado`,
      );
      throw new ProviderAccountIncompleteError(SABRE_PROVIDER_CODE, missing);
    }

    // El `homePcc` entra en la clave porque entra en el `clientId` del que se deriva el ATK:
    // dos cuentas del mismo dueño con PCC distinto NO pueden compartir instancia ni token.
    // No es secreto —se imprime en el billete—, así que puede vivir en una clave de caché.
    // Ya no hace falta marcador de "sin PCC": la puerta de arriba garantiza que está.
    //
    // El id de la cuenta también: la post-venta resuelve la cuenta de cada orden, y un dueño con
    // dos cuentas de Sabre (dos `label`) no puede recibir el adapter de la otra ni ver cómo una
    // desaloja a la otra en cada llamada —cada reconstrucción es un token y un cupo nuevos—.
    const key = `byoc:${resolved.ownerTenantId}:${resolved.id}:${cfg.homePcc}:${resolved.updatedAt.getTime()}`;
    const credentialSource: CredentialSource = resolved.inherited ? 'inherited' : 'own';
    // De pruebas sólo lo que sale a CERT: `toConfig` deriva el entorno de los hosts, no de lo que la
    // cuenta declara. CERT cotiza tarifas que no se emiten ni se facturan y crea PNR de prueba: la
    // búsqueda las marca, la orden lo guarda y la reserva no retiene cartera. Una cuenta que se
    // declara CERT con hosts que no lo son no llega aquí para vender (`assertEnvironmentCoherent`).
    const providerEnvironment: ProviderEnvironment = cfg.environment === 'prod' ? 'live' : 'test';
    const account: Omit<TenantAdapter<FlightProviderAdapter>, 'adapter'> = {
      credentialSource,
      callPolicy: this.declaredCallPolicy(resolved.config, resolved.ownerTenantId),
      providerEnvironment,
      // La orden la guarda para operar su post-venta con ESTA cuenta, y el intent comprueba que
      // sigue en esta versión antes de comprometerse.
      accountId: resolved.id,
      accountUpdatedAt: resolved.updatedAt,
    };

    const cached = this.cache.get(key);
    if (cached) return { adapter: cached, ...account };

    const adapter = new SabreFlightProviderAdapter(
      this.buildAdapters(cfg, resolved.ownerTenantId, resolved.config),
    );

    this.cache.set(key, adapter);
    this.evictStale(key);
    return { adapter, ...account };
  }

  /**
   * Lo que la cuenta declara contra lo que dicen sus hosts (revisión de SAB-10).
   *
   * - Declara CERT y algún host no es de CERT (uno de producción de Sabre, uno que no es de Sabre o
   *   un host de CERT que no reconocemos): para VENDER, la cuenta no se admite. Ni de pruebas —un
   *   host de producción vendería sin retener cartera— ni de producción —una cuenta CERT legítima
   *   con un host que no reconocemos perdería la marca de prueba, retendría cartera por reservas
   *   que no se facturan y avisaría a pasajeros de un PNR falso—. El registry la deja fuera con
   *   {@link SABRE_ENVIRONMENT_MISMATCH_DETAIL} y el log lo dice en `error`. La post-venta de lo
   *   ya reservado sigue: cancelar o leer no depende del entorno, y la marca de prueba de cada
   *   orden se guardó al crearla.
   * - Declara producción y sus hosts son los de CERT: es de pruebas, que es lo que es (CERT no
   *   emite ni factura). Se avisa y sigue.
   *
   * El borde de credenciales ya rechaza las dos combinaciones al guardar; esto cubre las cuentas
   * guardadas antes. Sin hosts ni valores en el log: la cuenta, el dueño y los entornos bastan.
   */
  private assertEnvironmentCoherent(
    resolved: ResolvedProviderAccount,
    cfg: SabreConfig,
    purpose: 'sale' | 'order',
  ): void {
    const declared = declaredSabreEnvironment(resolved.config);
    if (cfg.environment === declared) return;
    const where = `la cuenta de Sabre ${resolved.id} de ${resolved.ownerTenantId}`;
    if (declared === 'prod') {
      this.logger.warn(
        `${where} declara 'prod' pero sus hosts son los de CERT: se trata como de pruebas`,
      );
      return;
    }
    if (purpose === 'order') {
      this.logger.warn(
        `${where} declara 'cert' pero sus hosts no son los de CERT: sólo post-venta de lo ya reservado; no vende hasta corregirla`,
      );
      return;
    }
    this.logger.error(
      `${where} declara 'cert' pero sus hosts no son los de CERT: NO se vende con ella hasta corregir environment o los hosts`,
    );
    throw new ProviderAccountNotAllowedError(
      SABRE_PROVIDER_CODE,
      SABRE_ENVIRONMENT_MISMATCH_DETAIL,
    );
  }

  /**
   * La config del ACL con la que este factory construye el adapter de esa cuenta: los mismos hosts,
   * el mismo entorno y la misma credencial. La usa el arnés de certificación (SAB-11) para comprobar
   * contra CERT exactamente lo que va a salir. Lleva la contraseña descifrada: no sale del proceso
   * ni entra en un log.
   */
  configFor(resolved: ResolvedProviderAccount): SabreConfig {
    return this.toConfig(resolved.credentials, resolved.config, resolved.ownerTenantId);
  }

  /** Los errores del ACL ya tienen traducción propia, y NO hace eco del texto de Sabre. */
  humanizeError(err: unknown): string {
    return humanizeSabreError(err);
  }

  /**
   * Construye los cuatro adapters del ACL sobre UN token y UN cliente HTTP.
   *
   * Los cuatro comparten el ATK, que es lo que importa: el TAM Pool es un límite **por contrato de
   * agencia** y cuatro adapters autenticando por su cuenta lo agotan (docs/sabre/01 §7.1). Y
   * comparten el CLIENTE, búsqueda incluida, porque el semáforo de `maxConcurrentRequests` vive en
   * él: con un cliente propio, la búsqueda tendría su cupo aparte y la cuenta podría tener el doble
   * de llamadas en vuelo que su límite.
   */
  private buildAdapters(
    cfg: SabreConfig,
    ownerTenantId: string,
    config: Record<string, unknown>,
  ): SabreAdapterSet {
    // El logger se INYECTA. Sin él, `SabreHttpClient` y el adapter de búsqueda tienen
    // `deps.logger` en `undefined` y `sabre.http.error` no se emite nunca: en producción sólo
    // quedaba el aviso del fan-out con el mensaje amable («Sabre rechazó la operación»), que
    // es exactamente el que se escribió para NO decir nada del proveedor. El código del error,
    // el `kind` y los `issues[].fieldPath` —lo único con lo que se diagnostica un fallo de
    // negocio dentro de un 200— se estaban tirando a la basura al construirse el cliente.
    //
    // No hay riesgo de fuga: TODO lo que se emite pasa por `logRedacted`/`redactMeta` dentro
    // del ACL, y `toLogMeta()` publica códigos y rutas de campo, nunca cuerpos ni valores.
    const logger = this.loggerPort();
    const tokens = new SabreTokenService(cfg, { cacheNamespace: ownerTenantId });
    const http = new SabreHttpClient(cfg, tokens, { logger });
    const cardBinPricing = this.cardBinPolicy(config, ownerTenantId);
    const shopOptions = sabreShopOptionsFromAccountConfig(config);
    if (shopOptions.invalidFields.length > 0) {
      this.logger.warn(
        `configuración de shop de Sabre inválida para ${ownerTenantId}: campos [${shopOptions.invalidFields.join(', ')}] — se aplican defaults conservadores`,
      );
    }
    const ticketing = sabreTicketingSettingsFromAccountConfig(config);
    if (ticketing.invalidFields.length > 0) {
      this.logger.warn(
        `configuración de emisión de Sabre inválida para ${ownerTenantId}: campos [${ticketing.invalidFields.join(', ')}] — se aplican los valores por defecto`,
      );
    }
    const ndcPrice = new SabreOfferPriceAdapter(cfg, http, { cardBinPricing });
    const atpcoPrice = new SabreFlightCheckAdapter(cfg, http, { logger });
    const manage = new SabreOrderManageAdapter(cfg, http, { logger });
    // La oficina de emisión sólo si la reserva quedó para ella: con la emisión futura y un PCC
    // válido, como lo decide la creación. Sin eso emite la oficina propia.
    const ticketingPcc =
      ticketing.settings.policy === 'FUTURE_TICKETING'
        ? cfg.ticketingPcc?.trim().toUpperCase()
        : undefined;
    const issue = new SabreTicketingAdapter(
      cfg,
      http,
      { logger, orderManage: manage },
      {
        // D1: la forma de pago es la de la cuenta (CASH, ON_ACCOUNT o INVOICE), nunca tarjeta.
        formOfPayment: ticketing.settings.formOfPayment,
        ...(ticketingPcc !== undefined && SABRE_PCC_PATTERN.test(ticketingPcc)
          ? { ticketingPcc }
          : {}),
        // Lo agregado antes de emitir sale como EMD en la misma emisión (SAB-20). Sin `services`
        // la emisión sigue siendo sólo de tiquetes, como antes.
        issueAncillaryEmds: this.operations.has('services'),
      },
    );

    return {
      search: new SabreFlightSearchAdapter(cfg, {
        cacheNamespace: ownerTenantId,
        tokens,
        http,
        logger,
        shopOptions: shopOptions.options,
      }),
      price: new SabreOfferRevalidationRouter(ndcPrice, atpcoPrice),
      // Con logger, como los demás: sin él `sabre.createBooking`, `sabre.getBooking` y
      // `sabre.cancelBooking` no se emitían nunca, y son las únicas trazas de una reserva con su
      // desenlace, la política pedida y los conteos. Llevan códigos y conteos, nunca PNR ni PII.
      create: new SabreOrderCreateAdapter(cfg, http, { logger }),
      manage,
      ticketing: ticketing.settings,
      issue,
      operations: this.operations,
      seats: new SabreSeatMapAdapter(cfg, http, { logger }),
      ancillaries: new SabreAncillaryAdapter(cfg, http, { logger }),
    };
  }

  /**
   * `LoggerPort` sobre el `Logger` de Nest.
   *
   * `child()` acumula los bindings en el prefijo del mensaje: Nest no tiene loggers hijos con
   * contexto estructurado, y devolver `this` perdería silenciosamente las claves que el ACL
   * adjunta al crear el hijo.
   */
  private loggerPort(bindings: Record<string, unknown> = {}): LoggerPort {
    const nest = this.logger;
    const prefijo = Object.keys(bindings).length === 0 ? '' : `${JSON.stringify(bindings)} `;
    const linea = (message: string, meta?: Record<string, unknown>): string =>
      `${prefijo}${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`;

    return {
      debug: (message, meta) => nest.debug(linea(message, meta)),
      info: (message, meta) => nest.log(linea(message, meta)),
      warn: (message, meta) => nest.warn(linea(message, meta)),
      error: (message, meta) => nest.error(linea(message, meta)),
      child: (extra) => this.loggerPort({ ...bindings, ...extra }),
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

  /**
   * Conserva sólo la entrada vigente por cuenta: al rotar credenciales cambia el `updatedAt`, y al
   * cambiar el PCC, también la clave. Las otras cuentas del mismo dueño no se tocan.
   */
  private evictStale(currentKey: string): void {
    const accountPrefix = currentKey.split(':').slice(0, 3).join(':') + ':';
    for (const k of this.cache.keys()) {
      if (k !== currentKey && k.startsWith(accountPrefix)) this.cache.delete(k);
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
    ownerTenantId: string,
  ): SabreConfig {
    const maxConcurrentRequests = this.maxConcurrentRequests(config, ownerTenantId);
    const c = credentials;
    const g = config;
    // Lo declarado sólo elige los hosts por defecto. El entorno de la config es el de los hosts que
    // quedan (revisión de SAB-10): es lo que mira el arnés de certificación, y lo que se contradice
    // con lo declarado lo decide `assertEnvironmentCoherent` antes de vender. `sabreEnvironmentOfHosts`
    // es la misma regla con la que el borde de credenciales rechaza la combinación al guardar.
    const hosts = SABRE_HOSTS[declaredSabreEnvironment(g)];
    const host = str(g['host']) ?? hosts.rest;
    const soapHost = str(g['soapHost']) ?? hosts.soap;
    const environment = sabreEnvironmentOfHosts([host, soapHost]);

    // `password` sólo se lee del blob CIFRADO. Aceptarlo también desde `config` —como sí se
    // hace con `epr` y `homePcc`, que no son secretos— abriría una puerta para guardar la
    // contraseña de la oficina en un JSONB en claro que además se devuelve por `listSafe`.
    return parseSabreConfig({
      host,
      soapHost,
      environment,
      epr: str(c['epr']) ?? str(g['epr']),
      password: str(c['password']),
      homePcc: str(c['homePcc']) ?? str(g['homePcc']),
      ticketingPcc: str(c['ticketingPcc']) ?? str(g['ticketingPcc']),
      agencyIata: str(g['agencyIata']),
      domain: str(g['domain']),
      applicationId: str(g['applicationId']),
      // Las dos mitades, como `homePcc`: la spec de la bóveda los declara `encrypted-or-config`, y
      // leerlos sólo de `config` dejaba sin cabecera de grupo a la cuenta que los guardó cifrados.
      sabreGroup: str(c['sabreGroup']) ?? str(g['sabreGroup']),
      sabreCurrentCity: str(c['sabreCurrentCity']) ?? str(g['sabreCurrentCity']),
      ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    });
  }

  /**
   * `config.maxConcurrentRequests`: el cupo de concurrencia CONTRACTUAL de la cuenta (RNF-04,
   * docs/sabre/01 §5.2). Lo fija el contrato con Sabre y no se conoce de antemano (P-02), así que
   * tiene que poder ajustarse sin redesplegar: sin leerlo de aquí, toda cuenta quedaba en el
   * default defensivo y una red entera heredando una credencial compartía cuatro huecos.
   *
   * Un valor inválido NO tumba la cuenta: se avisa con el nombre del campo y se usa el default.
   * `parseSabreConfig` lanzaría, y una errata en un número dejaría a Sabre fuera de la búsqueda.
   */
  private maxConcurrentRequests(
    config: Record<string, unknown>,
    ownerTenantId: string,
  ): number | undefined {
    const raw = config['maxConcurrentRequests'];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const parsed = MaxConcurrentRequestsSchema.safeParse(integerConfigValue(raw));
    if (parsed.success) return parsed.data;
    this.logger.warn(
      `config.maxConcurrentRequests inválida en la cuenta de Sabre de ${ownerTenantId}: se ignora y se usa el cupo por defecto`,
    );
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
