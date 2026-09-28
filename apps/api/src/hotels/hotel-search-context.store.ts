import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BoardTypeSchema,
  HotelFeeSchema,
  HotelProviderCodeSchema,
  HotelRoomOccupancySchema,
  MoneySchema,
  type HotelRoompack,
} from '@sales-travel/canonical';
import type { CachePort } from '@sales-travel/core';
import { CountryCodeSchema, CurrencyCodeSchema, z } from '@sales-travel/validation';
import { createHash } from 'node:crypto';
import type { HotelProviderAccountFingerprint } from '../providers/hotel-provider.types.js';

/**
 * Contexto de búsqueda de hoteles en el servidor (docs/tbo/08 RF-08 y RNF-06 punto 2; 02 §9.3).
 *
 * Cada Search de un proveedor que lo necesita (TBO) deja aquí, por `(tenantId, searchId)`, lo que
 * su PreBook y su Book reenvían y el navegador no puede aportar: fechas, ocupación por habitación,
 * nacionalidad del pasajero principal, `searchSentAt`, la huella de la cuenta que buscó y, por
 * tarifa, el hotel, la referencia reservable (`BookingCode`), el literal del total y lo que la
 * búsqueda mostró de ella (la base de la comparación C1 del PreBook, RF-15). La tarifa viaja al
 * navegador sólo con `provider.raw = { searchId }`; lo demás se lee de aquí.
 *
 * Reglas:
 *
 * - **Vence con la oferta.** El TTL es `expiresAt − ahora`, y `expiresAt` lo declara el proveedor
 *   desde el envío del Search (TBO: `searchSentAt + 27 min`, RF-09). Guardar otra vez la misma
 *   búsqueda no reinicia el reloj: un acierto de caché con 25 minutos ofrece tarifas casi muertas.
 * - **Por tenant.** La clave lleva el tenant que buscó: un `searchId` de otro tenant no resuelve,
 *   aunque los dos operen con la misma cuenta heredada del consolidador.
 * - **Validado con Zod al entrar y al salir.** Un registro que no cumple no se guarda y uno leído
 *   que no cumple no existe: el día que esto viva en Redis, un valor de otra versión no se reenvía
 *   a nadie.
 * - **Falla hacia el lado seguro.** Un contexto que falta —venció, se desalojó o se perdió con un
 *   despliegue, porque hoy vive en la memoria del proceso— pide volver a buscar. Nunca se
 *   reconstruye con lo que mande el navegador.
 *
 * Guarda PII (edades de niños y nacionalidad): nada de este módulo la escribe en un log, y el
 * registro no sale del servidor.
 */

/** Token DI del `CachePort` de los contextos: una instancia propia del adapter en memoria. */
export const HOTEL_SEARCH_CONTEXT_CACHE = 'HOTEL_SEARCH_CONTEXT_CACHE';

const KEY_PREFIX = 'hotels:search-context';

/**
 * Techo de vida de un contexto, declare lo que declare el proveedor. Un vencimiento absurdo por un
 * error del ACL dejaría ocupaciones y nacionalidades en memoria indefinidamente.
 */
export const HOTEL_SEARCH_CONTEXT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** 100 hoteles con decenas de combinaciones cada uno caben con holgura. */
const MAX_PACKS = 25_000;

const MAX_ISSUES_LOGGED = 10;

/**
 * Id de búsqueda: el del ACL (un UUID en TBO). Se acota porque llega del navegador y forma parte
 * de la clave: nada de separadores ni comodines del `CachePort`.
 */
const SearchIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'id de búsqueda inválido');

const TenantIdSchema = z.string().uuid();

const EpochMsSchema = z.number().int().nonnegative();

/** Importe decimal sin signo tal como lo escribió el proveedor (`"305.75"`, `"17.100"`). */
const DecimalTextSchema = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+)?$/, 'importe decimal sin signo esperado');

