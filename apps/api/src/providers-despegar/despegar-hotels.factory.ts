import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  DespegarApiError,
  DespegarCancelNotAllowedError,
  DespegarHotelsAdapter,
  DESPEGAR_BASE_URLS,
  type DespegarExchange,
  type DespegarHotelsConfig,
  type DespegarHttpDeps,
} from '@sales-travel/despegar-hotels';
import { z } from '@sales-travel/validation';
import {
  humanizeCancelNotAllowed,
  humanizeDespegarError,
} from '../hotels/despegar-hotels-errors.js';
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
  type CallPolicy,
  type CredentialSource,
  type TenantAdapter,
} from '../providers/provider.types.js';
import { DESPEGAR_IMAGE_HOSTS } from './despegar-hotel-content.js';
import { DespegarContextHotelProviderAdapter } from './despegar-hotel-context.adapter.js';
import {
  DESPEGAR_HOTELS_PROVIDER_CODE,
  DespegarHotelProviderAdapter,
  type DespegarNeutralOptions,
} from './despegar-hotel-provider.adapter.js';

const PROVIDER_CODE = DESPEGAR_HOTELS_PROVIDER_CODE;

/** El único campo sin el cual no hay llamada posible: Despegar autentica sólo con `x-apikey`. */
const API_KEY_FIELD = 'apiKey';

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
 * ## Puerta de credenciales
 *
 * Sin api key no se construye nada ni se sale a la red: el proveedor queda AUSENTE y el registry lo
 * nombra en `providers[]` con su motivo, como LATAM, Sabre y TBO. Hasta este cambio caía a la
 * `DESPEGAR_API_KEY` de la plataforma aunque estuviera vacía y seguía activo: en producción, sin
 * esa variable ni cuentas en la bóveda, cada sugerencia y cada búsqueda salían a Despegar a
 * cobrar un 401, y las sugerencias nunca llegaban al catálogo de TBO (2026-09-29).
 *
 * - Sin cuenta y sin `DESPEGAR_API_KEY` → `NotFoundException`, que el registry traduce a
 *   `no-credentials`: no hay cuenta que completar, hay que cargarla.
 * - Con cuenta pero sin `apiKey` propia ni de la plataforma → {@link ProviderAccountIncompleteError}
 *   con el campo que falta (`incomplete-account`).
 * - Una clave de sólo espacios cuenta como ausente: `fetch` recorta el valor del header y la
 *   llamada saldría sin credencial.
 *
 * Con clave, todo sigue igual: a una cuenta sin `apiKey` `toConfig` le completa la de la
 * plataforma y aun así sale como `own`/`inherited`. Quien lea `credentialSource` para atribuir
 * consumo tiene que saberlo.
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
    // `GET /book/{id}` acepta la `external_booking_reference` (docs/despegar/01 § Estado): un Book
    // que se cortó se verifica leyendo por nuestra referencia, nunca reservando otra vez.
    retrieveByClientReference: true,
    // `GET /reservations?by_api_key=true&from_purchase_date…` lista las reservas de la cuenta.
    reconcileByDate: true,
    // Sabe leer una reserva, pero no hay contrato de un HCN con SLA que seguir: seguirlo terminaría
    // en tareas de operaciones por un número que Despegar no promete.
    hcn: false,
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
    // La disponibilidad no trae fotos: salen de `/content-api/hotels`, guardadas en el catálogo
    // (`hotel_content`), y se sirven por el proxy de imágenes, sólo de estos dominios.
    contentFromCatalog: true,
    imageHosts: DESPEGAR_IMAGE_HOSTS,
  };

  private readonly logger = new Logger('DespegarHotels');
  private readonly cache = new Map<string, CachedAdapters>();

  /**
   * La falta de clave de la plataforma es del despliegue, no de un tenant: se avisa una vez por
   * proceso. Con cada búsqueda y cada tecla del autocompletado, sería el log entero.
   */
  private platformKeyWarned = false;

  /**
   * @param payloadWriter la bóveda de payloads: cada RQ/RS de prebook, book y post-venta queda
   *   cifrado con su cuenta. Son los "logs" que pide la certificación de HotelDO.
   */
  constructor(
    private readonly creds: ProviderCredentialsService,
    @Optional()
    @Inject(PROVIDER_PAYLOAD_WRITER)
    private readonly payloadWriter?: ProviderPayloadWriter,
  ) {}

  async forTenant(tenantId: string): Promise<DespegarHotelsAdapter> {
    return (await this.resolve(tenantId)).adapters.acl;
  }

  async resolveForTenant(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
    const { adapters, credentialSource } = await this.resolve(tenantId);
    return { adapter: adapters.neutral, credentialSource };
  }

  /**
   * La post-venta de una orden sale con la cuenta que la creó, no con la vigente del tenant: las
   * reservas viven en ESA cuenta de Despegar. Sin cuenta guardada (órdenes de la clave de
   * plataforma) no hay a qué volver y la bóveda responde 404.
   */
  async resolveForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<TenantAdapter<HotelProviderAdapter>> {
    const resolved = await this.creds.resolveForOrder(tenantId, orderId);
    if (resolved.providerCode !== PROVIDER_CODE) {
      throw new NotFoundException('la cuenta de la orden no es de Despegar');
    }
    const adapters = this.adaptersFor(resolved, tenantId);
    return {
      adapter: adapters.neutral,
      credentialSource: resolved.inherited ? 'inherited' : 'own',
    };
  }

  /** La conciliación lee las reservas de la cuenta entera: resuelve por cuenta, no por tenant. */
  async resolveForAccount(
    ownerTenantId: string,
    accountId: string,
  ): Promise<TenantAdapter<HotelProviderAdapter>> {
    const resolved = await this.creds.resolveOwnAccount(ownerTenantId, accountId, PROVIDER_CODE);
    return { adapter: this.adaptersFor(resolved, ownerTenantId).neutral, credentialSource: 'own' };
  }

  /** El ACL de UNA cuenta resuelta, con su caché por cuenta y versión. */
  private adaptersFor(resolved: ResolvedProviderAccount, tenantId: string): CachedAdapters {
    const cfg = this.toConfig(resolved.credentials, resolved.config);
    if (cfg.apiKey === '')
      throw this.missingApiKey(tenantId, resolved.inherited ? 'inherited' : 'own');
    const key = `byoc:${resolved.ownerTenantId}:${resolved.updatedAt.getTime()}`;
    let adapters = this.cache.get(key);
    if (!adapters) {
      const options = neutralOptions(cfg, resolved.credentials, resolved.config);
      const acl = new DespegarHotelsAdapter(
        cfg,
        this.httpDeps(
          { accountId: resolved.id, ownerTenantId: resolved.ownerTenantId },
          options.environment,
        ),
      );
      adapters = {
        acl,
        // Con cuenta de la bóveda: reserva también por la saga con órdenes.
        neutral: new DespegarContextHotelProviderAdapter(acl, options, {
          accountId: resolved.id,
          updatedAt: resolved.updatedAt.toISOString(),
        }),
      };
      this.cache.set(key, adapters);
      this.evictStale(key);
    }
    return adapters;
  }

  /**
   * Mismo traductor que el filtro de excepciones de la vertical. Un error que no es de Despegar
   * (p. ej. un pedido neutral que no se pudo traducir) ya trae un mensaje nuestro.
   */
  humanizeError(err: unknown): string {
    if (err instanceof DespegarApiError) return humanizeDespegarError(err.status, err.body);
    if (err instanceof DespegarCancelNotAllowedError) {
      return humanizeCancelNotAllowed(err.allowance.disallowedReason);
    }
    return err instanceof Error ? err.message : String(err);
  }

  private async resolve(
    tenantId: string,
  ): Promise<{ adapters: CachedAdapters; credentialSource: CredentialSource }> {
    let resolved: ResolvedProviderAccount;
    try {
      resolved = await this.creds.resolve(tenantId, PROVIDER_CODE);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      return { adapters: this.envAdapters(tenantId), credentialSource: 'env' };
    }
    return {
      adapters: this.adaptersFor(resolved, tenantId),
      credentialSource: resolved.inherited ? 'inherited' : 'own',
    };
  }

  /**
   * Con la clave de la plataforma (`DESPEGAR_API_KEY`): busca y lee, pero no reserva por órdenes,
   * porque no hay una cuenta de la bóveda a la que atar la orden ni su post-venta.
   */
  private envAdapters(tenantId: string): CachedAdapters {
    const cfg = this.envConfig();
    // Puerta única, ANTES de construir: la negativa sale como una ausencia que el registry sabe
    // explicar, y no como un 401 de Despegar por cada búsqueda.
    if (cfg.apiKey === '') throw this.missingApiKey(tenantId, 'env');
    let adapters = this.cache.get('env');
    if (!adapters) {
      const options = neutralOptions(cfg, {}, {});
      const acl = new DespegarHotelsAdapter(
        cfg,
        this.httpDeps({ accountId: null, ownerTenantId: tenantId }, options.environment),
      );
      adapters = { acl, neutral: new DespegarHotelProviderAdapter(acl, options) };
      this.cache.set('env', adapters);
    }
    return adapters;
  }

  /**
   * La bóveda va atada a la cuenta con que se construye el cliente: cada RQ/RS queda con su dueño,
   * que es quien lo puede leer después. Se guardan la reserva y la post-venta siempre, y las
   * búsquedas sólo si fallaron: una búsqueda que respondió no tiene nada que reportar y pesa.
   */
  private httpDeps(
    account: { accountId: string | null; ownerTenantId: string },
    environment: 'test' | 'live',
  ): DespegarHttpDeps {
    const writer = this.payloadWriter;
    if (writer?.enabled !== true) return {};
    return {
      onExchange: (e) => {
        if (!shouldVaultDespegarPayload(e)) return;
        void writer
          .record({
            providerCode: PROVIDER_CODE,
            requestId: e.requestId,
            attempt: 1,
            operation: e.operation,
            environment,
            ownerTenantId: account.ownerTenantId,
            providerAccountId: account.accountId,
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

  /**
   * Dos negativas distintas, porque la acción es distinta: con CUENTA hay un campo que completar;
   * sin cuenta, al caer a la plataforma tampoco hay nada ahí, y "completa tu cuenta" mandaría al
   * vendedor a una pantalla vacía. En el log, sólo el nombre del campo y el origen: nunca valores.
   */
  private missingApiKey(tenantId: string, credentialSource: CredentialSource): NotFoundException {
    if (credentialSource !== 'env') {
      this.logger.warn(
        `cuenta de Despegar sin ${API_KEY_FIELD} para ${tenantId} (origen: ${credentialSource}) y sin DESPEGAR_API_KEY de plataforma — proveedor NO habilitado`,
      );
      return new ProviderAccountIncompleteError(PROVIDER_CODE, [API_KEY_FIELD]);
    }
    if (!this.platformKeyWarned) {
      this.platformKeyWarned = true;
      this.logger.warn(
        'DESPEGAR_API_KEY vacía: Despegar queda ausente para todo tenant sin cuenta propia ni heredada',
      );
    }
    return new NotFoundException(`no hay api key de Despegar resoluble desde ${tenantId}`);
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
      apiKey: apiKey(c['apiKey']) ?? apiKey(c['apikey']) ?? platformApiKey(),
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
      apiKey: platformApiKey(),
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

/**
 * La clave recortada, o `undefined` si no queda nada. Recortarla no cambia lo que sale por el
 * cable —`fetch` ya recorta el valor de un header—; sí evita tomar por clave lo que no lo es.
 */
function apiKey(v: unknown): string | undefined {
  const trimmed = typeof v === 'string' ? v.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** La `DESPEGAR_API_KEY` de la plataforma, o `''` si no hay: es lo que cierra la puerta. */
function platformApiKey(): string {
  return apiKey(process.env['DESPEGAR_API_KEY']) ?? '';
}

function lang(v: unknown): 'EN' | 'ES' | 'PT' | undefined {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s === 'EN' || s === 'ES' || s === 'PT' ? s : undefined;
}

// ───────────────────────── Opciones del adaptador neutral ─────────────────────────

/**
 * Datos de facturación de la cuenta con Despegar: a nombre de quién emite Despegar la factura de
 * cada reserva a cuenta corriente. Son de la AGENCIA titular de la cuenta, no del huésped. Se
 * leen del blob cifrado (`credentials.invoice`) y, si no están, de `config.invoice`.
 */
const InvoiceConfigSchema = z
  .object({
    fiscalStatus: z.string().trim().min(1).max(40),
    fiscalIdentification: z.object({
      type: z.string().trim().min(1).max(20),
      number: z.string().trim().min(1).max(40),
      issueCountry: z.string().length(2).optional(),
    }),
    fiscalName: z.string().trim().min(1).max(200).optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    fiscalAddress: z
      .object({
        street: z.string().trim().min(1).max(200).optional(),
        number: z.string().trim().min(1).max(20).optional(),
        apartment: z.string().trim().max(20).optional(),
        floor: z.string().trim().max(20).optional(),
        neighborhood: z.string().trim().max(120).optional(),
        cityId: z.string().trim().min(1).max(20).optional(),
        zipCode: z.string().trim().min(1).max(20).optional(),
      })
      .optional(),
  })
  .strict();

const PaymentTypeSchema = z.enum(['CURRENT_ACCOUNT', 'ONE_CARD', 'DEFERRED']);

/**
 * La factura como la carga el formulario del panel (claves planas, `invoice*`, en el blob
 * cifrado). `undefined` si no hay ninguna: así manda el objeto `invoice` si alguien lo cargó por API.
 */
function flatInvoice(c: Record<string, unknown>): Record<string, unknown> | undefined {
  const s = (k: string): string | undefined => {
    const v = c[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  if (s('invoiceFiscalStatus') === undefined && s('invoiceIdNumber') === undefined)
    return undefined;
  const address = {
    street: s('invoiceStreet'),
    number: s('invoiceStreetNumber'),
    cityId: s('invoiceCityId'),
    zipCode: s('invoiceZipCode'),
  };
  const hasAddress = Object.values(address).some((v) => v !== undefined);
  return JSON.parse(
    JSON.stringify({
      fiscalStatus: s('invoiceFiscalStatus'),
      fiscalIdentification: {
        type: s('invoiceIdType'),
        number: s('invoiceIdNumber'),
        issueCountry: s('invoiceIssueCountry'),
      },
      fiscalName: s('invoiceFiscalName'),
      fiscalAddress: hasAddress ? address : undefined,
    }),
  ) as Record<string, unknown>;
}

/** `live` sólo contra el host de producción; cualquier otro (sandbox, UAT, propio) es de pruebas. */
export function despegarEnvironmentOf(baseUrl: string): 'test' | 'live' {
  try {
    return new URL(baseUrl).host === new URL(DESPEGAR_BASE_URLS.prod).host ? 'live' : 'test';
  } catch {
    return 'test';
  }
}

function neutralOptions(
  cfg: DespegarHotelsConfig,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
): DespegarNeutralOptions & { environment: 'test' | 'live' } {
  const options: DespegarNeutralOptions & { environment: 'test' | 'live' } = {
    environment: despegarEnvironmentOf(cfg.baseUrl),
  };
  const invoice = InvoiceConfigSchema.safeParse(
    credentials['invoice'] ?? config['invoice'] ?? flatInvoice(credentials),
  );
  if (invoice.success) options.invoice = invoice.data;
  const paymentType = PaymentTypeSchema.safeParse(config['paymentType']);
  if (paymentType.success) options.paymentType = paymentType.data;
  return options;
}

/**
 * Qué se guarda en la bóveda: la venta y la post-venta siempre (son la evidencia de una reserva y
 * los logs de la certificación); las búsquedas y el contenido, sólo si fallaron.
 */
const ALWAYS_VAULTED: ReadonlySet<string> = new Set([
  'prebook',
  'commissionUpdate',
  'payments',
  'book',
  'bookStatus',
  'recoveryRead',
  'recovery',
  'reservations',
  'cancelAllowance',
  'cancelQuote',
  'cancel',
  'specialRequest',
]);

export function shouldVaultDespegarPayload(
  e: Pick<DespegarExchange, 'operation' | 'outcome'>,
): boolean {
  return ALWAYS_VAULTED.has(e.operation) || e.outcome !== 'SUCCESS';
}
