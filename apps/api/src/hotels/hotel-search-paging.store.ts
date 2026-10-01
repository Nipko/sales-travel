import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { HotelProviderCodeSchema, HotelRoomOccupancySchema } from '@sales-travel/canonical';
import type { CachePort } from '@sales-travel/core';
import { CountryCodeSchema, CurrencyCodeSchema, z } from '@sales-travel/validation';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import { isProviderDestinationId } from './hotel-destination.js';
import {
  HOTEL_SEARCH_MAX_PAGE_NUMBER,
  HOTEL_SEARCH_MAX_PAGES,
  HOTEL_SEARCH_PAGING_TTL_MS,
  type HotelPagingCursor,
  type HotelSearchPaging,
} from './hotel-search-paging.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';

/**
 * Las búsquedas por tramos en el servidor (hotel-search-paging.ts; docs/tbo/02 §4.4).
 *
 * Cada búsqueda por destino que deja hoteles sin consultar guarda aquí, por `(tenantId, sessionId)`,
 * lo que el tramo siguiente necesita: la búsqueda tal como la validó el borde HTTP —con la moneda y
 * el país de venta YA resueltos, para que un cambio de la agencia a mitad de camino no mezcle
 * monedas en la misma lista— y, por proveedor, sus códigos del destino en el orden del catálogo y
 * por dónde va. El navegador sólo manda el `sessionId` y el número de tramo: fechas, ocupación,
 * moneda y nacionalidad salen de aquí, así que un tramo nunca busca otra cosa que el primero.
 *
 * Las reglas son las del contexto de búsqueda (hotel-search-context.store.ts):
 *
 * - **Por tenant.** La clave lleva el tenant que buscó; un `sessionId` de otro no resuelve.
 * - **Validado con Zod al entrar y al salir**, `.strict()` en cada nivel.
 * - **Vence solo.** {@link HOTEL_SEARCH_PAGING_TTL_MS} desde el primer tramo; seguir cargando no
 *   lo estira. La entrada vencida se va de la memoria en el barrido de la caché (cada minuto,
 *   memory-cache.adapter.ts), aunque nadie la vuelva a pedir.
 * - **Chico.** Los códigos de cada proveedor se guardan en UN texto separado por comas, no en un
 *   arreglo de miles de textos, y la instancia de caché tiene su propio techo
 *   ({@link HotelSearchPagingMemoryCache}).
 * - **Falla hacia el lado seguro.** Sin registro (venció, se desalojó o se perdió con un
 *   despliegue) se pide volver a buscar; nunca se reconstruye con lo que mande el navegador.
 *
 * Guarda PII (edades de niños y nacionalidad): nada de este módulo la escribe en un log.
 */

/** Token DI del `CachePort` de las búsquedas por tramos: una instancia propia en memoria. */
export const HOTEL_SEARCH_PAGING_CACHE = 'HOTEL_SEARCH_PAGING_CACHE';

/**
 * Cuántas búsquedas por tramos vivas guarda el proceso como mucho. Una con 2.000 códigos de TBO y
 * 1.000 de Despegar ocupa unos 25 KB guardada en texto: el techo deja el peor caso en ~25 MB.
 * Llegado a él se desalojan las más viejas, que al pedir "Ver más" piden volver a buscar.
 */
export const HOTEL_SEARCH_PAGING_MAX_ENTRIES = 1_000;

/** La instancia de caché de los tramos: la de memoria, con un techo más bajo que la general. */
@Injectable()
export class HotelSearchPagingMemoryCache extends MemoryCacheAdapter {
  protected override readonly maxEntries = HOTEL_SEARCH_PAGING_MAX_ENTRIES;
}

const KEY_PREFIX = 'hotels:search-paging';

const MAX_ISSUES_LOGGED = 10;

/** Más de lo que guarda cualquier proveedor: `maxHotelsPerSearch` (100 como mucho) × 20 tramos. */
const MAX_HOTEL_IDS = 100 * HOTEL_SEARCH_MAX_PAGES;

/** Separador de los códigos guardados: no aparece en ningún código válido. */
const ID_SEPARATOR = ',';

const TenantIdSchema = z.string().uuid();
const SessionIdSchema = z.string().uuid();
const EpochMsSchema = z.number().int().nonnegative();
const HotelIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^,\s]+$/, 'código de hotel inválido');

/**
 * La búsqueda tal como la validó el borde, sin `hotelIds` (los tramos son sólo por destino) y con
 * la moneda y el país de venta que usó el primer tramo.
 */