const AccountFingerprintSchema = z
  .object({
    accountId: z.string().min(1).max(64),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** Cargos en el hotel de una tarifa: uno por habitación y concepto; más es un pack roto. */
const MAX_AT_PROPERTY_CHARGES = 64;

/** Lo que la búsqueda mostró de la tarifa, para la comparación C1 del PreBook (RF-15). */
const SeenRateSchema = z
  .object({
    total: MoneySchema.strict(),
    refundable: z.boolean(),
    board: BoardTypeSchema,
    mealTypeRaw: z.string().min(1).max(80).optional(),
    atPropertyCharges: z
      .array(HotelFeeSchema.extend({ amount: MoneySchema.strict() }).strict())
      .max(MAX_AT_PROPERTY_CHARGES),
  })
  .strict();

const PackContextSchema = z
  .object({
    hotelId: z.string().min(1).max(64),
    offerRef: z.string().min(1).max(255),
    totalText: DecimalTextSchema,
    currency: CurrencyCodeSchema,
    seen: SeenRateSchema,
  })
  .strict();

/** Una tarifa tal como queda en el contexto: lo que el PreBook reenvía y lo que se mostró. */
export type HotelSearchContextPack = z.infer<typeof PackContextSchema>;

/** `HotelSearchRateFacts` tal como se guarda. */
export type HotelSearchContextRateFacts = HotelSearchContextPack['seen'];

/**
 * Lo que la búsqueda muestra de una tarifa y C1 compara (docs/tbo/03 §2.9): neto, si es
 * reembolsable, régimen y cargos a pagar en el hotel. Sale del roompack NEUTRAL, el que llega al
 * vendedor, y no de lo que el ACL reporte aparte.
 */
export function searchRateFactsOf(pack: HotelRoompack): HotelSearchContextRateFacts {
  return {
    total: { ...pack.price.total },
    refundable: pack.cancellation.refundable,
    board: pack.board,
    ...(pack.mealTypeRaw === undefined ? {} : { mealTypeRaw: pack.mealTypeRaw }),
    atPropertyCharges: (pack.atPropertyCharges ?? []).map((fee) => ({
      ...fee,
      amount: { ...fee.amount },
    })),
  };
}

/**
 * Si UNA tarifa cabe en un contexto. El servicio la aplica pack por pack antes de guardar: el ACL
 * de TBO admite literales que aquí no entran (exponente, `-0.00`), y validados sólo en bloque, un
 * pack raro dejaría sin contexto —y sin tarifas— a toda la búsqueda de ese proveedor. Como en el
 * ACL, un pack inválido se descarta y se cuenta (RF-07).
 */
export function isStorablePackContext(pack: HotelSearchContextPack): boolean {
  return PackContextSchema.safeParse(pack).success;
}

/**
 * El registro completo. `.strict()` en cada nivel: un campo que no está aquí (un nombre, un
 * email) no entra por descuido.
 */
export const HotelSearchContextSchema = z
  .object({
    tenantId: TenantIdSchema,
    providerCode: HotelProviderCodeSchema,
    searchId: SearchIdSchema,
    checkinDate: z.string().date(),
    checkoutDate: z.string().date(),
    /** En el orden del Search: la lista de huéspedes del Book se arma habitación por habitación. */
    rooms: z.array(HotelRoomOccupancySchema.strict()).min(1).max(8),
    guestNationality: CountryCodeSchema.optional(),
    searchSentAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
    account: AccountFingerprintSchema,
    packs: z.array(PackContextSchema).min(1).max(MAX_PACKS),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.checkoutDate <= c.checkinDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkoutDate'],
        message: 'salida <= entrada',
      });
    }
    if (c.expiresAt <= c.searchSentAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'vence antes de buscar',
      });
    }
    if (c.expiresAt - c.searchSentAt > HOTEL_SEARCH_CONTEXT_MAX_LIFETIME_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'vida excesiva' });
    }
    // Dos tarifas con la misma referencia harían ambigua la resolución: ¿qué total se reenvía?
    const refs = new Set(c.packs.map((p) => p.offerRef));
    if (refs.size !== c.packs.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packs'], message: 'offerRef repetido' });
    }
  });
export type HotelSearchContext = z.infer<typeof HotelSearchContextSchema>;

