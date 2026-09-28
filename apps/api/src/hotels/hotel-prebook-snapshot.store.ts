import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  HotelProviderCodeSchema,
  HotelRoomOccupancySchema,
  HotelRoompackSchema,
  MoneySchema,
} from '@sales-travel/canonical';
import type { CachePort } from '@sales-travel/core';
import { CountryCodeSchema, CurrencyCodeSchema, z } from '@sales-travel/validation';
import {
  HOTEL_SEARCH_CONTEXT_CACHE,
  HotelSearchContextExpiredError,
} from './hotel-search-context.store.js';

/**
 * El PreBook aceptable, guardado en el servidor por `(tenantId, prebookRef)` (docs/tbo/09 PR-4.5;
 * 03 §2.9 y §5.1).
 *
 * Es lo que el vendedor vio y puede aceptar: la tarifa revalidada con sus políticas finales, el
 * precio de venta calculado sobre el neto nuevo, las condiciones en sus dos versiones (la saneada,
 * que se muestra, y la original, para disputas: 03 §2.4 punto 9) y la huella con la que la saga
 * del Book (PR-4.6) hace la segunda comparación (C2). El Book se pide con `prebookRef` y nada de
 * esto vuelve a salir del navegador.
 *
 * Mismas reglas que el contexto de búsqueda, del que depende:
 *
 * - **Vence con la oferta** (`searchSentAt + 27 min` en TBO, RF-09): el PreBook no renueva el
 *   reloj mientras TBO no diga lo contrario (Q-29).
 * - **Por tenant**: un `prebookRef` de otro tenant no resuelve.
 * - **Validado con Zod al entrar y al salir**, `.strict()`: lo que no está aquí no entra.
 * - **Vive en la misma memoria que el contexto** (`HOTEL_SEARCH_CONTEXT_CACHE`): un despliegue que
 *   pierde uno pierde el otro, y los dos piden volver a buscar.
 *
 * Guarda la ocupación y la nacionalidad de la búsqueda: nada de este módulo la escribe en un log.
 */

const KEY_PREFIX = 'hotels:prebook';

const MAX_ISSUES_LOGGED = 10;

/** Techos holgados: una "norma" de TBO puede traer párrafos enteros (p. 31-32). */
const MAX_RATE_CONDITIONS = 200;
const MAX_RATE_CONDITION_TEXT = 20_000;

const UuidSchema = z.string().uuid();

const EpochMsSchema = z.number().int().nonnegative();

const DecimalTextSchema = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+)?$/, 'importe decimal sin signo esperado');

const RateConditionSchema = z
  .object({
    category: z.enum([
      'checkIn',
      'checkOut',
      'minCheckInAge',
      'mandatoryFees',
      'optionalFees',
      'cardsAccepted',
      'specialInstructions',
      'other',
    ]),
    text: z.string().max(MAX_RATE_CONDITION_TEXT),
    raw: z.string().max(MAX_RATE_CONDITION_TEXT),
  })
  .strict();

const RateSignalSchema = z.enum([
  'PACKAGE_WITH_FLIGHT_ONLY',
  'NO_NAME_CHANGE',
  'MARKET_RESTRICTION',
]);

const ComparisonSchema = z
  .object({
    stage: z.enum(['C1', 'C2']),
    outcome: z.enum(['UNCHANGED', 'DECREASED', 'INCREASED', 'CONDITIONS_CHANGED']),
    price: z.enum(['SAME', 'DOWN', 'UP', 'NOT_COMPARABLE']),
    changes: z.array(
      z.enum([
        'CURRENCY',
        'REFUNDABLE',
        'MEAL_TYPE',
        'AT_PROPERTY_CHARGES',
        'CANCEL_POLICIES',
        'SIGNALS',
        'RATE_CONDITIONS',
      ]),
    ),
    previousTotal: MoneySchema.strict(),
    currentTotal: MoneySchema.strict(),
  })
  .strict();

