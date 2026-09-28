import { BadRequestException, ConflictException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DatabaseService } from '../database/database.service.js';
import type { DB, OrderStatus } from '../database/database.types.js';
import type { OrderRow } from './orders.service.js';

/**
 * Primitivos de persistencia del intent de creación: la fila `pending` que se compromete ANTES de
 * llamar al proveedor, su consolidación con CAS y su cierre cuando la llamada no salió.
 *
 * Viven aparte porque los usan dos sagas que no comparten tipos: la de vuelos
 * (`OrdersService.createOrder`, atada a `CreateOrderDto` y a `FlightProviderAdapter`) y la de las
 * verticales que reservan fuera de `OrdersService` (`ExternalOrderIntentService`). Si cada una
 * tuviera su copia, el lock de `order_number`, la liberación de la clave y el CAS divergirían, y
 * son justo las tres cosas que impiden reservar dos veces.
 *
 * Sin eventos: cada saga emite los suyos en el orden que le exige su proveedor.
 */

/**
 * Sentinel cerrado del intent de creación. Nunca contiene el mensaje del proveedor ni datos del
 * pasajero; además permite que el UPDATE final haga CAS usando el schema actual, sin una columna
 * nueva de versión.
 */
export const CREATE_PENDING_RECONCILIATION_MARKER =
  'Creación pendiente de conciliación con el proveedor. No reenviar la reserva.';
export const CREATE_NOT_SENT_MARKER = 'La creación no se envió al proveedor.';

const CREATE_REQUEST_KEY_CONSTRAINT = 'uq_orders_create_request_key';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Índice que produjo un 23505, o `undefined` si el error no es una violación de unicidad. */
export function uniqueViolationConstraint(error: unknown): string | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const constraint =
    typeof error === 'object' && error !== null && 'constraint' in error
      ? (error as { constraint?: unknown }).constraint
      : undefined;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * `q:<quotation>` o `c:<Idempotency-Key>`. Sin ninguna de las dos no hay forma de reconocer el
 * segundo envío del mismo formulario, así que se rechaza antes de tocar la base o el proveedor.
 */
export function createRequestKey(
  quotationId: string | undefined,
  clientRequestId: string | undefined,
): string {
  if (quotationId !== undefined) return `q:${quotationId.toLowerCase()}`;
  const normalized = clientRequestId?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    throw new BadRequestException(
      'Se requiere Idempotency-Key UUID cuando la reserva no proviene de una cotización.',
    );
  }
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException('Idempotency-Key debe ser un UUID válido.');
  }
  return `c:${normalized}`;
}

/** Lo que decide cada saga al abrir el intent. El resto (estado, número, marcador) es fijo. */
export interface CreateIntentValues {
  userId: string;
  quotationId: string | null;
  provider: string;
  searchCriteria: unknown;
  selectedOffer: unknown;
  passengers: unknown;
  contactInfo: unknown;
  /** Precio final al cliente, en unidades menores. */
  totalAmountMinor: number;
  currency: string;
  requestKey: string;
  /** Referencia que mandamos al proveedor. Va en el MISMO INSERT: es la llave de recuperación. */
  providerBookingRef?: string;
  providerAccountId?: string;
  /**
   * `provider_accounts.updated_at` (ISO 8601) de la cuenta con la que la saga va a reservar. Con
   * él, el intent sólo se compromete si la cuenta sigue siendo ésa: ver `ProviderAccountChangedError`.
   */
  providerAccountVersion?: string;
}

/**
 * La cuenta con la que se iba a reservar cambió (se desactivó, dejó de heredarse, se rotó o se
 * apuntó a otra cuenta del proveedor) entre que la saga la resolvió y el intent se comprometió. El
 * intent no se guarda y nada sale al proveedor: reservar con la credencial vieja dejaría una reserva
 * que la cuenta nueva no puede leer ni cancelar (RF-29).
 */
export class ProviderAccountChangedError extends ConflictException {
  readonly reason = 'PROVIDER_ACCOUNT_CHANGED';

  constructor() {
    super(
      'La cuenta del proveedor cambió mientras se abría la reserva. Volvé a buscar para reservar con la cuenta vigente.',
    );
    this.name = 'ProviderAccountChangedError';
  }
}

function epochOf(value: Date | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(epoch) ? undefined : epoch;
}

/**
 * Cómo se llama el localizador del proveedor en el 409 de una clave repetida. Vuelos lo publica
 * como `pnr` desde antes de que existieran otras verticales; para un hotel no es un PNR.
 */
export type DuplicateLocatorKey = 'pnr' | 'providerOrderId';

/** Estados con los que puede cerrarse un intent. Nunca `ticketed`: la emisión es post-venta. */
export type CreateIntentSettledStatus = Exclude<OrderStatus, 'ticketed'>;