/**
 * Lo ÚNICO que el navegador aporta para elegir una tarifa buscada: de qué proveedor es, de qué
 * búsqueda y cuál. Ocupación, fechas, nacionalidad e importe salen del contexto (RF-08 CA-4); lo
 * que venga de más se descarta al parsear.
 */
export const HotelOfferReferenceSchema = z.object({
  providerCode: HotelProviderCodeSchema,
  searchId: SearchIdSchema,
  offerRef: z.string().min(1).max(255),
});
export type HotelOfferReference = z.infer<typeof HotelOfferReferenceSchema>;

/** La tarifa elegida con todo lo que su búsqueda dejó en el servidor. */
export interface ResolvedHotelSearchOffer extends Omit<HotelSearchContext, 'packs'> {
  readonly pack: HotelSearchContextPack;
}

// ───────────────────────── Errores ─────────────────────────

/**
 * Motivo máquina de cada rechazo, para que la web ofrezca "Volver a buscar" sin interpretar el
 * texto.
 */
export type HotelSearchContextRejection =
  | 'SEARCH_CONTEXT_EXPIRED'
  | 'OFFER_NOT_IN_SEARCH'
  | 'OFFER_UNAVAILABLE'
  | 'SEARCH_ACCOUNT_CHANGED'
  | 'GUEST_NATIONALITY_MISSING'
  | 'SEARCH_CONTEXT_UNAVAILABLE';

/**
 * La búsqueda no está vigente para este tenant: venció, se perdió o nunca fue suya. Es la misma
 * respuesta en los tres casos para no confirmar que un `searchId` ajeno existe. 409, como una
 * oferta de vuelos vencida (`orders.service.ts`).
 */
export class HotelSearchContextExpiredError extends ConflictException {
  readonly reason: HotelSearchContextRejection = 'SEARCH_CONTEXT_EXPIRED';

  constructor() {
    super(
      'La búsqueda de esta tarifa ya no está vigente: los proveedores sostienen sus tarifas por tiempo limitado. Volvé a buscar para reservar.',
    );
    this.name = 'HotelSearchContextExpiredError';
  }
}

/**
 * La referencia no es una tarifa de esa búsqueda (RF-08 CA-2). Es 400 y se decide antes de llamar
 * al proveedor: reenviar una referencia que no emitió esta búsqueda es lo que el contexto impide.
 */
export class HotelOfferNotInSearchError extends BadRequestException {
  readonly reason: HotelSearchContextRejection = 'OFFER_NOT_IN_SEARCH';

  constructor() {
    super(
      'La tarifa elegida no pertenece a ninguna búsqueda vigente de esta agencia. Volvé a buscar y elegila de los resultados.',
    );
    this.name = 'HotelOfferNotInSearchError';
  }
}

/**
 * El proveedor ya dijo que esta tarifa no está disponible (TBO `201` o `207` en un PreBook). Se
 * responde sin volver a preguntarle: la búsqueda sigue vigente para sus otras tarifas (RF-15 CA-4).
 */
export class HotelOfferUnavailableError extends ConflictException {
  readonly reason: HotelSearchContextRejection = 'OFFER_UNAVAILABLE';

  constructor() {
    super(
      'Esta tarifa ya no está disponible. Elegí otra de la misma búsqueda o volvé a buscar para ver precios actualizados.',
    );
    this.name = 'HotelOfferUnavailableError';
  }
}

/**
 * La búsqueda salió sin la nacionalidad del pasajero principal y el proveedor tarifa según ella
 * (TBO, p. 10). No se completa con un valor por defecto (RF-06): se vuelve a buscar con ella.
 */
export class HotelSearchNationalityMissingError extends ConflictException {
  readonly reason: HotelSearchContextRejection = 'GUEST_NATIONALITY_MISSING';

  constructor() {
    super(
      'Esta tarifa depende de la nacionalidad del pasajero principal y la búsqueda se hizo sin ella. Volvé a buscar indicándola para reservar.',
    );
    this.name = 'HotelSearchNationalityMissingError';
  }
}

