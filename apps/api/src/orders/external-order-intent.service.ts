import { ConflictException, Injectable } from '@nestjs/common';
import { CurrencyCodeSchema, z } from '@sales-travel/validation';
import { DatabaseService } from '../database/database.service.js';
import type { ProviderVertical } from '../providers/provider.types.js';
import {
  OrderCreateIntentStore,
  createRequestKey,
  uniqueViolationConstraint,
} from './order-create-intent.store.js';
import type { OrderRow } from './orders.service.js';

/**
 * API pública del intent de creación para las verticales que reservan fuera de `OrdersService`
 * (docs/tbo/08 RF-20, parte de persistencia; docs/tbo/06 §5.5).
 *
 * `recordExternalOrder` inserta DESPUÉS de que el proveedor confirmó. Sirve mientras un timeout
 * no pueda dejar una reserva viva sin fila; con un proveedor que exige consultar la reserva por
 * nuestra referencia cuando la respuesta no llega (TBO, p. 42), la fila y la referencia tienen
 * que existir ANTES de llamar. Estos tres métodos son esa secuencia, sobre los mismos primitivos
 * que la saga de vuelos:
 *
 *  1. `openExternalCreateIntent`: fila `pending` con la clave de idempotencia, la referencia que
 *     se va a mandar y la cuenta con la que se va a reservar, en UNA transacción comprometida
 *     antes de volver. Un segundo envío con la misma clave es 409 `duplicateRequest`.
 *  2. `settleExternalCreateIntent`: el proveedor contestó algo definitivo. CAS sobre `pending` con
 *     `provider_raw` nulo; `failed` libera la clave.
 *  3. `failExternalCreateIntent`: la llamada NO salió (revalidación, breaker, auditoría). Libera
 *     la clave para que el vendedor reintente.
 *
 * Un desenlace incierto no llama a ninguno de los dos cierres: el intent queda `pending`, con la
 * clave tomada, hasta que la verificación lo consolide con el mismo CAS.
 *
 * Los `domain_events` los emite la saga de cada vertical, en el orden que exige su proveedor. Este
 * servicio no conoce proveedores: ningún literal de proveedor entra acá.
 */

const PROVIDER_BOOKING_REF_CONSTRAINT = 'uq_orders_provider_booking_ref';

/** Vuelos tiene su propia saga en `OrdersService.createOrder`. */
export type ExternalOrderVertical = Exclude<ProviderVertical, 'flights'>;

const EXTERNAL_VERTICALS = ['hotels', 'cars'] as const satisfies readonly ExternalOrderVertical[];

/** Claves de `provider_raw` que escribe este servicio; la lista blanca del llamador no las pisa. */
const RESERVED_PROVIDER_RAW_KEYS = ['phase', 'outcome'] as const;

/** Tope de `orders.total_amount` (INTEGER). */
const MAX_AMOUNT_MINOR = 2_147_483_647;

/**
 * El input no cumple el contrato. Es un error de cableado de quien llama, no del usuario: nunca se
 * envió nada al proveedor. El mensaje lleva rutas y códigos de Zod, nunca valores, porque el
 * input arrastra datos de huéspedes.
 */
export class ExternalOrderIntentInputError extends Error {
  constructor(operation: string, issues: readonly z.ZodIssue[]) {
    super(
      `${operation}: input inválido (${issues
        .map((issue) => `${issue.path.join('.') || '(raíz)'}:${issue.code}`)
        .join(', ')})`,
    );
    this.name = 'ExternalOrderIntentInputError';
  }
}

/**
 * La referencia de reserva ya existe para ese proveedor, en este tenant o en otro. Se genera con
 * un generador criptográfico por cada envío, así que un choque es una referencia REUTILIZADA, y
 * mandarla al proveedor haría que la recuperación consulte la reserva de otra orden. No se
 * reintenta acá: el intent no se creó y quien llama no debe llamar al proveedor.
 *
 * 409 por el nombre del índice (`uq_orders_provider_booking_ref`), distinto del de una clave de
 * idempotencia repetida (`uq_orders_create_request_key`): aquel es "esta venta ya existe, no la
 * repitas"; éste es "no se abrió nada y no salió nada", y el vendedor puede volver a intentarlo, que
 * sale con otra referencia. Por eso no lleva las marcas de conciliación.
 */
export class ProviderBookingRefTakenError extends ConflictException {
  readonly reason = 'BOOKING_REFERENCE_TAKEN';

  constructor(readonly provider: string) {
    super(
      'No pudimos abrir la reserva: la referencia que generamos para el proveedor ya estaba en uso. No se envió nada; volvé a intentarlo.',
    );
    this.name = 'ProviderBookingRefTakenError';
  }
}

const ProviderCodeSchema = z
  .string()
  .max(50)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * Viaja al proveedor y vuelve en su conciliación; se busca por igualdad exacta. Un espacio o un
 * símbolo que alguien recorte en el camino la vuelve irrecuperable.
 */
const ProviderBookingRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z_-]+$/);

const AmountMinorSchema = z.number().int().min(0).max(MAX_AMOUNT_MINOR);

const JsonSnapshotSchema = z.unknown().refine((value) => value !== undefined, {
  message: 'requerido',
});

const OpenInputSchema = z
  .object({
    provider: ProviderCodeSchema,
    vertical: z.enum(EXTERNAL_VERTICALS),
    idempotencyKey: z.string().optional(),
    quotationId: z.string().uuid().optional(),
    searchCriteria: z.record(z.unknown()),
    selectedOffer: JsonSnapshotSchema,
    passengers: JsonSnapshotSchema,
    contactInfo: JsonSnapshotSchema,
    totalAmountMinor: AmountMinorSchema,
    currency: CurrencyCodeSchema,
    providerBookingRef: ProviderBookingRefSchema.nullable(),
    providerAccountId: z.string().uuid().nullable(),
  })
  .strict();

/**
 * Una lista blanca PLANA de escalares. Un objeto anidado es la forma de un volcado de respuesta,
 * que arrastra el eco de lo que mandamos (nombres, email, teléfono) a una columna que no se purga.
 */
const ProviderRawWhitelistSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((raw) => Object.keys(raw).length <= 20, { message: 'demasiadas claves' })
  .refine(
    (raw) =>
      RESERVED_PROVIDER_RAW_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(raw, key)),
    { message: 'clave reservada' },
  );

const RevalidatedSnapshotSchema = z
  .object({
    selectedOffer: JsonSnapshotSchema,
    totalAmountMinor: AmountMinorSchema,
    currency: CurrencyCodeSchema,
  })
  .strict();

/** Un código cerrado nuestro, nunca el texto del proveedor: `error_message` vuelve al navegador. */
const ErrorMessageSchema = z.string().min(1).max(500).nullable().optional();

const SettleInputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('confirmed'),
      // Una reserva confirmada sin localizador no se puede leer ni cancelar después: para la saga
      // es un desenlace incierto, no un `confirmed`.
      providerOrderId: z.string().trim().min(1).max(100),
      providerRaw: ProviderRawWhitelistSchema,
      errorMessage: ErrorMessageSchema,
      snapshot: RevalidatedSnapshotSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      providerOrderId: z.string().trim().min(1).max(100).nullable().optional(),
      providerRaw: ProviderRawWhitelistSchema,
      errorMessage: ErrorMessageSchema,
      snapshot: RevalidatedSnapshotSchema.optional(),
    })
    .strict(),
]);

export interface OpenExternalCreateIntentInput {
  /** Código del proveedor que va a reservar; la post-venta enruta por esta columna. */
  provider: string;
  /** Se escribe en `search_criteria.vertical`: reportes y barridos distinguen la vertical por ahí. */
  vertical: ExternalOrderVertical;
  /** Cabecera `Idempotency-Key` del request (UUID). Sin ella, 400 antes de tocar la base. */
  idempotencyKey: string | undefined;
  /**
   * Sólo vincula la orden a la cotización, que tiene que ser del tenant. NO deriva la clave: una
   * cotización puede llevar un vuelo y un hotel, y `q:<cotización>` los haría chocar entre sí.
   */
  quotationId?: string;
  searchCriteria: Record<string, unknown>;
  selectedOffer: unknown;
  passengers: unknown;
  contactInfo: unknown;
  /** Precio final al cliente, en unidades menores. */
  totalAmountMinor: number;
  currency: string;
  /** Referencia que se va a mandar al proveedor, o `null` si la vertical no la usa. */
  providerBookingRef: string | null;
  /** Cuenta BYOC con la que se va a reservar, o `null` si la vertical no la resuelve por cuenta. */
  providerAccountId: string | null;
}

/** Lo que dijo el proveedor, cuando es definitivo. */
export type ExternalCreateOutcome =
  | {
      status: 'confirmed';
      providerOrderId: string;
      providerRaw: Record<string, string | number | boolean | null>;
      errorMessage?: string | null;
      snapshot?: RevalidatedSnapshot;
    }
  | {
      status: 'failed';
      providerOrderId?: string | null;
      providerRaw: Record<string, string | number | boolean | null>;
      errorMessage?: string | null;
      snapshot?: RevalidatedSnapshot;
    };

/** Snapshot y precio tras la revalidación previa al envío, si cambiaron respecto del intent. */
export interface RevalidatedSnapshot {
  selectedOffer: unknown;
  totalAmountMinor: number;
  currency: string;
}

function parseOrThrow<T>(operation: string, schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ExternalOrderIntentInputError(operation, parsed.error.issues);
  return parsed.data;
}

@Injectable()
export class ExternalOrderIntentService {
  private readonly intents: OrderCreateIntentStore;

  constructor(db: DatabaseService) {
    this.intents = new OrderCreateIntentStore(db);
  }