export interface CreateIntentSettlement {
  status: CreateIntentSettledStatus;
  providerOrderId: string | null;
  /**
   * Lista BLANCA armada por quien llama. Nunca un volcado: la respuesta cruda de una creación
   * arrastra el eco de lo que mandamos, con la PII de los viajeros, y se guarda para siempre.
   */
  providerRaw: Record<string, unknown>;
  errorMessage: string | null;
  /** Snapshot revalidado; si no viene, se conserva el del intent. */
  selectedOffer?: unknown;
  searchCriteria?: unknown;
  totalAmountMinor?: number;
  currency?: string;
}

/**
 * La cuenta de la orden recién insertada sigue activa, en la red del tenant y en la versión con la
 * que la saga la resolvió (`resolve_order_provider_account`, 0045). Va DESPUÉS del INSERT a
 * propósito: la FK ya tomó FOR KEY SHARE sobre la fila de la cuenta, que choca con el FOR UPDATE de
 * `ProviderCredentialsService.upsert`. Un cambio en curso ya se comprometió y esta lectura lo ve; uno
 * nuevo espera a que la orden se comprometa, y la cuenta en su conteo de reservas activas.
 *
 * @throws ProviderAccountChangedError y la transacción del intent se deshace entera.
 */
async function assertAccountStillCurrent(
  trx: Transaction<DB>,
  orderId: string,
  version: string,
): Promise<void> {
  const result = await sql<{ updated_at: Date | string | null }>`
    SELECT updated_at FROM resolve_order_provider_account(${orderId}::uuid)
  `.execute(trx);
  // Sin cuenta que resolver, la función devuelve una fila de nulos, no cero filas.
  const current = epochOf(result.rows[0]?.updated_at);
  if (current === undefined || current !== epochOf(version)) {
    throw new ProviderAccountChangedError();
  }
}