const PagedSearchSchema = z
  .object({
    checkinDate: z.string().date(),
    checkoutDate: z.string().date(),
    currency: CurrencyCodeSchema,
    destinationId: z.union([
      z.number().int().positive(),
      z.string().refine(isProviderDestinationId, 'destino de proveedor inválido'),
    ]),
    rooms: z.array(HotelRoomOccupancySchema.strict()).min(1).max(8),
    guestNationality: CountryCodeSchema.optional(),
    countryCode: z.string().length(2).optional(),
    language: z.enum(['EN', 'ES', 'PT']).optional(),
    refundableOnly: z.boolean().optional(),
  })
  .strict();

const cursorShape = {
  code: HotelProviderCodeSchema,
  catalogTotal: z.number().int().nonnegative(),
  consulted: z.number().int().nonnegative(),
  pageSize: z.number().int().min(1).max(100),
  fallback: z.literal(true).optional(),
  stopped: z.literal(true).optional(),
};

const CursorSchema = z
  .object({ ...cursorShape, hotelIds: z.array(HotelIdSchema).min(1).max(MAX_HOTEL_IDS) })
  .strict()
  .refine((c) => c.consulted <= c.hotelIds.length, { message: 'consulted > hotelIds' });

/** El cursor tal como queda en la caché: los códigos en un solo texto. */
const StoredCursorSchema = z
  .object({
    ...cursorShape,
    hotelIds: z
      .string()
      .min(1)
      .max(MAX_HOTEL_IDS * 65),
  })
  .strict();

const sessionShape = {
  tenantId: TenantIdSchema,
  sessionId: SessionIdSchema,
  /** El tramo que se puede pedir ahora, base 0 (el 0 fue la búsqueda). */
  nextPage: z.number().int().min(1).max(HOTEL_SEARCH_MAX_PAGE_NUMBER),
  createdAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
  search: PagedSearchSchema,
};

export const HotelSearchPagingSessionSchema = z
  .object({ ...sessionShape, cursors: z.array(CursorSchema).min(1).max(16) })
  .strict()
  .superRefine((s, ctx) => {
    if (s.expiresAt <= s.createdAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'vence antes' });
    }
    if (s.expiresAt - s.createdAt > HOTEL_SEARCH_PAGING_TTL_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'vida excesiva' });
    }
    const codes = new Set(s.cursors.map((c) => c.code));
    if (codes.size !== s.cursors.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursors'],
        message: 'proveedor repetido',
      });
    }
  });

/** El registro en la caché. Al leerlo se abre y se vuelve a validar con el esquema completo. */
const StoredSessionSchema = z
  .object({ ...sessionShape, cursors: z.array(StoredCursorSchema).min(1).max(16) })
  .strict();

/**
 * La búsqueda de un tramo: la del primero, sin `hotelIds` y con la moneda ya resuelta (la que
 * vino o la de la agencia en ese momento).
 */
export type HotelPagedSearch = Omit<HotelAvailabilityInput, 'hotelIds' | 'currency'> & {
  readonly currency: string;
};

export interface HotelSearchPagingSession {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly nextPage: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly search: HotelPagedSearch;
  readonly cursors: readonly HotelPagingCursor[];
}

// ───────────────────────── Errores ─────────────────────────

/** Motivo máquina de cada rechazo, para que la web sepa qué ofrecer sin leer el texto. */
export type HotelSearchPagingRejection =
  | 'SEARCH_PAGING_EXPIRED'
  | 'SEARCH_PAGE_NOT_NEXT'
  | 'SEARCH_PAGING_EXHAUSTED';

/**
 * La búsqueda no está vigente para este tenant: venció, se perdió o nunca fue suya. La misma
 * respuesta en los tres casos, para no confirmar que un `sessionId` ajeno existe. También cuando
 * la agencia cambió algo que la búsqueda usó (su moneda, su markup): seguir con otra moneda
 * mezclaría precios en la misma lista, así que se pide buscar de nuevo con otro texto.
 */
export class HotelSearchPagingExpiredError extends ConflictException {
  readonly reason: HotelSearchPagingRejection = 'SEARCH_PAGING_EXPIRED';

  constructor(message = 'Esta búsqueda ya no está vigente. Vuelve a buscar para ver más hoteles.') {
    super(message);
    this.name = 'HotelSearchPagingExpiredError';
  }
}