  /**
   * Abre el intent y lo compromete. Al volver, la fila, la referencia y la cuenta ya están
   * escritas: si el proceso muere con la reserva en vuelo, la recuperación las encuentra.
   *
   * @throws BadRequestException sin `Idempotency-Key` UUID o con una cotización ajena.
   * @throws ConflictException 409 `duplicateRequest` si la clave ya tiene una orden.
   * @throws ProviderBookingRefTakenError si la referencia ya está en uso para ese proveedor.
   */
  async openExternalCreateIntent(
    tenantId: string,
    userId: string,
    input: OpenExternalCreateIntentInput,
  ): Promise<OrderRow> {
    const requestKey = createRequestKey(undefined, input.idempotencyKey);
    const valid = parseOrThrow('openExternalCreateIntent', OpenInputSchema, input);

    try {
      return await this.intents.insert(
        tenantId,
        {
          userId,
          quotationId: valid.quotationId ?? null,
          provider: valid.provider,
          searchCriteria: { ...valid.searchCriteria, vertical: valid.vertical },
          selectedOffer: valid.selectedOffer,
          passengers: valid.passengers,
          contactInfo: valid.contactInfo,
          totalAmountMinor: valid.totalAmountMinor,
          currency: valid.currency,
          requestKey,
          ...(valid.providerBookingRef === null
            ? {}
            : { providerBookingRef: valid.providerBookingRef }),
          ...(valid.providerAccountId === null
            ? {}
            : { providerAccountId: valid.providerAccountId }),
        },
        'providerOrderId',
      );
    } catch (error) {
      if (uniqueViolationConstraint(error) === PROVIDER_BOOKING_REF_CONSTRAINT) {
        throw new ProviderBookingRefTakenError(valid.provider);
      }
      throw error;
    }
  }

  /**
   * Consolida un desenlace DEFINITIVO del proveedor sobre el intent. Sólo gana si la fila sigue
   * `pending` y sin `provider_raw`: `undefined` significa que otro camino (verificación, barrido,
   * operador) ya la cerró, y quien llama tiene que escalar en vez de pisarla.
   */
  async settleExternalCreateIntent(
    tenantId: string,
    intent: Pick<OrderRow, 'id'>,
    outcome: ExternalCreateOutcome,
  ): Promise<OrderRow | undefined> {
    const valid = parseOrThrow('settleExternalCreateIntent', SettleInputSchema, outcome);
    return this.intents.settle(tenantId, intent.id, {
      status: valid.status,
      providerOrderId: valid.providerOrderId ?? null,
      providerRaw: {
        ...valid.providerRaw,
        phase: 'create',
        outcome: valid.status === 'confirmed' ? 'CONFIRMED' : 'FAILED',
      },
      errorMessage: valid.errorMessage ?? null,
      ...(valid.snapshot === undefined
        ? {}
        : {
            selectedOffer: valid.snapshot.selectedOffer,
            totalAmountMinor: valid.snapshot.totalAmountMinor,
            currency: valid.snapshot.currency,
          }),
    });
  }

  /**
   * Fija en el intent abierto la oferta y el precio de la revalidación previa al envío. Va ANTES
   * de llamar al proveedor: si la respuesta no llega, la fila tiene que decir qué se reservó, no lo
   * que el vendedor vio antes (docs/tbo/03 §8.4: `selected_offer` es el PreBook de C2).
   *
   * @returns `false` si la fila ya no está abierta: otro camino la cerró y no hay que llamar.
   */
  async reviseExternalCreateIntent(
    tenantId: string,
    intent: Pick<OrderRow, 'id'>,
    snapshot: RevalidatedSnapshot,
  ): Promise<boolean> {
    const valid = parseOrThrow('reviseExternalCreateIntent', RevalidatedSnapshotSchema, snapshot);
    return this.intents.revise(tenantId, intent.id, {
      selectedOffer: valid.selectedOffer,
      totalAmountMinor: valid.totalAmountMinor,
      currency: valid.currency,
    });
  }

  /**
   * Devuelve a `pending` una orden ya consolidada cuya lectura de cierre contradice al proveedor
   * (no la encuentra, o la da por cancelada): no se puede seguir mostrando como confirmada. CAS
   * sobre el estado que tenía; nunca lanza, y `undefined` = otra transición ganó o la base no
   * respondió.
   */
  markExternalCreatePending(tenantId: string, order: OrderRow): Promise<OrderRow | undefined> {
    return this.intents.markPending(tenantId, order);
  }

  /**
   * Cierra el intent cuando está PROBADO que la reserva no se envió, y libera la clave. Usarlo
   * después de un envío que no respondió liberaría la clave de una reserva que puede existir.
   * Nunca lanza: `false` = la fila ya no estaba abierta o la base no respondió, y en los dos casos
   * la clave sigue bloqueando un segundo envío.
   */
  async failExternalCreateIntent(
    tenantId: string,
    intent: Pick<OrderRow, 'id' | 'create_request_key'>,
  ): Promise<boolean> {
    return this.intents.failBeforeProvider(tenantId, intent);
  }
}