export const HotelPrebookSnapshotSchema = z
  .object({
    prebookRef: UuidSchema,
    tenantId: UuidSchema,
    providerCode: HotelProviderCodeSchema,
    searchId: z.string().min(1).max(64),
    /** Huella de la cuenta que revalidó: el Book tiene que salir por la misma (RF-08 CA-3). */
    account: z
      .object({
        accountId: z.string().min(1).max(64),
        updatedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    hotelId: z.string().min(1).max(64),
    /** La referencia DEL PreBook, que puede no ser la de la búsqueda (Q-30). */
    offerRef: z.string().min(1).max(255),
    /** El literal del total DEL PreBook: lo que el Book reenvía, nunca una reconstrucción. */
    totalText: DecimalTextSchema,
    currency: CurrencyCodeSchema,
    checkinDate: z.string().date(),
    checkoutDate: z.string().date(),
    rooms: z.array(HotelRoomOccupancySchema.strict()).min(1).max(8),
    guestNationality: CountryCodeSchema.optional(),
    searchSentAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
    /** Con las políticas finales del PreBook y el precio de venta (`pricing`). */
    roompack: HotelRoompackSchema,
    rateConditions: z.array(RateConditionSchema).max(MAX_RATE_CONDITIONS),
    signals: z.array(RateSignalSchema),
    rateConditionsHash: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex esperado'),
    /** C1: contra lo que mostró la búsqueda. */
    comparison: ComparisonSchema,
    createdAt: EpochMsSchema,
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.expiresAt <= s.searchSentAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'vence antes de buscar',
      });
    }
    // El precio que se acepta y el total que se reenvía tienen que ser de la misma tarifa.
    if (s.roompack.price.total.currency !== s.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'moneda distinta de la del pack',
      });
    }
  });
export type HotelPrebookSnapshot = z.infer<typeof HotelPrebookSnapshotSchema>;

/**
 * El PreBook respondió pero su lectura no se pudo guardar: sin el snapshot, el Book no tendría qué
 * aceptar. Es 503 y no se muestra la tarifa: ofrecerla sería prometer una reserva que no se puede
 * pedir.
 */
export class HotelPrebookSnapshotUnavailableError extends ServiceUnavailableException {
  readonly reason = 'PREBOOK_SNAPSHOT_UNAVAILABLE';

  constructor() {
    super(
      'No pudimos preparar la reserva de esta tarifa. Volvé a revalidarla; si se repite, avisá al administrador.',
    );
    this.name = 'HotelPrebookSnapshotUnavailableError';
  }
}

function keyOf(tenantId: string, prebookRef: string): string {
  return `${KEY_PREFIX}:${tenantId}:${prebookRef}`;
}

/** `ruta:código` de cada problema, sin valores. */
function issueRefs(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES_LOGGED)
    .map((i) => `${i.path.join('.') || '(raíz)'}:${i.code}`)
    .join(', ');
}

@Injectable()
export class HotelPrebookSnapshotStore {
  private readonly logger = new Logger(HotelPrebookSnapshotStore.name);

  constructor(@Inject(HOTEL_SEARCH_CONTEXT_CACHE) private readonly cache: CachePort) {}

  /**
   * @throws HotelPrebookSnapshotUnavailableError si el snapshot no cumple el esquema.
   * @throws HotelSearchContextExpiredError si la oferta ya venció al llegar.
   */
  async save(snapshot: HotelPrebookSnapshot): Promise<void> {
    const parsed = HotelPrebookSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      this.logger.warn(
        `hotels.prebook_snapshot.rejected provider=${String(snapshot.providerCode)} issues=[${issueRefs(parsed.error)}]`,
      );
      throw new HotelPrebookSnapshotUnavailableError();
    }
    const entry = parsed.data;
    const now = Date.now();
    if (entry.expiresAt <= now) throw new HotelSearchContextExpiredError();
    await this.cache.set(
      keyOf(entry.tenantId, entry.prebookRef),
      entry,
      Math.ceil((entry.expiresAt - now) / 1000),
    );
  }

  /** El PreBook vigente del tenant, o `undefined`. */
  async get(tenantId: string, prebookRef: string): Promise<HotelPrebookSnapshot | undefined> {
    if (!UuidSchema.safeParse(tenantId).success || !UuidSchema.safeParse(prebookRef).success) {
      return undefined;
    }
    const key = keyOf(tenantId, prebookRef);
    const raw = await this.cache.get<unknown>(key);
    if (raw === null) return undefined;

    const parsed = HotelPrebookSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`hotels.prebook_snapshot.unreadable issues=[${issueRefs(parsed.error)}]`);
      await this.cache.delete(key);
      return undefined;
    }
    const entry = parsed.data;
    // Segunda puerta, como en el contexto: la clave ya es del tenant.
    if (entry.tenantId !== tenantId || entry.prebookRef !== prebookRef) return undefined;
    if (entry.expiresAt <= Date.now()) {
      await this.cache.delete(key);
      return undefined;
    }
    return entry;
  }
}