/**
 * El tramo pedido no es el siguiente: ya se cargó (una respuesta que no llegó al navegador y que
 * ya no se puede repetir) o se saltó uno. No se repite ni se salta: `details.nextPage` dice cuál
 * sigue y `details.paging`, cuánto se consultó de verdad, para que la pantalla se ponga al día.
 */
export class HotelSearchPageNotNextError extends ConflictException {
  readonly reason: HotelSearchPagingRejection = 'SEARCH_PAGE_NOT_NEXT';
  readonly publicDetails: { readonly nextPage: number; readonly paging?: HotelSearchPaging };

  constructor(nextPage: number, paging?: HotelSearchPaging) {
    super(
      'Esos hoteles ya se consultaron en esta búsqueda. Sigue con los siguientes o vuelve a buscar para verlos de nuevo.',
    );
    this.name = 'HotelSearchPageNotNextError';
    this.publicDetails = paging === undefined ? { nextPage } : { nextPage, paging };
  }
}

/** No queda nada por consultar en esta búsqueda. */
export class HotelSearchPagingExhaustedError extends ConflictException {
  readonly reason: HotelSearchPagingRejection = 'SEARCH_PAGING_EXHAUSTED';

  constructor() {
    super('Ya consultamos todos los hoteles de esta búsqueda.');
    this.name = 'HotelSearchPagingExhaustedError';
  }
}

// ───────────────────────── Almacén ─────────────────────────

function keyOf(tenantId: string, sessionId: string): string {
  return `${KEY_PREFIX}:${tenantId}:${sessionId}`;
}

/** `ruta:código` de cada problema, sin valores: la ruta de `rooms` no dice edades. */
function issueRefs(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES_LOGGED)
    .map((i) => `${i.path.join('.') || '(raíz)'}:${i.code}`)
    .join(', ');
}

@Injectable()
export class HotelSearchPagingStore {
  private readonly logger = new Logger(HotelSearchPagingStore.name);

  constructor(@Inject(HOTEL_SEARCH_PAGING_CACHE) private readonly cache: CachePort) {}

  /**
   * Guarda el estado de una búsqueda por tramos. `false` si no cumple el esquema o ya venció: la
   * búsqueda sale igual, sin tramos siguientes. Nunca lanza por eso.
   */
  async save(session: HotelSearchPagingSession): Promise<boolean> {
    const parsed = HotelSearchPagingSessionSchema.safeParse(session);
    if (!parsed.success) {
      this.logger.warn(`hotels.search_paging.rejected issues=[${issueRefs(parsed.error)}]`);
      return false;
    }
    const entry = parsed.data;
    const ttlMs = entry.expiresAt - Date.now();
    if (ttlMs <= 0) return false;
    const stored: z.infer<typeof StoredSessionSchema> = {
      ...entry,
      cursors: entry.cursors.map((c) => ({ ...c, hotelIds: c.hotelIds.join(ID_SEPARATOR) })),
    };
    await this.cache.set(keyOf(entry.tenantId, entry.sessionId), stored, Math.ceil(ttlMs / 1000));
    return true;
  }

  /** El estado vigente de una búsqueda del tenant, o `undefined`. */
  async get(tenantId: string, sessionId: string): Promise<HotelSearchPagingSession | undefined> {
    if (
      !TenantIdSchema.safeParse(tenantId).success ||
      !SessionIdSchema.safeParse(sessionId).success
    ) {
      return undefined;
    }
    const key = keyOf(tenantId, sessionId);
    const raw = await this.cache.get<unknown>(key);
    if (raw === null) return undefined;

    const stored = StoredSessionSchema.safeParse(raw);
    if (!stored.success) return this.unreadable(key, stored.error);
    const parsed = HotelSearchPagingSessionSchema.safeParse({
      ...stored.data,
      cursors: stored.data.cursors.map((c) => ({ ...c, hotelIds: c.hotelIds.split(ID_SEPARATOR) })),
    });
    if (!parsed.success) return this.unreadable(key, parsed.error);
    const entry = parsed.data;
    // La clave ya es del tenant; esto es la segunda puerta, como en el contexto de búsqueda.
    if (entry.tenantId !== tenantId || entry.sessionId !== sessionId) return undefined;
    if (entry.expiresAt <= Date.now()) {
      await this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Un registro que no cumple no existe: se borra y se pide volver a buscar. */
  private async unreadable(key: string, error: z.ZodError): Promise<undefined> {
    this.logger.warn(`hotels.search_paging.unreadable issues=[${issueRefs(error)}]`);
    await this.cache.delete(key);
    return undefined;
  }
}