/**
 * La cuenta con la que se reservaría no es la que buscó (RF-08 CA-3): la credencial rotó o la
 * agencia cambió de cuenta heredada a propia. La referencia sólo vale en la cuenta que la emitió.
 */
export class HotelSearchAccountChangedError extends ConflictException {
  readonly reason: HotelSearchContextRejection = 'SEARCH_ACCOUNT_CHANGED';

  constructor() {
    super(
      'La cuenta del proveedor cambió desde la búsqueda (se renovó la credencial o cambió la cuenta que usa esta agencia). Volvé a buscar para reservar con la cuenta vigente.',
    );
    this.name = 'HotelSearchAccountChangedError';
  }
}

/**
 * El contexto de una búsqueda no se pudo guardar. Sus tarifas no se muestran: sin contexto no se
 * pueden reservar, y ofrecerlas sería prometer algo que el PreBook va a rechazar.
 */
export class HotelSearchContextUnavailableError extends ServiceUnavailableException {
  readonly reason: HotelSearchContextRejection = 'SEARCH_CONTEXT_UNAVAILABLE';

  constructor() {
    super(
      'No pudimos preparar la reserva de las tarifas de este proveedor. Volvé a buscar; si se repite, avisá al administrador.',
    );
    this.name = 'HotelSearchContextUnavailableError';
  }
}

// ───────────────────────── Almacén ─────────────────────────

function keyOf(tenantId: string, searchId: string): string {
  return `${KEY_PREFIX}:${tenantId}:${searchId}`;
}

/**
 * Marca de una tarifa que el proveedor dio por no disponible. La referencia va digerida: puede
 * traer cualquier carácter (el `BookingCode` de TBO lleva `!`) y la clave no admite comodines.
 */
function goneKeyOf(tenantId: string, searchId: string, offerRef: string): string {
  const digest = createHash('sha256').update(offerRef).digest('hex');
  return `${keyOf(tenantId, searchId)}:gone:${digest}`;
}

/** `ruta:código` de cada problema, sin valores: la ruta de `rooms` no dice edades. */
function issueRefs(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES_LOGGED)
    .map((i) => `${i.path.join('.') || '(raíz)'}:${i.code}`)
    .join(', ');
}

function sameAccount(
  a: HotelProviderAccountFingerprint,
  b: HotelProviderAccountFingerprint,
): boolean {
  return a.accountId === b.accountId && Date.parse(a.updatedAt) === Date.parse(b.updatedAt);
}

@Injectable()
export class HotelSearchContextStore {
  private readonly logger = new Logger(HotelSearchContextStore.name);

  constructor(@Inject(HOTEL_SEARCH_CONTEXT_CACHE) private readonly cache: CachePort) {}

  /**
   * Guarda el contexto de una búsqueda. Si ya había uno vigente con el mismo `searchId`, queda el
   * primero: repetir el guardado no reinicia el reloj ni estira el vencimiento.
   *
   * @throws HotelSearchContextUnavailableError si el registro no cumple el esquema.
   * @throws HotelSearchContextExpiredError si ya venció al llegar.
   */
  async save(context: HotelSearchContext): Promise<void> {
    const parsed = HotelSearchContextSchema.safeParse(context);
    if (!parsed.success) {
      this.logger.warn(
        `hotels.search_context.rejected provider=${String(context.providerCode)} issues=[${issueRefs(parsed.error)}]`,
      );
      throw new HotelSearchContextUnavailableError();
    }
    const entry = parsed.data;

    const now = Date.now();
    if (entry.expiresAt <= now) throw new HotelSearchContextExpiredError();

    const existing = await this.get(entry.tenantId, entry.searchId);
    if (existing !== undefined) {
      if (existing.providerCode !== entry.providerCode) {
        // Dos proveedores con el mismo id de búsqueda: las tarifas del segundo quedan sin
        // contexto y su PreBook pide volver a buscar. Visible, nunca mezclado.
        this.logger.warn(
          `hotels.search_context.duplicate_search_id provider=${entry.providerCode} kept=${existing.providerCode}`,
        );
      }
      return;
    }

    await this.cache.set(
      keyOf(entry.tenantId, entry.searchId),
      entry,
      Math.ceil((entry.expiresAt - now) / 1000),
    );
  }