export class OrderCreateIntentStore {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Inserta y compromete el intent `pending` antes de tocar el proveedor. Una clave repetida
   * termina en 409 `duplicateRequest` con la orden existente; cualquier otra violación de
   * unicidad sale tal cual, porque no es un segundo envío sino otra cosa.
   */
  async insert(
    tenantId: string,
    values: CreateIntentValues,
    locatorKey: DuplicateLocatorKey,
  ): Promise<OrderRow> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.insertOnce(tenantId, values);
      } catch (error) {
        if (uniqueViolationConstraint(error) !== CREATE_REQUEST_KEY_CONSTRAINT) throw error;

        const existing = await this.findByRequestKey(tenantId, values.requestKey);
        if (existing !== undefined) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message:
              'Esta solicitud de creación ya fue recibida. No vuelvas a reservar; usa la orden existente.',
            orderId: existing.id,
            ...(existing.provider_order_id === null
              ? {}
              : { [locatorKey]: existing.provider_order_id }),
            duplicateRequest: true,
            retryForbidden: true,
            reconciliationRequired: true,
          });
        }

        // El primer request pudo liberar la clave al cerrar FAILED entre el 23505 y esta lectura.
        // Sólo se repite el INSERT; nunca la llamada al proveedor.
        if (attempt === 0) continue;
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'No se pudo adquirir de forma segura la clave de creación.',
          duplicateRequest: true,
          retryForbidden: true,
          reconciliationRequired: true,
        });
      }
    }
    throw new ConflictException('No se pudo adquirir la clave de creación.');
  }

  private async insertOnce(tenantId: string, values: CreateIntentValues): Promise<OrderRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      // Lock real por tenant: dos transacciones no pueden observar el mismo MAX(order_number).
      await trx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (values.quotationId !== null) {
        const quotation = await trx
          .selectFrom('quotations')
          .select('id')
          .where('id', '=', values.quotationId)
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();
        if (quotation === undefined) {
          throw new BadRequestException('La cotización no pertenece a la agencia activa.');
        }
      }

      const nextNumber = await trx
        .selectFrom('orders')
        .select(sql<number>`COALESCE(MAX(order_number), 0) + 1`.as('next'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();

      const row = await trx
        .insertInto('orders')
        .values({
          tenant_id: tenantId,
          user_id: values.userId,
          quotation_id: values.quotationId,
          provider: values.provider,
          provider_order_id: null,
          status: 'pending',
          search_criteria: JSON.stringify(values.searchCriteria),
          selected_offer: JSON.stringify(values.selectedOffer),
          passengers: JSON.stringify(values.passengers),
          contact_info: JSON.stringify(values.contactInfo),
          total_amount: values.totalAmountMinor,
          currency: values.currency,
          order_number: nextNumber.next,
          provider_raw: null,
          error_message: CREATE_PENDING_RECONCILIATION_MARKER,
          create_request_key: values.requestKey,
          ...(values.providerBookingRef === undefined
            ? {}
            : { provider_booking_ref: values.providerBookingRef }),
          ...(values.providerAccountId === undefined
            ? {}
            : { provider_account_id: values.providerAccountId }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (values.providerAccountId !== undefined && values.providerAccountVersion !== undefined) {
        await assertAccountStillCurrent(trx, row.id, values.providerAccountVersion);
      }

      return row as unknown as OrderRow;
    });
  }

  async findByRequestKey(tenantId: string, requestKey: string): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('orders')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('create_request_key', '=', requestKey)
        .executeTakeFirst();
      return row as unknown as OrderRow | undefined;
    });
  }

  /**
   * Consolida el resultado sobre la MISMA fila. `provider_raw IS NULL` es el CAS compatible con
   * el schema vigente: todo resultado cerrado escribe una lista blanca no nula, incluso FAILED.
   * `undefined` = otro camino (verificación, barrido, operador) ya la cerró.
   */
  async settle(
    tenantId: string,
    intentId: string,
    settlement: CreateIntentSettlement,
  ): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('orders')
        .set({
          provider_order_id: settlement.providerOrderId,
          status: settlement.status,
          ...(settlement.selectedOffer === undefined
            ? {}
            : { selected_offer: JSON.stringify(settlement.selectedOffer) }),
          ...(settlement.searchCriteria === undefined
            ? {}
            : { search_criteria: JSON.stringify(settlement.searchCriteria) }),
          ...(settlement.totalAmountMinor === undefined
            ? {}
            : { total_amount: settlement.totalAmountMinor }),
          ...(settlement.currency === undefined ? {} : { currency: settlement.currency }),
          provider_raw: JSON.stringify(settlement.providerRaw),
          error_message: settlement.errorMessage,
          // Sólo un "no reservé nada" del proveedor libera la clave. Cualquier otro cierre la
          // conserva: el mismo formulario reenviado tiene que ver la orden, no crear otra.
          ...(settlement.status === 'failed' ? { create_request_key: null } : {}),
        })
        .where('id', '=', intentId)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .where('provider_raw', 'is', null)
        .returningAll()
        .executeTakeFirst();

      return row as unknown as OrderRow | undefined;
    });
  }

  /**
   * Reemplaza la oferta y el precio de un intent que sigue abierto, ANTES de llamar al proveedor:
   * la revalidación previa al envío puede fijar otra tarifa (políticas finales, precio que bajó), y
   * la fila tiene que decir lo que se va a reservar si la respuesta no llega. Mismo CAS que
   * {@link settle}: `false` = otro camino ya la cerró, y entonces no se llama al proveedor.
   */
  async revise(
    tenantId: string,
    intentId: string,
    values: { selectedOffer: unknown; totalAmountMinor: number; currency: string },
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .updateTable('orders')
        .set({
          selected_offer: JSON.stringify(values.selectedOffer),
          total_amount: values.totalAmountMinor,
          currency: values.currency,
        })
        .where('id', '=', intentId)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .where('provider_raw', 'is', null)
        .execute();
      return rows.some(resultChangedRows);
    });
  }

  /**
   * Cierre de un intent cuya llamada NO salió: libera la clave para que el vendedor reintente.
   * Nunca lanza. Si la base cayó, el intent conserva la clave y bloquea un segundo envío, que es
   * el lado seguro. `false` = la fila ya no estaba abierta o no se pudo escribir.
   */
  async failBeforeProvider(
    tenantId: string,
    intent: Pick<OrderRow, 'id' | 'create_request_key'>,
  ): Promise<boolean> {
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const rows = await trx
          .updateTable('orders')
          .set({
            status: 'failed',
            provider_raw: JSON.stringify({ phase: 'pre-create', outcome: 'FAILED' }),
            error_message: CREATE_NOT_SENT_MARKER,
            create_request_key: null,
          })
          .where('id', '=', intent.id)
          .where('tenant_id', '=', tenantId)
          .where('status', '=', 'pending')
          .where('provider_raw', 'is', null)
          .where('create_request_key', '=', intent.create_request_key)
          .execute();
        return rows.some(resultChangedRows);
      });
    } catch {
      return false;
    }
  }

  /** Baja el estado a pending sin pisar una transición concurrente; todos los fallos son seguros. */
  async markPending(tenantId: string, order: OrderRow): Promise<OrderRow | undefined> {
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const row = await trx
          .updateTable('orders')
          .set({
            status: 'pending',
            error_message: CREATE_PENDING_RECONCILIATION_MARKER,
          })
          .where('id', '=', order.id)
          .where('tenant_id', '=', tenantId)
          .where('status', '=', order.status)
          .returningAll()
          .executeTakeFirst();
        return row as unknown as OrderRow | undefined;
      });
    } catch {
      return undefined;
    }
  }
}

/**
 * Kysely devuelve `{ numUpdatedRows: bigint }` por sentencia, también cuando no tocó ninguna fila.
 * Los dobles de los tests de vuelos devuelven `[]` o `[{}]`: sin el campo, cuenta como cambio.
 */
function resultChangedRows(result: unknown): boolean {
  const changed = (result as { numUpdatedRows?: unknown } | null)?.numUpdatedRows;
  return typeof changed === 'bigint' ? changed > 0n : true;
}