  /** El contexto vigente de una búsqueda del tenant, o `undefined`. */
  async get(tenantId: string, searchId: string): Promise<HotelSearchContext | undefined> {
    if (
      !TenantIdSchema.safeParse(tenantId).success ||
      !SearchIdSchema.safeParse(searchId).success
    ) {
      return undefined;
    }
    const key = keyOf(tenantId, searchId);
    const raw = await this.cache.get<unknown>(key);
    if (raw === null) return undefined;

    const parsed = HotelSearchContextSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`hotels.search_context.unreadable issues=[${issueRefs(parsed.error)}]`);
      await this.cache.delete(key);
      return undefined;
    }
    const entry = parsed.data;
    // La clave ya es del tenant; esto es la segunda puerta, por si otra implementación del
    // `CachePort` resolviera claves distintas al mismo valor.
    if (entry.tenantId !== tenantId || entry.searchId !== searchId) return undefined;
    // El TTL del `CachePort` va en segundos enteros: el vencimiento exacto se decide aquí.
    if (entry.expiresAt <= Date.now()) {
      await this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * La tarifa que eligió el navegador, resuelta contra el contexto de su búsqueda. Es la puerta
   * del PreBook y del Book: todo lo que llega al proveedor sale de aquí, y cualquier rechazo
   * ocurre antes de llamarlo.
   *
   * @param currentAccount huella de la cuenta con la que se reservaría AHORA.
   * @throws HotelOfferNotInSearchError la referencia no es una tarifa de esa búsqueda (400).
   * @throws HotelSearchContextExpiredError la búsqueda no está vigente para este tenant (409).
   * @throws HotelOfferUnavailableError el proveedor ya la dio por no disponible (409).
   * @throws HotelSearchAccountChangedError la cuenta cambió desde la búsqueda (409).
   */
  async resolveOffer(
    tenantId: string,
    reference: HotelOfferReference,
    currentAccount: HotelProviderAccountFingerprint,
  ): Promise<ResolvedHotelSearchOffer> {
    const ref = HotelOfferReferenceSchema.safeParse(reference);
    if (!ref.success) throw new HotelOfferNotInSearchError();
    const { providerCode, searchId, offerRef } = ref.data;

    const context = await this.get(tenantId, searchId);
    if (context === undefined) throw new HotelSearchContextExpiredError();

    const pack =
      context.providerCode === providerCode
        ? context.packs.find((p) => p.offerRef === offerRef)
        : undefined;
    if (pack === undefined) throw new HotelOfferNotInSearchError();

    if ((await this.cache.get<unknown>(goneKeyOf(tenantId, searchId, offerRef))) !== null) {
      throw new HotelOfferUnavailableError();
    }

    if (!sameAccount(context.account, currentAccount)) throw new HotelSearchAccountChangedError();

    const { packs: _packs, ...search } = context;
    return { ...search, pack };
  }

  /**
   * Da por no disponible UNA tarifa de una búsqueda vigente: el proveedor lo dijo en un PreBook
   * (RF-15 CA-4). Es una marca aparte y no una reescritura del contexto: dos PreBooks concurrentes
   * sobre la misma búsqueda no se pisan, y la marca vence con la búsqueda.
   */
  async invalidateOffer(tenantId: string, searchId: string, offerRef: string): Promise<void> {
    const context = await this.get(tenantId, searchId);
    if (context === undefined) return;
    await this.cache.set(
      goneKeyOf(tenantId, searchId, offerRef),
      true,
      Math.ceil((context.expiresAt - Date.now()) / 1000),
    );
  }

  /** Olvida una búsqueda: el proveedor dijo que su sesión venció (TBO `315`, RF-09). */
  async forget(tenantId: string, searchId: string): Promise<void> {
    if (
      !TenantIdSchema.safeParse(tenantId).success ||
      !SearchIdSchema.safeParse(searchId).success
    ) {
      return;
    }
    await this.cache.delete(keyOf(tenantId, searchId));
  }
}
