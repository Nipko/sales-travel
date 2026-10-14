import { describe, expect, it, vi } from 'vitest';
import { PostgresQueryCompiler, type CompiledQuery, type RootOperationNode } from 'kysely';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Offer, SeatMap } from '@sales-travel/canonical';
import {
  OrderCreateNotSentError,
  type OrderCancelResult,
  type OrderCreateRequest,
  type OrderCreateResult,
  type OrderView,
  type Passenger,
  type SearchContext,
} from '@sales-travel/domain';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type {
  CallPolicy,
  FlightProviderAdapter,
  OrderCancelAudit,
  OrderCancelScope,
  OrderCreateAudit,
  ProviderCapabilities,
  ProviderFlagsPort,
  ProviderVertical,
  TenantAdapter,
  TenantProviderFactory,
} from '../providers/provider.types.js';
import {
  ProviderDisabledByPlatformError,
  ProviderOrderAccountUnavailableError,
  SeatSelectionNotAvailableError,
} from '../providers/provider.types.js';
import type { ProviderEnvironment } from '../providers/provider-environment.js';
import { apagadoPara, providerFlags } from '../providers/__fixtures__/provider-flags.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import type {
  FlightDocumentChanges,
  FlightOrderRead,
  FlightOrderTrackingStore,
} from './flight-order-tracking.store.js';
import { ProviderAccountChangedError } from './order-create-intent.store.js';
import { ORDER_EVENTS } from './order-events.js';
import { OrdersService, type CreateOrderDto, type OrderRow } from './orders.service.js';
import { runPostSaleJob, type PostSaleJobHandlers } from './post-sale.worker.js';

/**
 * EL SAGA DE CREACIÓN, por la puerta pública (`OrdersService.createOrder`).
 *
 * Todo entra por el servicio; ningún test llama a una función interna. Es la regla 1 de este
 * paquete y no es ceremonia: la avería que se repitió cinco veces fue código correcto que
 * producción no ejecutaba, y un test que llama a `decideAfterVerify` a mano no demuestra que el
 * servicio la llame.
 *
 * Lo que se fija aquí:
 *
 *  1. toda creación se CIERRA verificando (criterio de salida de la fase);
 *  2. lo que no se pudo verificar NO se persiste como confirmado;
 *  3. el éxito parcial encola una compensación SELECTIVA, con los ítems dentro, **y sólo cuando
 *     se cayó algo de lo que la compra depende**: un accesorio fuera conserva la reserva y escala;
 *  4. cada operación con dinero deja un `domain_event` con actor, tenant y la
 *     `errorHandlingPolicy` con la que se pidió (RNF-08);
 *  5. `orders.provider_raw` se llena SIN PII;
 *  6. una cancelación que el proveedor no verificó NO se reintenta.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROVEEDOR = 'saga-air';
const PNR = 'ABC123';
const QUOTATION_ID = '33333333-3333-4333-8333-333333333333';
/** Documento del pasajero: el proveedor lo devuelve en `fieldValue` tal cual se lo mandamos. */
const DOCUMENTO = 'AB1234567';
const PRICING_SIN_REGLAS = {
  getApplicableRules: () => Promise.resolve([]),
} as unknown as PricingService;

const PASAJERO_ADULTO: Passenger = {
  paxId: 'P1',
  paxType: 'ADT',
  title: 'Mr',
  givenName: 'Juan',
  surname: 'Pérez',
  birthdate: '1990-01-01',
  gender: 'M',
  citizenshipCountryCode: 'CO',
  identityDoc: {
    type: 'CC',
    number: DOCUMENTO,
    issuingCountryCode: 'CO',
  },
};

// ---------------------------------------------------------------------------------------------
// Dobles
// ---------------------------------------------------------------------------------------------

interface AdapterOptions {
  readonly created?: OrderCreateResult;
  readonly createThrows?: Error;
  readonly view?: OrderView;
  readonly viewThrows?: Error;
  /** `undefined` ⇒ el adapter NO implementa el puerto auditado. */
  readonly createAudit?: Record<string, unknown>;
  readonly cancelAudit?: Omit<OrderCancelAudit, 'result'>;
  readonly cancelResult?: OrderCancelResult;
  readonly cancelThrows?: Error;
  /** Con un mapa, el adapter implementa `SeatMapPort` (SAB-16); sin él, no sabe pintarlo. */
  readonly seatMap?: SeatMap;
  /** La oferta que devuelve la revalidación. Por defecto, la misma que entra. */
  readonly revalidated?: (offer: Offer) => Offer;
}

/**
 * Adapter de vuelos con lo justo para el saga, y con los puertos auditados **opcionales**: es lo
 * que permite probar las dos ramas —proveedor que audita y proveedor que no— sin tocar el stub
 * compartido, que otros tests usan esperando que NO audite.
 */
class SagaAdapter implements FlightProviderAdapter {
  readonly isMock = false;
  readonly createOrder = vi.fn((_r: OrderCreateRequest, _c: SearchContext) =>
    this.opts.createThrows ? Promise.reject(this.opts.createThrows) : Promise.resolve(this.created),
  );
  readonly retrieveForDisplay = vi.fn((_id: string, _c: SearchContext) =>
    this.opts.viewThrows
      ? Promise.reject(this.opts.viewThrows)
      : Promise.resolve(this.opts.view ?? vistaViva()),
  );
  readonly cancelOrder = vi.fn((_id: string, _c: SearchContext) =>
    this.opts.cancelThrows
      ? Promise.reject(this.opts.cancelThrows)
      : Promise.resolve(this.opts.cancelResult ?? { success: true, warnings: [] }),
  );
  readonly cancelOrderAudited?: (
    orderId: string,
    ctx: SearchContext,
    scope?: OrderCancelScope,
  ) => Promise<OrderCancelAudit>;
  readonly createOrderAudited?: (
    request: OrderCreateRequest,
    ctx: SearchContext,
  ) => Promise<OrderCreateAudit>;
  readonly getSeatMap?: (
    offer: Offer,
    criteria: CreateOrderDto['searchCriteria'],
    ctx: SearchContext,
  ) => Promise<SeatMap>;
  /** Los ámbitos con los que se pidió cancelar, en orden. */
  readonly cancelScopes: (OrderCancelScope | undefined)[] = [];

  constructor(private readonly opts: AdapterOptions = {}) {
    const seatMap = opts.seatMap;
    if (seatMap !== undefined) this.getSeatMap = vi.fn(() => Promise.resolve(seatMap));
    if (opts.createAudit !== undefined) {
      this.createOrderAudited = vi.fn((request: OrderCreateRequest, ctx: SearchContext) =>
        this.createOrder(request, ctx).then((result) => ({
          result,
          audit: opts.createAudit as Record<string, unknown>,
          providerRaw: { provider: PROVEEDOR, audited: true, pnr: result.pnr },
          hasVersionStamp: false,
        })),
      );
    }
    if (opts.cancelAudit !== undefined) {
      this.cancelOrderAudited = vi.fn(
        (orderId: string, ctx: SearchContext, scope?: OrderCancelScope) => {
          this.cancelScopes.push(scope);
          return this.cancelOrder(orderId, ctx).then((result) => ({
            result,
            ...(opts.cancelAudit as Omit<OrderCancelAudit, 'result'>),
          }));
        },
      );
    }
  }

  private get created(): OrderCreateResult {
    return this.opts.created ?? confirmado();
  }

  // El resto del puerto no participa del saga de creación; existir con un rechazo explícito es
  // mejor que no existir: `undefined is not a function` sale como 500 genérico.
  priceOffer = vi.fn((offer: Offer) =>
    Promise.resolve({
      offer: this.opts.revalidated === undefined ? offer : this.opts.revalidated(offer),
      priceChanged: false,
      warnings: [],
    }),
  );
  cancelBnplOrder = vi.fn(() => Promise.reject(new Error('no usado en estos tests')));
  payOrder = vi.fn(() => Promise.reject(new Error('no usado en estos tests')));
  listServices = vi.fn(() => Promise.reject(new Error('no usado en estos tests')));
  reshopWithTickets = vi.fn(() => Promise.reject(new Error('no usado en estos tests')));
  search = vi.fn(() => Promise.resolve([] as Offer[]));
}

class SagaFactory implements TenantProviderFactory<FlightProviderAdapter> {
  readonly code = PROVEEDOR;
  readonly vertical: ProviderVertical = 'flights';
  readonly defaultCallPolicy: CallPolicy = 'always';
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly adapter: SagaAdapter,
    capabilities: Partial<ProviderCapabilities> = {},
    private readonly environment?: ProviderEnvironment,
  ) {
    this.capabilities = {
      retrieve: true,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
      ...capabilities,
    };
  }

  forTenant(): Promise<FlightProviderAdapter> {
    return Promise.resolve(this.adapter);
  }

  resolveForTenant(): Promise<TenantAdapter<FlightProviderAdapter>> {
    return Promise.resolve({
      adapter: this.adapter,
      credentialSource: 'own',
      ...(this.environment === undefined ? {} : { providerEnvironment: this.environment }),
    });
  }

  humanizeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

interface FakeDbOptions {
  failOperationInsert?: boolean;
  failOperationCompletion?: boolean;
  failOrderFinalize?: boolean;
  failCreateIntentInsert?: boolean;
  failCreateIntentSettlement?: boolean;
  /**
   * Cuentas de proveedor que `resolve_order_provider_account` (0045) resuelve para la orden que las
   * guarda, con su versión (`updated_at`, ISO). La que no está aquí no se resuelve.
   */
  providerAccounts?: Readonly<Record<string, string>>;
}

/** Doble de la base: guarda por tabla y aplica los UPDATE, que es lo que el saga mira. */
function dbFalsa(
  semilla?: Record<string, unknown>,
  options: FakeDbOptions = {},
): {
  db: DatabaseService;
  fila: () => Record<string, unknown> | undefined;
  operaciones: () => Record<string, unknown>[];
  /** SQL crudo que se ejecutó, por función. */
  consultas: () => readonly string[];
} {
  const orders = new Map<string, unknown>(Object.entries(semilla ?? {}));
  const operaciones: Record<string, unknown>[] = [];

  const filaOrden = (): Record<string, unknown> => ({
    id: 'order-1',
    tenant_id: TENANT,
    provider: PROVEEDOR,
    order_number: 1,
    ...Object.fromEntries(orders),
  });

  const insertEn = (tabla: string) => {
    let operationValue: Record<string, unknown> | undefined;
    const performInsert = (): Record<string, unknown> => {
      if (tabla !== 'order_operations') {
        if (options.failCreateIntentInsert) {
          throw new Error('orders no disponible al crear el intent');
        }
        return filaOrden();
      }
      if (options.failOperationInsert) {
        throw new Error('order_operations no disponible');
      }
      if (
        operationValue?.['type'] === 'cancel' &&
        operationValue['status'] === 'pending' &&
        operaciones.some(
          (operation) =>
            operation['order_id'] === operationValue?.['order_id'] &&
            operation['type'] === 'cancel' &&
            operation['status'] === 'pending',
        )
      ) {
        // Como `pg`: el 23505 dice qué índice lo produjo, y el servicio decide por ese nombre.
        throw Object.assign(new Error('duplicate pending cancel'), {
          code: '23505',
          constraint: 'uq_order_operations_pending_cancel',
        });
      }
      if (!operationValue) throw new Error('insert sin values');
      operaciones.push(operationValue);
      return operationValue;
    };
    const insert = {
      values: (v: Record<string, unknown>) => {
        if (tabla === 'orders') for (const [k, val] of Object.entries(v)) orders.set(k, val);
        else
          operationValue = {
            id: `op-${operaciones.length + 1}`,
            attempts: 1,
            created_at: new Date(1_700_000_000_000 + operaciones.length),
            ...v,
          };
        return insert;
      },
      returning: () => insert,
      returningAll: () => insert,
      execute: () => Promise.resolve([performInsert()]),
      executeTakeFirst: () => Promise.resolve(performInsert()),
      executeTakeFirstOrThrow: () => Promise.resolve(performInsert()),
    };
    return insert;
  };
  const selectEn = (tabla: string) => {
    const filtros: [string, unknown][] = [];
    let descendente = false;
    const filas = (): Record<string, unknown>[] => {
      const base =
        tabla === 'order_operations'
          ? operaciones
          : tabla === 'quotations'
            ? [{ id: QUOTATION_ID, tenant_id: TENANT }]
            : tabla === 'tenants'
              ? [{ id: TENANT }]
              : orders.size === 0
                ? []
                : [filaOrden()];
      const coinciden = base.filter((fila) =>
        filtros.every(([campo, valor]) => fila[campo] === valor),
      );
      return descendente ? [...coinciden].reverse() : coinciden;
    };
    const select = {
      select: () => select,
      selectAll: () => select,
      where: (campo: string, _op: string, valor: unknown) => {
        filtros.push([campo, valor]);
        return select;
      },
      forUpdate: () => select,
      orderBy: (_campo: string, direccion?: string) => {
        descendente = direccion === 'desc';
        return select;
      },
      limit: () => select,
      execute: () => Promise.resolve(filas()),
      executeTakeFirst: () => Promise.resolve(filas()[0]),
      executeTakeFirstOrThrow: () => Promise.resolve(filas()[0] ?? { next: 1 }),
    };
    return select;
  };
  const updateEn = (tabla: string) => {
    let values: Record<string, unknown> = {};
    const filtros: [string, unknown][] = [];
    const apply = (): Record<string, unknown> | undefined => {
      if (tabla === 'orders') {
        const current = filaOrden();
        if (!filtros.every(([field, value]) => current[field] === value)) return undefined;
        if (
          options.failCreateIntentSettlement &&
          current['provider_raw'] === null &&
          typeof values['provider_raw'] === 'string'
        ) {
          throw new Error('orders no disponible al consolidar el create');
        }
        if (options.failOrderFinalize && values['status'] !== 'pending') {
          throw new Error('orders no disponible al finalizar');
        }
        for (const [key, value] of Object.entries(values)) orders.set(key, value);
        return filaOrden();
      }
      const operation = operaciones.find((row) =>
        filtros.every(([field, value]) => row[field] === value),
      );
      if (!operation) return undefined;
      if (
        options.failOperationCompletion &&
        operation['status'] === 'pending' &&
        (values['status'] === 'success' || values['status'] === 'failed')
      ) {
        throw new Error('order_operations no disponible al completar');
      }
      Object.assign(operation, values);
      return operation;
    };
    const update = {
      set: (next: Record<string, unknown>) => {
        values = next;
        return update;
      },
      where: (field: string, _op: string, value: unknown) => {
        filtros.push([field, value]);
        return update;
      },
      returning: () => update,
      returningAll: () => update,
      execute: () => Promise.resolve(apply() ? [{}] : []),
      executeTakeFirst: () => Promise.resolve(apply()),
    };
    return update;
  };
  // Lo único que el saga ejecuta como SQL crudo: la versión de la cuenta que el intent guardó.
  const compiler = new PostgresQueryCompiler();
  const consultas: string[] = [];
  const executor = {
    transformQuery: (node: RootOperationNode) => node,
    compileQuery: (node: RootOperationNode) => compiler.compileQuery(node),
    withPlugins: () => executor,
    executeQuery: (compiled: CompiledQuery) => {
      if (!compiled.sql.includes('resolve_order_provider_account')) {
        return Promise.reject(new Error(`SQL crudo inesperado: ${compiled.sql}`));
      }
      consultas.push('resolve_order_provider_account');
      const cuenta = filaOrden()['provider_account_id'];
      const version =
        typeof cuenta === 'string' ? (options.providerAccounts ?? {})[cuenta] : undefined;
      // Como la función de Postgres: sin cuenta que resolver, una fila de nulos.
      return Promise.resolve({
        rows: [{ updated_at: version === undefined ? null : new Date(version) }],
      });
    },
  };
  const trx = {
    selectFrom: (tabla: string) => selectEn(tabla),
    insertInto: (tabla: string) => insertEn(tabla),
    updateTable: (tabla: string) => updateEn(tabla),
    getExecutor: () => executor,
  };

  const db = {
    withTenant: async <T>(_t: string, cb: (trx: unknown) => Promise<T>): Promise<T> => {
      const orderSnapshot = new Map(orders);
      const operationSnapshot = operaciones.map((operation) => ({ ...operation }));
      try {
        return await cb(trx);
      } catch (error) {
        orders.clear();
        for (const [key, value] of orderSnapshot) orders.set(key, value);
        operaciones.splice(0, operaciones.length, ...operationSnapshot);
        throw error;
      }
    },
  } as unknown as DatabaseService;

  return {
    db,
    fila: () => (orders.size === 0 ? undefined : filaOrden()),
    operaciones: () => operaciones,
    consultas: () => consultas,
  };
}

interface Banco {
  orders: OrdersService;
  adapter: SagaAdapter;
  audit: RecordingAuditService;
  queue: RecordingQueueService;
  fila: () => Record<string, unknown> | undefined;
  operaciones: () => Record<string, unknown>[];
}

function banco(
  opts: AdapterOptions = {},
  caps: Partial<ProviderCapabilities> = {},
  semilla?: Record<string, unknown>,
  dbOptions: FakeDbOptions = {},
  flags: ProviderFlagsPort = { decisionFor: () => Promise.resolve(undefined) },
  holds?: BookingHoldLedger,
  flightTracking?: FlightOrderTrackingStore,
): Banco {
  const adapter = new SagaAdapter(opts);
  const registry = new FlightProviderRegistry([new SagaFactory(adapter, caps)], flags);
  const { db, fila, operaciones } = dbFalsa(semilla, dbOptions);
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService();

  return {
    orders: new OrdersService(
      db,
      registry,
      queue.asService(),
      {} as unknown as AgentCarsProviderFactory,
      audit.asService(),
      PRICING_SIN_REGLAS,
      undefined,
      undefined,
      holds,
      flightTracking,
    ),
    adapter,
    audit,
    queue,
    fila,
    operaciones,
  };
}

// ---------------------------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------------------------

function oferta(): Offer {
  return {
    id: `${PROVEEDOR}-offer`,
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: PROVEEDOR, offerRef: `${PROVEEDOR}-REF` },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    itineraries: [
      {
        segments: [
          {
            carrier: 'AV',
            flightNumber: '123',
            origin: 'BOG',
            destination: 'LIM',
            departureAt: '2026-09-10T09:00:00-05:00',
            arrivalAt: '2026-09-10T12:00:00-05:00',
            durationMinutes: 180,
            cabin: 'economy',
            bookingClass: 'Y',
          },
        ],
        totalDurationMinutes: 180,
        stops: 0,
      },
    ],
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2099-08-26T12:30:00.000Z',
  };
}

function dto(): CreateOrderDto {
  return {
    offer: oferta(),
    searchCriteria: {
      origin: 'BOG',
      destination: 'LIM',
      departureDate: '2026-09-10',
      paxCount: { adults: 1, children: 0, infants: 0 },
      cabin: 'economy',
      currency: 'USD',
    },
    passengers: [PASAJERO_ADULTO],
    contactInfo: { email: 'pasajero@ejemplo.test', phone: '+573000000000' },
    quotationId: QUOTATION_ID,
  };
}

function confirmado(): OrderCreateResult {
  return {
    outcome: 'CONFIRMED',
    pnr: PNR,
    items: [{ kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' }],
    issues: [],
  };
}

/**
 * El parcial que originó la regla: el VUELO dentro, el ASIENTO fuera.
 *
 * El proveedor declara el vuelo como cancelable —es verdad, se puede— y encima le da un
 * `providerItemId` al asiento, que el ACL de Sabre no le daría nunca. Las dos cosas son a
 * propósito: la reserva se conserva porque lo que se cayó es un accesorio, no porque no hubiera
 * nada que cancelar. Si la protección dependiera de que la lista llegue vacía, este caso la
 * atravesaría.
 */
function parcial(): OrderCreateResult {
  return {
    outcome: 'PARTIAL',
    pnr: PNR,
    items: [
      { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
      { kind: 'seat', providerItemId: '13', status: 'FAILED', statusCode: 'UC' },
    ],
    issues: [
      {
        severity: 'ERROR',
        category: 'APPLICATION_ERROR',
        type: 'SEAT_NOT_AVAILABLE',
        message: 'The requested seat is no longer available',
        fieldName: 'documentNumber',
        fieldValue: DOCUMENTO,
        // El ACL lo atribuye al asiento: es lo que deja cerrar «el vuelo sí, el asiento no».
        itemKind: 'seat',
      },
    ],
    compensation: { cancellableItemIds: ['12'] },
  };
}

/** Un extra (no un asiento) caído con el vuelo dentro: la reserva se conserva y escala. */
function extraCaido(): OrderCreateResult {
  return {
    ...parcial(),
    items: [
      { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
      { kind: 'ancillary', providerItemId: '13', status: 'FAILED', statusCode: 'UC' },
    ],
  };
}

/**
 * El parcial que SÍ compensa: un tramo dentro y el otro caído.
 *
 * Un vuelo es de lo que la compra DEPENDE. Con la ida confirmada y la vuelta denegada, el cliente
 * se queda tirado a mitad de camino: aquí sí hay que deshacer lo que quedó vivo.
 */
function vueloCaido(): OrderCreateResult {
  return {
    outcome: 'PARTIAL',
    pnr: PNR,
    items: [
      { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
      { kind: 'flight', providerItemId: '14', status: 'FAILED', statusCode: 'UC' },
    ],
    issues: [
      {
        severity: 'ERROR',
        category: 'APPLICATION_ERROR',
        type: 'FLIGHT_NOT_AVAILABLE',
        message: 'The requested flight is no longer available',
        fieldName: 'documentNumber',
        fieldValue: DOCUMENTO,
      },
    ],
    compensation: { cancellableItemIds: ['12'] },
  };
}

function vistaViva(): OrderView {
  return { found: true, pnr: PNR, status: 'ACTIVE', airlineLocators: [], warnings: [] };
}

/** La política que un proveedor auditado publica; es lo que el `domain_event` tiene que citar. */
const AUDITORIA_DE_CREACION = {
  audited: true,
  errorHandlingPolicy: ['HALT_ON_ERROR'],
  asynchronousUpdateWaitTimeMs: 7000,
  advisories: [],
};

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('saga de creación — intent durable antes del proveedor', () => {
  it('compromete pending antes del write y usa el id como correlación', async () => {
    const b = banco();
    let release!: (result: OrderCreateResult) => void;
    const providerGate = new Promise<OrderCreateResult>((resolve) => {
      release = resolve;
    });
    b.adapter.createOrder.mockImplementation(() => providerGate);

    const create = b.orders.createOrder(TENANT, USER, dto());
    await vi.waitFor(() => expect(b.adapter.createOrder).toHaveBeenCalledTimes(1));

    expect(b.fila()).toMatchObject({
      id: 'order-1',
      status: 'pending',
      provider_order_id: null,
      provider_raw: null,
      error_message: 'Creación pendiente de conciliación con el proveedor. No reenviar la reserva.',
    });
    expect(b.adapter.createOrder).toHaveBeenCalledWith(expect.any(Object), {
      tenantId: TENANT,
      requestId: 'order-1',
    });
    expect(b.audit.first(ORDER_EVENTS.createRequested)?.aggregateId).toBe('order-1');

    release(confirmado());
    await expect(create).resolves.toMatchObject({ order: { id: 'order-1' } });
  });

  it('si el INSERT del intent falla, createOrder del proveedor no se ejecuta', async () => {
    const b = banco({}, {}, undefined, { failCreateIntentInsert: true });

    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toThrow(
      /intent|orders no disponible/i,
    );

    expect(b.adapter.createOrder).not.toHaveBeenCalled();
    expect(b.fila()).toBeUndefined();
  });

  it('una excepción externa conserva pending y devuelve un conflicto estructurado sin texto raw', async () => {
    const leaked = new Error(`timeout para documento ${DOCUMENTO}`);
    leaked.name = 'ProviderTimeoutError';
    const b = banco({ createThrows: leaked });

    let thrown: unknown;
    try {
      await b.orders.createOrder(TENANT, USER, dto());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    const response = (thrown as ConflictException).getResponse();
    expect(response).toMatchObject({
      orderId: 'order-1',
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(JSON.stringify(response)).not.toContain(DOCUMENTO);
    expect(b.fila()).toMatchObject({
      status: 'pending',
      provider_order_id: null,
      provider_raw: null,
      error_message: 'Creación pendiente de conciliación con el proveedor. No reenviar la reserva.',
    });
    expect(b.audit.first(ORDER_EVENTS.createFailed)?.aggregateId).toBe('order-1');
    expect(b.audit.dump()).not.toContain(DOCUMENTO);
  });

  it('un rechazo ANTES de la red libera la cotización y dice qué campo corregir', async () => {
    // El builder rechazó el nombre sin llamar a nadie: no hay reserva que conciliar. Antes esto
    // salía como «No vuelvas a reservar» y la cotización quedaba bloqueada para siempre.
    const b = banco({
      createThrows: new OrderCreateNotSentError(
        'la reserva no cumple el contrato de Sabre (travelers.0.givenName:invalid_string)',
      ),
    });

    let thrown: unknown;
    try {
      await b.orders.createOrder(TENANT, USER, dto());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    const response = (thrown as BadRequestException).getResponse();
    expect(response).toMatchObject({ retryForbidden: false });
    expect(JSON.stringify(response)).toContain('pasajero 1: nombre');
    expect(JSON.stringify(response)).not.toContain('reconciliationRequired');
    expect(b.fila()).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.audit.first(ORDER_EVENTS.createFailed)?.payload).toMatchObject({
      uncertain: false,
      reason: 'rejected-before-send',
    });
  });

  it('una llamada cortada antes de salir (`sentToProvider: false`) libera la cotización', async () => {
    // El cupo de concurrencia de la cuenta seguía lleno cuando venció la espera: el proveedor no
    // recibió nada. Escalarla como incierta mandaba a buscar en el PCC un PNR que no existe.
    const noSalio = Object.assign(new Error(`cola vencida para ${DOCUMENTO}`), {
      sentToProvider: false,
    });
    noSalio.name = 'SabreApiError';
    const b = banco({ createThrows: noSalio });

    let thrown: unknown;
    try {
      await b.orders.createOrder(TENANT, USER, dto());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    const response = (thrown as HttpException).getResponse();
    expect(response).toMatchObject({ orderId: 'order-1', retryForbidden: false });
    expect(JSON.stringify(response)).not.toContain('reconciliationRequired');
    expect(JSON.stringify(response)).not.toContain(DOCUMENTO);
    expect(b.fila()).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.audit.first(ORDER_EVENTS.createFailed)?.payload).toMatchObject({
      uncertain: false,
      reason: 'not-dispatched',
      errorName: 'SabreApiError',
    });
    expect(b.audit.dump()).not.toContain(DOCUMENTO);
  });

  it('`sentToProvider: true` sigue siendo incierta: sólo el `false` explícito libera', async () => {
    const salio = Object.assign(new Error('timeout'), { sentToProvider: true });
    const b = banco({ createThrows: salio });

    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(b.fila()).toMatchObject({ status: 'pending' });
  });

  it('si el proveedor responde pero falla el CAS, devuelve intent + PNR y no intenta cerrar', async () => {
    const b = banco({}, {}, undefined, { failCreateIntentSettlement: true });

    const response = await b.orders.createOrder(TENANT, USER, dto());

    expect(response).toMatchObject({
      order: { id: 'order-1', status: 'pending' },
      providerResult: { outcome: 'CONFIRMED', pnr: PNR },
      saga: {
        kind: 'escalate',
        reason: 'result-persistence-unavailable',
        status: 'pending',
      },
    });
    expect(b.fila()).toMatchObject({
      status: 'pending',
      provider_order_id: null,
      provider_raw: null,
    });
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);
    expect(b.adapter.retrieveForDisplay).not.toHaveBeenCalled();
  });

  it('consolida orderId cuando el proveedor no entrega PNR', async () => {
    const b = banco({
      created: { ...confirmado(), pnr: undefined, orderId: 'NDC-ORDER-1' },
    });

    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.fila()?.['provider_order_id']).toBe('NDC-ORDER-1');
    expect(b.adapter.retrieveForDisplay).toHaveBeenCalledWith('NDC-ORDER-1', {
      tenantId: TENANT,
      requestId: 'order-1',
    });
  });

  it('un fallo de cierre post-settle responde pending con locator y nunca repite create', async () => {
    const b = banco();
    const originalEmit = b.audit.emit.bind(b.audit);
    vi.spyOn(b.audit, 'emit').mockImplementation((event) =>
      event.eventType === ORDER_EVENTS.verified
        ? Promise.reject(new Error('domain_events no disponible'))
        : originalEmit(event),
    );

    const response = await b.orders.createOrder(TENANT, USER, dto());

    expect(response).toMatchObject({
      order: { id: 'order-1', provider_order_id: PNR, status: 'pending' },
      providerResult: { outcome: 'CONFIRMED', pnr: PNR },
      saga: {
        kind: 'escalate',
        reason: 'post-create-finalization-unavailable',
        status: 'pending',
      },
    });
    expect(b.fila()).toMatchObject({
      provider_order_id: PNR,
      status: 'pending',
      error_message: 'Creación pendiente de conciliación con el proveedor. No reenviar la reserva.',
    });
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);
  });
});

describe('saga de creación — toda creación se CIERRA verificando', () => {
  it('un CONFIRMED se relee con el PNR antes de darse por bueno', async () => {
    const b = banco();
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(b.adapter.retrieveForDisplay).toHaveBeenCalledTimes(1);
    expect(b.adapter.retrieveForDisplay).toHaveBeenCalledWith(PNR, {
      tenantId: TENANT,
      requestId: 'order-1',
    });
    expect(saga).toEqual({ kind: 'settled', status: 'confirmed' });
  });

  it('la lectura de cierre queda registrada como operación durable de la orden', async () => {
    const b = banco();
    await b.orders.createOrder(TENANT, USER, dto());

    const lectura = b.operaciones().find((op) => op['type'] === 'retrieve');
    expect(lectura).toBeDefined();
    expect(lectura?.['status']).toBe('success');
    expect(lectura?.['actor_user_id']).toBe(USER);
  });

  it('un FAILED sin PNR no gasta una lectura: no hay nada del otro lado', async () => {
    const b = banco({ created: { outcome: 'FAILED', items: [], issues: [] } });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(b.adapter.retrieveForDisplay).not.toHaveBeenCalled();
    expect(saga).toEqual({ kind: 'settled', status: 'failed' });
    expect(b.fila()?.['status']).toBe('failed');
  });

  it('si la lectura falla, la reserva NO queda confirmada y se encola el reintento', async () => {
    const b = banco({ viewThrows: new Error('timeout leyendo la reserva') });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toEqual({
      kind: 'escalate',
      reason: 'verification-unavailable',
      status: 'confirmed',
    });
    // La reserva EXISTE (el proveedor devolvió PNR): lo único que falta es releerla, y eso sí es
    // automatizable. Por eso se encola en vez de dejarlo para una persona.
    expect(b.queue.verifications).toEqual([
      { tenantId: TENANT, orderId: 'order-1', actorUserId: USER },
    ]);
  });

  it('un proveedor que no sabe leer deja la creación SIN cerrar, y lo dice', async () => {
    const b = banco({}, { retrieve: false });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(b.adapter.retrieveForDisplay).not.toHaveBeenCalled();
    expect(saga.kind).toBe('escalate');
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload?.['reason']).toBe(
      'verification-unavailable',
    );
  });

  it('el proveedor diciendo que la reserva no existe baja el estado de confirmed a pending', async () => {
    const b = banco({
      view: { found: false, airlineLocators: [], warnings: [] },
    });
    const { order, saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toEqual({ kind: 'escalate', reason: 'verified-not-found', status: 'pending' });
    expect(order.status).toBe('pending');
    expect(b.fila()?.['status']).toBe('pending');
  });
});

describe('saga de creación — la compensación es selectiva y va a la cola', () => {
  it('un vuelo caído encola la compensación CON los ítems que el proveedor declaró', async () => {
    const b = banco({ created: vueloCaido() });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toEqual({
      kind: 'compensate',
      reason: 'partial-items-failed',
      cancellableItemIds: ['12'],
      status: 'pending',
    });
    expect(b.queue.compensations).toEqual([
      {
        tenantId: TENANT,
        orderId: 'order-1',
        cancellableItemIds: ['12'],
        reason: 'partial-items-failed',
        actorUserId: USER,
      },
    ]);
    expect(b.queue.jobs.map((job) => job.name)).toEqual(['compensate']);
    expect(b.queue.jobs[0]?.jobId).toMatch(/^compensate:order-1:[0-9a-f]{64}$/);
    expect(b.queue.jobs[0]).not.toHaveProperty('rejection');
  });

  it('un PARTIAL no se persiste como confirmado aunque haya PNR', async () => {
    const b = banco({ created: extraCaido() });
    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.fila()?.['status']).toBe('pending');
    expect(b.fila()?.['provider_order_id']).toBe(PNR);
  });

  it('un CONFIRMED no encola ninguna compensación', async () => {
    const b = banco();
    await b.orders.createOrder(TENANT, USER, dto());
    expect(b.queue.compensations).toEqual([]);
  });
});

/**
 * **UN FALLO DE ACCESORIO NUNCA CANCELA EL PRODUCTO.**
 *
 * Cancelar un vuelo confirmado porque no había asiento es indefendible: la tarifa puede haber
 * desaparecido y el cliente se queda sin viaje por un extra. Perder el asiento es recuperable;
 * perder el vuelo no. La compensación se dispara por el fallo de algo de lo que la compra DEPENDE,
 * no por cualquier desenlace parcial.
 *
 * Todo entra por `OrdersService.createOrder`: lo que se mide es lo que sale del proceso —lo que se
 * encola y lo que se persiste—, no lo que devuelve una función interna.
 */
describe('saga de creación — un accesorio caído no cancela el producto', () => {
  it('asiento denegado: NO se cancela el vuelo, ni ahora ni encolado para después', async () => {
    const b = banco({ created: parcial() });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    // SAB-16: con todos los vuelos confirmados y sólo el asiento fuera, la reserva se cierra
    // confirmada (el vendedor ve en la misma pantalla qué asiento no quedó).
    expect(saga).toEqual({ kind: 'settled', status: 'confirmed' });
    // Las dos formas de perder el vuelo: cancelarlo aquí, o encolar una compensación que lo
    // cancele dentro de un minuto. Ninguna ocurre —y el proveedor había declarado el vuelo
    // cancelable, así que la protección no viene de que la lista llegara vacía.
    expect(b.queue.compensations).toEqual([]);
    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
  });

  it('el asiento caído queda dicho: OrderSeatsNotConfirmed con cuántos, sin reintento automático', async () => {
    // Un asiento no se recupera solo, y la persona que tiene que decidir —pedir otro o preguntarle
    // al cliente— es el vendedor que lo está mirando. Queda el evento, con el conteo y sin quién.
    const b = banco({ created: parcial() });
    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.audit.first(ORDER_EVENTS.seatsNotConfirmed)?.payload).toEqual({
      provider: PROVEEDOR,
      seats: 1,
    });
    expect(b.audit.first(ORDER_EVENTS.escalated)).toBeUndefined();
    expect(b.fila()?.['status']).toBe('confirmed');
    expect(b.queue.verifications).toEqual([]);
    expect(b.queue.compensations).toEqual([]);
  });

  it('un EXTRA caído (no un asiento) sí ESCALA: lo tiene que ver una persona', async () => {
    const b = banco({ created: extraCaido() });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toEqual({
      kind: 'escalate',
      reason: 'partial-without-essential-failure',
      status: 'pending',
    });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'partial-without-essential-failure',
      outcome: 'PARTIAL',
      queued: false,
    });
    expect(b.queue.compensations).toEqual([]);
    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
  });

  it('asiento caído MÁS un error que no es del asiento: escala, no se confirma', async () => {
    // El atajo de SAB-16 no puede tapar lo que el proveedor dijo de otra cosa: el PNR pudo quedar
    // sin precio guardado y se emitiría a otra tarifa. Queda `pending` y lo ve una persona.
    const created: OrderCreateResult = {
      ...parcial(),
      issues: [
        ...parcial().issues,
        { severity: 'ERROR', category: 'APPLICATION_ERROR', type: 'UNABLE_TO_PRICE_BOOKING' },
      ],
    };
    const b = banco({ created });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toEqual({
      kind: 'escalate',
      reason: 'partial-without-essential-failure',
      status: 'pending',
    });
    expect(b.fila()?.['status']).toBe('pending');
    expect(b.audit.first(ORDER_EVENTS.seatsNotConfirmed)).toBeUndefined();
    expect(b.queue.compensations).toEqual([]);
    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
  });

  it('CONTRAPESO: si el que se cae es el vuelo, SÍ se compensa lo que quedó vivo', async () => {
    // La regla no puede degenerar en «no se compensa nunca». Un tramo caído deja al cliente a
    // mitad de camino y lo que sobrevivió hay que deshacerlo.
    const b = banco({ created: vueloCaido() });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga.kind).toBe('compensate');
    expect(b.queue.compensations[0]?.cancellableItemIds).toEqual(['12']);
  });

  it('MIXTO: un asiento caído junto a un vuelo caído sigue compensando', async () => {
    // El accesorio no puede volver inofensivo un fallo que sí lo es: si la puerta preguntara
    // «¿hay algún accesorio caído?» en vez de «¿se cayó algo esencial?», este caso dejaría el
    // tramo vivo colgando de una reserva rota.
    const b = banco({
      created: {
        outcome: 'PARTIAL',
        pnr: PNR,
        items: [
          { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
          { kind: 'flight', providerItemId: '14', status: 'FAILED', statusCode: 'UC' },
          { kind: 'seat', status: 'FAILED', statusCode: 'UC' },
        ],
        issues: [],
        compensation: { cancellableItemIds: ['12'] },
      },
    });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'compensate', cancellableItemIds: ['12'] });
  });

  it('un vuelo en lista de espera NO es un vuelo caído: no dispara la compensación', async () => {
    // `NN`/`UU` son ítems que existen y todavía pueden confirmarse solos. Contarlos como fallo
    // esencial cancelaría justo lo que aún podía salir bien.
    const b = banco({
      created: {
        outcome: 'PARTIAL',
        pnr: PNR,
        items: [
          { kind: 'flight', providerItemId: '12', status: 'UNCONFIRMED', statusCode: 'NN' },
          { kind: 'seat', status: 'FAILED', statusCode: 'UC' },
        ],
        issues: [],
        compensation: { cancellableItemIds: ['12'] },
      },
    });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'escalate', reason: 'partial-without-essential-failure' });
    expect(b.queue.compensations).toEqual([]);
  });

  it('un PARTIAL que sólo trae `errors[]`, sin ítem caído, tampoco cancela nada', async () => {
    // Es el parcial que produce elegir `DO_NOT_HALT_ON_*` y que el proveedor cuente algo que no
    // tumbó ningún ítem. Cancelar el vuelo por un mensaje de error es la misma avería con otro
    // disfraz.
    const b = banco({
      created: {
        outcome: 'PARTIAL',
        pnr: PNR,
        items: [{ kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' }],
        issues: [{ severity: 'ERROR', category: 'APPLICATION_ERROR', type: 'REMARK_NOT_ADDED' }],
        compensation: { cancellableItemIds: ['12'] },
      },
    });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'escalate', reason: 'partial-without-essential-failure' });
    expect(b.queue.compensations).toEqual([]);
  });

  it('un hotel caído no cancela el vuelo: la compra no depende de él', async () => {
    // LA DECISIÓN DISCUTIBLE, fijada aquí para que cambiarla sea explícito. Sin el vuelo el hotel
    // de Lima no se puede usar; sin el hotel el vuelo a Lima sigue volando y el cliente duerme en
    // otro sitio. La dependencia va en un solo sentido, y equivocarse por este lado es
    // recuperable: escala y una persona rehace el hotel. Si negocio decide que un paquete cae
    // entero cuando cae el hotel, este test se pone rojo y dice qué se está cambiando.
    const b = banco({
      created: {
        outcome: 'PARTIAL',
        pnr: PNR,
        items: [
          { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
          { kind: 'hotel', providerItemId: 'H1', status: 'FAILED', statusCode: 'UC' },
        ],
        issues: [],
        compensation: { cancellableItemIds: ['12'] },
      },
    });
    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'escalate', reason: 'partial-without-essential-failure' });
    expect(b.queue.compensations).toEqual([]);
  });
});

describe('saga de creación — la cola puede no estar, y se dice', () => {
  it('sin Redis, el evento DICE que la compensación no se encoló', async () => {
    // La degradación es elegante pero visible: creer que hay una compensación en marcha que no
    // existe es peor que no tener cola.
    const adapter = new SagaAdapter({ created: vueloCaido() });
    const registry = new FlightProviderRegistry([new SagaFactory(adapter)], {
      decisionFor: () => Promise.resolve(undefined),
    });
    const { db } = dbFalsa();
    const audit = new RecordingAuditService();
    const orders = new OrdersService(
      db,
      registry,
      new RecordingQueueService(false).asService(),
      {} as unknown as AgentCarsProviderFactory,
      audit.asService(),
      PRICING_SIN_REGLAS,
    );

    await orders.createOrder(TENANT, USER, dto());

    expect(audit.first(ORDER_EVENTS.compensationScheduled)?.payload?.['queued']).toBe(false);
  });
});

describe('saga de creación — el domain_event (RNF-08)', () => {
  it('emite el intento ANTES de llamar, con tenant y actor', async () => {
    const b = banco({ createThrows: new Error('gateway timeout') });
    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toThrow(
      /pendiente de conciliación/i,
    );

    const pedido = b.audit.first(ORDER_EVENTS.createRequested);
    expect(pedido?.tenantId).toBe(TENANT);
    expect(pedido?.actorUserId).toBe(USER);
    expect(pedido?.payload?.['provider']).toBe(PROVEEDOR);
  });

  it('una excepción del proveedor deja un evento marcado como INCIERTO', async () => {
    // No es un `FAILED`: un timeout no dice si el PNR se creó. Sin este evento no hay nada contra
    // lo que buscar una reserva fantasma en el PCC.
    const b = banco({ createThrows: new Error('gateway timeout') });
    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toThrow();

    const fallo = b.audit.first(ORDER_EVENTS.createFailed);
    expect(fallo?.payload).toMatchObject({ uncertain: true, reason: 'create-uncertain' });
  });

  it('el evento del fallo lleva el NOMBRE de la clase de error, nunca su mensaje', async () => {
    const err = new Error('passport AB1234567 rejected for CARDOSO/MARIA');
    err.name = 'ProviderTimeoutError';
    const b = banco({ createThrows: err });
    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toThrow();

    expect(b.audit.first(ORDER_EVENTS.createFailed)?.payload?.['errorName']).toBe(
      'ProviderTimeoutError',
    );
    expect(b.audit.dump()).not.toContain('CARDOSO/MARIA');
  });

  it('cita la `errorHandlingPolicy` con la que se pidió la reserva', async () => {
    // El éxito parcial es un modo que se ELIGE antes de llamar. Un `PARTIAL` sin la política que
    // se pidió es una reserva a medias que nadie puede explicar tres semanas después.
    const b = banco({ created: parcial(), createAudit: AUDITORIA_DE_CREACION });
    await b.orders.createOrder(TENANT, USER, dto());

    const creado = b.audit.first(ORDER_EVENTS.created);
    expect(creado?.payload?.['errorHandlingPolicy']).toEqual(['HALT_ON_ERROR']);
    expect(creado?.payload?.['asynchronousUpdateWaitTimeMs']).toBe(7000);
    expect(creado?.payload?.['outcome']).toBe('PARTIAL');
  });

  it('un proveedor que NO audita lo declara, en vez de fingir una política vacía', async () => {
    const b = banco({ created: parcial() });
    await b.orders.createOrder(TENANT, USER, dto());

    const creado = b.audit.first(ORDER_EVENTS.created);
    expect(creado?.payload?.['audited']).toBe(false);
    expect(creado?.payload).not.toHaveProperty('errorHandlingPolicy');
  });

  it('ningún evento del saga lleva PII del pasajero', async () => {
    const b = banco({ created: parcial(), createAudit: AUDITORIA_DE_CREACION });
    await b.orders.createOrder(TENANT, USER, dto());

    // `fieldValue` es el valor que MANDAMOS devuelto tal cual; `message` es texto libre del
    // proveedor. `domain_events` es append-only: lo que entra ahí no se puede quitar.
    expect(b.audit.dump()).not.toContain(DOCUMENTO);
    expect(b.audit.dump()).not.toContain('The requested seat is no longer available');
    // Y sí conserva el vocabulario cerrado, que es para lo que sirve el registro.
    expect(b.audit.dump()).toContain('SEAT_NOT_AVAILABLE');
  });

  it('la secuencia de eventos de una creación normal es pedido → creado → verificado', async () => {
    const b = banco({ createAudit: AUDITORIA_DE_CREACION });
    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.audit.types()).toEqual([
      ORDER_EVENTS.createRequested,
      ORDER_EVENTS.created,
      ORDER_EVENTS.verified,
    ]);
  });
});

describe('saga de creación — orders.provider_raw', () => {
  it('se llena (ya no es null) y sin PII', async () => {
    const b = banco({ created: parcial() });
    await b.orders.createOrder(TENANT, USER, dto());

    const raw = b.fila()?.['provider_raw'];
    expect(typeof raw).toBe('string');
    expect(raw).toContain(PNR);
    expect(raw).not.toContain(DOCUMENTO);
    expect(raw).not.toContain('The requested seat is no longer available');
  });

  it('usa la lista blanca del adapter cuando el proveedor la ofrece', async () => {
    const b = banco({ createAudit: AUDITORIA_DE_CREACION });
    await b.orders.createOrder(TENANT, USER, dto());

    expect(JSON.parse(String(b.fila()?.['provider_raw']))).toEqual({
      provider: PROVEEDOR,
      audited: true,
      pnr: PNR,
    });
  });
});

describe('cancelación auditada — `UNVERIFIED` es PROHIBIDO-REINTENTAR', () => {
  /** Una orden YA existente: la cancelación opera sobre una reserva que está en la base. */
  const ORDEN_EN_BASE = { provider: PROVEEDOR, provider_order_id: PNR, status: 'confirmed' };

  const auditoriaVerificada = {
    audit: { audited: true, outcome: 'CANCELLED' },
    idempotencyKey: 'sha256-de-la-peticion',
    verified: true,
  };

  function errorTipado(name: string, fields: Readonly<Record<string, unknown>> = {}): Error {
    const error = Object.assign(new Error(name), fields);
    error.name = name;
    return error;
  }

  it('la clave de idempotencia del proveedor viaja al `domain_event`', async () => {
    // El cliente HTTP no reintenta una cancelación —un timeout no dice si se ejecutó—, así que
    // quien reintenta es el saga y necesita reconocer que el segundo intento es el mismo paso.
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE);
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    const evento = b.audit.first(ORDER_EVENTS.cancelled);
    expect(evento?.payload?.['idempotencyKey']).toBe('sha256-de-la-peticion');
    expect(evento?.actorUserId).toBe(USER);
    expect(evento?.tenantId).toBe(TENANT);
  });

  it('una cancelación sin verificar escala en vez de pasar por rechazo normal', async () => {
    const b = banco(
      {
        cancelResult: { success: false, warnings: [], error: 'sin confirmación del proveedor' },
        cancelAudit: {
          audit: { audited: true, outcome: 'UNVERIFIED' },
          idempotencyKey: 'sha256-de-la-peticion',
          verified: false,
        },
      },
      {},
      ORDEN_EN_BASE,
    );
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    const escalado = b.audit.first(ORDER_EVENTS.escalated);
    expect(escalado?.payload).toMatchObject({
      reason: 'cancellation-unverified',
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(b.queue.cancels).toEqual([]);
    expect(JSON.parse(String(b.operaciones()[0]?.['result']))).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
    });
  });

  it('un build determinista no entra a la cola', async () => {
    const b = banco(
      { cancelThrows: errorTipado('SabreCancelBookingBuildError') },
      {},
      ORDEN_EN_BASE,
    );

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow();

    expect(b.queue.cancels).toEqual([]);
    expect(JSON.parse(String(b.operaciones()[0]?.['result']))).toMatchObject({
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
    });
  });

  it('un timeout del write se escala y jamás se encola', async () => {
    const timeout = errorTipado('SabreApiError', {
      path: '/v1/trip/orders/cancelBooking',
      status: 0,
      retryable: true,
      failure: { kind: 'TRANSPORT', retry: 'RETRY_BACKOFF' },
    });
    const b = banco({ cancelThrows: timeout }, {}, ORDEN_EN_BASE);

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow(
      /no la reintentes/i,
    );

    expect(b.queue.cancels).toEqual([]);
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'write-unverified',
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(JSON.parse(String(b.operaciones()[0]?.['result']))).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
    });
  });

  it('una orden ya cancelada se bloquea aunque no haya operación durable', async () => {
    const b = banco({}, {}, { ...ORDEN_EN_BASE, status: 'cancelled' });

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow(
      /ya está cancelada/i,
    );

    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
    expect(b.operaciones()).toEqual([]);
  });

  it('una orden emitida no entra a la cancelación genérica ni crea un claim', async () => {
    const b = banco({}, {}, { ...ORDEN_EN_BASE, status: 'ticketed' });

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow(
      /emitida|VOID|REFUND/i,
    );

    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
    expect(b.operaciones()).toEqual([]);
    expect(b.fila()).toMatchObject({ status: 'ticketed' });
  });

  it('si no puede adquirir el claim durable no toca al proveedor ni borra el error previo', async () => {
    const b = banco(
      { cancelAudit: auditoriaVerificada },
      {},
      { ...ORDEN_EN_BASE, error_message: 'fallo previo que debe sobrevivir' },
      {
        failOperationInsert: true,
      },
    );

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow();
    expect(b.operaciones()).toEqual([]);
    expect(b.fila()).toMatchObject({
      status: 'confirmed',
      error_message: 'fallo previo que debe sobrevivir',
    });
    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
    expect(b.queue.cancels).toEqual([]);
  });

  it('consume el permiso de retry antes del write y no lo reutiliza si falla completar el claim', async () => {
    const preflight = errorTipado('SabreApiError', {
      path: '/v1/trip/orders/getBooking',
      status: 503,
      retryable: true,
      failure: { kind: 'UPSTREAM', retry: 'RETRY_BACKOFF' },
    });
    const dbOptions = { failOperationCompletion: false };
    const b = banco(
      { cancelThrows: preflight, cancelAudit: auditoriaVerificada },
      {},
      ORDEN_EN_BASE,
      dbOptions,
    );
    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toBe(preflight);
    const opId = String(b.operaciones()[0]?.['id']);

    b.adapter.cancelOrder.mockResolvedValue({ success: true, warnings: [] });
    dbOptions.failOperationCompletion = true;
    await expect(b.orders.retryOperation(TENANT, 'order-1', opId, USER)).rejects.toThrow(
      /no confirmó/i,
    );

    expect(b.operaciones()).toHaveLength(1);
    expect(b.operaciones()[0]).toMatchObject({ status: 'pending' });
    expect(JSON.parse(String(b.operaciones()[0]?.['result']))).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
    });

    await expect(b.orders.retryOperation(TENANT, 'order-1', opId, USER)).rejects.toThrow(
      /sólo se puede reintentar/i,
    );
    expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(2);
  });

  it('sólo un request concurrente adquiere el claim y llega al write del proveedor', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE);
    let releaseProvider!: (result: OrderCancelResult) => void;
    const providerGate = new Promise<OrderCancelResult>((resolve) => {
      releaseProvider = resolve;
    });
    b.adapter.cancelOrder.mockImplementation(() => providerGate);

    const first = b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);
    await vi.waitFor(() => expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(1));

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow(
      /pendiente|claim|conciliar/i,
    );
    expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(1);

    releaseProvider({ success: true, warnings: [] });
    await expect(first).resolves.toMatchObject({ result: { success: true } });
    expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it('si falla el UPDATE final, claim y orden quedan pending: no publica un éxito parcial', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE, {
      failOrderFinalize: true,
    });

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow(
      /no confirmó/i,
    );

    expect(b.operaciones()).toHaveLength(1);
    expect(b.operaciones()[0]).toMatchObject({ status: 'pending' });
    expect(b.fila()).toMatchObject({ status: 'pending' });
    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow(
      /pendiente|conciliar/i,
    );
    expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it('una excepción del proveedor no persiste su texto libre/PII en last_error', async () => {
    const leaked = errorTipado('SabreCancelBookingBuildError');
    leaked.message = `Documento ${DOCUMENTO} inválido`;
    const b = banco(
      { cancelThrows: leaked },
      {},
      { ...ORDEN_EN_BASE, error_message: 'error anterior' },
    );

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toThrow();

    expect(String(b.operaciones()[0]?.['last_error'])).not.toContain(DOCUMENTO);
    expect(String(b.operaciones()[0]?.['result'])).not.toContain(DOCUMENTO);
    expect(b.fila()).toMatchObject({ status: 'confirmed', error_message: 'error anterior' });
  });

  it('sólo un fallo transitorio del preflight se encola', async () => {
    const preflight = errorTipado('SabreApiError', {
      path: '/v1/trip/orders/getBooking',
      status: 503,
      retryable: true,
      failure: { kind: 'UPSTREAM', retry: 'RETRY_BACKOFF' },
    });
    const b = banco({ cancelThrows: preflight }, {}, ORDEN_EN_BASE);

    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toBe(preflight);

    const opId = String(b.operaciones()[0]?.['id']);
    expect(b.queue.cancels).toEqual([
      { tenantId: TENANT, orderId: 'order-1', operationId: opId, type: 'cancel' },
    ]);
    // Pedirlo no basta: con `cancel:<orderId>` BullMQ rechazaba el id, `add()` devolvía `false`
    // y el reintento no existía. El doble aplica la regla de BullMQ y el intento es la operación.
    expect(b.queue.jobs.map((job) => job.name)).toEqual(['cancel']);
    expect(b.queue.jobs[0]?.jobId).toBe(`cancel:order-1:${opId}`);
    expect(b.queue.jobs[0]).not.toHaveProperty('rejection');
    expect(JSON.parse(String(b.operaciones()[0]?.['result']))).toMatchObject({
      outcome: 'FAILED',
      retryable: true,
      reason: 'pre-write-transient',
    });
  });

  it('ni el worker ni el endpoint manual repiten un UNVERIFIED', async () => {
    const b = banco(
      {
        cancelResult: { success: false, warnings: [], error: 'sin confirmación del proveedor' },
        cancelAudit: {
          audit: { audited: true, outcome: 'UNVERIFIED' },
          verified: false,
        },
      },
      {},
      ORDEN_EN_BASE,
    );
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);
    const opId = String(b.operaciones()[0]?.['id']);

    await b.orders.runCancelById(TENANT, 'order-1');
    await expect(b.orders.retryOperation(TENANT, 'order-1', opId, USER)).rejects.toThrow(
      /conciliar/i,
    );

    expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it('una cancelación verificada NO escala', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE);
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
  });

  it('la compensación selectiva cancela POR ítem, no la reserva entera', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE);
    await b.orders.runCompensation(TENANT, 'order-1', ['12'], USER);

    expect(b.adapter.cancelScopes).toEqual([{ itemIds: ['12'] }]);
  });

  it('una lista de compensación vacía NO se convierte en cancelar todo', async () => {
    // Es la regla más cara del saga: en un éxito parcial hay ítems que sí quedaron confirmados.
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE);
    await b.orders.runCompensation(TENANT, 'order-1', [], USER);

    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
    expect(b.adapter.cancelScopes).toEqual([]);
  });

  it('una cancelación normal (no compensación) va sin ámbito: es la reserva entera', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE);
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);
    expect(b.adapter.cancelScopes).toEqual([undefined]);
  });
});

describe('cancelar un vuelo libera su retención de cartera (0060)', () => {
  const ORDEN_EN_BASE = {
    provider: PROVEEDOR,
    provider_order_id: PNR,
    status: 'confirmed',
    user_id: USER,
  };
  const verificada = {
    cancelAudit: {
      audit: { audited: true, outcome: 'CANCELLED' },
      idempotencyKey: 'sha256-de-la-peticion',
      verified: true,
    },
  };

  function retenciones(settle: ReturnType<typeof vi.fn>): BookingHoldLedger {
    return { settle } as unknown as BookingHoldLedger;
  }

  it('confirmada la cancelación, cierra la retención con quien canceló (en todos los niveles)', async () => {
    const settle = vi.fn(() => Promise.resolve('released'));
    const b = banco(verificada, {}, ORDEN_EN_BASE, {}, undefined, retenciones(settle));

    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(settle).toHaveBeenCalledWith(TENANT, 'order-1', USER);
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
  });

  it('sin persona que cancele, firma quien reservó', async () => {
    const settle = vi.fn(() => Promise.resolve('released'));
    const b = banco(verificada, {}, ORDEN_EN_BASE, {}, undefined, retenciones(settle));

    await b.orders.cancelOrder(TENANT, 'order-1', PNR);

    expect(settle).toHaveBeenCalledWith(TENANT, 'order-1', USER);
  });

  it('si la liberación falla, la cancelación sigue confirmada y se escala sin datos de nadie', async () => {
    const settle = vi.fn(() => Promise.reject(new Error('base caída')));
    const b = banco(verificada, {}, ORDEN_EN_BASE, {}, undefined, retenciones(settle));

    const out = await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(out.result.success).toBe(true);
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toEqual({
      provider: PROVEEDOR,
      reason: 'portfolio-hold-release-failed',
      queued: false,
      errorName: 'Error',
    });
  });

  it('una retención en conflicto se escala como conflicto', async () => {
    const settle = vi.fn(() => Promise.resolve('conflict'));
    const b = banco(verificada, {}, ORDEN_EN_BASE, {}, undefined, retenciones(settle));

    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'portfolio-hold-state-conflict',
    });
  });

  it('una cancelación rechazada o sin verificar no toca la retención', async () => {
    const settle = vi.fn(() => Promise.resolve('released'));
    const rechazada = banco(
      { cancelResult: { success: false, warnings: [], error: 'no se puede' } },
      {},
      ORDEN_EN_BASE,
      {},
      undefined,
      retenciones(settle),
    );
    await rechazada.orders.cancelOrder(TENANT, 'order-1', PNR, USER).catch(() => undefined);

    const sinVerificar = banco(
      {
        cancelResult: { success: false, warnings: [], error: 'sin confirmación del proveedor' },
        cancelAudit: { audit: { audited: true, outcome: 'UNVERIFIED' }, verified: false },
      },
      {},
      ORDEN_EN_BASE,
      {},
      undefined,
      retenciones(settle),
    );
    await sinVerificar.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(settle).not.toHaveBeenCalled();
  });
});

describe('runPostSaleJob — el runner enruta, no decide', () => {
  function servicioEspiado(): {
    orders: PostSaleJobHandlers;
    runCancelById: ReturnType<typeof vi.fn>;
    verifyCreationById: ReturnType<typeof vi.fn>;
    runCompensation: ReturnType<typeof vi.fn>;
  } {
    const runCancelById = vi.fn(() => Promise.resolve());
    const verifyCreationById = vi.fn(() => Promise.resolve());
    const runCompensation = vi.fn(() => Promise.resolve());
    return {
      orders: {
        orders: { runCancelById, verifyCreationById, runCompensation },
        hotelBookings: { runJob: vi.fn(() => Promise.resolve()) },
        hotelCancellations: { runJob: vi.fn(() => Promise.resolve()) },
        hcn: { runJob: vi.fn(() => Promise.resolve()) },
        reconciliation: {
          runJob: vi.fn(() => Promise.resolve()),
          runDaily: vi.fn(() => Promise.resolve({ accounts: 0, queued: 0, ran: 0, failed: 0 })),
        },
        sweeper: { run: vi.fn(() => Promise.reject(new Error('no se esperaba el barrido'))) },
        ticketIssues: {
          runIssueById: vi.fn(() => Promise.reject(new Error('no se esperaba una emisión'))),
          runVerifyJob: vi.fn(() => Promise.resolve()),
        },
      },
      runCancelById,
      verifyCreationById,
      runCompensation,
    };
  }

  it('enruta la cancelación', async () => {
    const e = servicioEspiado();
    await runPostSaleJob(e.orders, 'cancel', {
      tenantId: TENANT,
      orderId: 'o1',
      operationId: 'op-1',
      type: 'cancel',
    });
    expect(e.runCancelById).toHaveBeenCalledWith(TENANT, 'o1');
  });

  it('enruta la lectura de cierre diferida conservando el actor', async () => {
    const e = servicioEspiado();
    await runPostSaleJob(e.orders, 'verify-creation', {
      tenantId: TENANT,
      orderId: 'o1',
      actorUserId: USER,
    });
    expect(e.verifyCreationById).toHaveBeenCalledWith(TENANT, 'o1', USER);
  });

  it('enruta la compensación con los ítems que venían en el job', async () => {
    // Los ids NO se recalculan en el worker: son los que el proveedor declaró cancelables al
    // crear, y volver a derivarlos horas después contra un estado que ya cambió es como se
    // cancela lo que sí estaba bien.
    const e = servicioEspiado();
    await runPostSaleJob(e.orders, 'compensate', {
      tenantId: TENANT,
      orderId: 'o1',
      cancellableItemIds: ['12'],
      reason: 'partial-items-failed',
      actorUserId: USER,
    });
    expect(e.runCompensation).toHaveBeenCalledWith(TENANT, 'o1', ['12'], USER);
  });

  it('un nombre de job desconocido LANZA en vez de terminar en verde', async () => {
    // Un `default: return` daría por hecho un job que nadie ejecutó: la compensación quedaría sin
    // hacer y la cola diría que todo salió bien.
    const e = servicioEspiado();
    await expect(
      runPostSaleJob(e.orders, 'inventado', {
        tenantId: TENANT,
        orderId: 'o1',
        operationId: 'op-1',
        type: 'cancel',
      }),
    ).rejects.toThrow(/desconocido/);
  });
});

describe('enrutado — ninguna oferta sale por el adapter de otro proveedor', () => {
  it('el saga usa el proveedor de la OFERTA para crear Y para verificar', async () => {
    const otro = new StubProviderFactory({ code: 'otro-air' });
    const mio = new SagaAdapter();
    const registry = new FlightProviderRegistry([new SagaFactory(mio), otro], {
      decisionFor: () => Promise.resolve(undefined),
    });
    const { db } = dbFalsa();
    const orders = new OrdersService(
      db,
      registry,
      new RecordingQueueService().asService(),
      {} as unknown as AgentCarsProviderFactory,
      new RecordingAuditService().asService(),
      PRICING_SIN_REGLAS,
    );

    await orders.createOrder(TENANT, USER, dto());

    expect(mio.createOrder).toHaveBeenCalledTimes(1);
    expect(mio.retrieveForDisplay).toHaveBeenCalledTimes(1);
    // El paso de verificación es el que más fácil se escapa a un proveedor fijo: es una lectura,
    // y una lectura contra el GDS equivocado devuelve "no existe" en vez de fallar.
    expect(otro.adapterFor(TENANT).createOrder).not.toHaveBeenCalled();
    expect(otro.adapterFor(TENANT).retrieveForDisplay).not.toHaveBeenCalled();
  });
});

describe('habilitación de la plataforma — corta la venta nueva, no la post-venta', () => {
  const ORDEN_EN_BASE = { provider: PROVEEDOR, provider_order_id: PNR, status: 'confirmed' };
  const APAGADO = (): ProviderFlagsPort => providerFlags(() => apagadoPara(TENANT));
  const auditoriaVerificada = {
    audit: { audited: true, outcome: 'CANCELLED' },
    idempotencyKey: 'sha256-de-la-peticion',
    verified: true,
  };

  it('con el proveedor apagado para el tenant, `createOrder` para antes de abrir la orden', async () => {
    const b = banco({}, {}, undefined, {}, APAGADO());

    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toBeInstanceOf(
      ProviderDisabledByPlatformError,
    );

    // Ni intent en la base ni llamada al proveedor: no queda nada a medio camino.
    expect(b.fila()).toBeUndefined();
    expect(b.adapter.priceOffer).not.toHaveBeenCalled();
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
  });

  it('una orden YA hecha se sigue cancelando con el proveedor apagado', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE, {}, APAGADO());

    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(b.adapter.cancelOrder).toHaveBeenCalledTimes(1);
    expect(b.audit.first(ORDER_EVENTS.cancelled)).toBeDefined();
  });

  it('una orden YA hecha se sigue leyendo, y su compensación selectiva sigue saliendo', async () => {
    const b = banco({ cancelAudit: auditoriaVerificada }, {}, ORDEN_EN_BASE, {}, APAGADO());

    await b.orders.retrieveFromProvider(TENANT, {
      id: 'order-1',
      provider: PROVEEDOR,
      provider_order_id: PNR,
      provider_account_id: null,
    });
    await b.orders.runCompensation(TENANT, 'order-1', ['12'], USER);

    expect(b.adapter.retrieveForDisplay).toHaveBeenCalledWith(PNR, { tenantId: TENANT });
    expect(b.adapter.cancelScopes).toEqual([{ itemIds: ['12'] }]);
  });

  it('una orden YA hecha se sigue pagando: el pago de una reserva existente no es venta nueva', async () => {
    const b = banco({}, {}, ORDEN_EN_BASE, {}, APAGADO());
    b.adapter.payOrder.mockImplementationOnce(() =>
      Promise.resolve({ success: true, status: 'ticketed', warnings: [] } as never),
    );
    const orden = b.fila() as unknown as Parameters<OrdersService['payOrder']>[2];

    const res = await b.orders.payOrder(
      TENANT,
      'order-1',
      orden,
      { type: 'Cash', amount: 100, currency: 'USD' },
      USER,
    );

    expect(res.success).toBe(true);
    expect(b.adapter.payOrder).toHaveBeenCalledTimes(1);
  });
});

describe('post-venta con la cuenta de la reserva (RF-29)', () => {
  const CUENTA_VIGENTE = 'acc-vigente';
  const CUENTA_DE_LA_ORDEN = 'acc-de-la-orden';
  const VERSION_VIGENTE = new Date('2026-05-01T10:00:00.000Z');
  const ORDEN_CON_CUENTA = {
    provider: PROVEEDOR,
    provider_order_id: PNR,
    status: 'confirmed',
    user_id: USER,
    provider_account_id: CUENTA_DE_LA_ORDEN,
  };
  const verificada: AdapterOptions = {
    cancelAudit: {
      audit: { audited: true, outcome: 'CANCELLED' },
      idempotencyKey: 'sha256-de-la-peticion',
      verified: true,
    },
  };

  /** Vende con la cuenta vigente del tenant y dice cuál es, pero no sabe operar por cuenta. */
  class SagaFactoryConCuenta extends SagaFactory {
    /** Cuántas veces se pidió la cuenta vigente. */
    vigentes = 0;

    override resolveForTenant(): Promise<TenantAdapter<FlightProviderAdapter>> {
      this.vigentes += 1;
      return Promise.resolve({
        adapter: this.adapter,
        credentialSource: 'own',
        accountId: CUENTA_VIGENTE,
        accountUpdatedAt: VERSION_VIGENTE,
      });
    }
  }

  /** Además opera cada orden con la cuenta que guardó, con un adapter propio para ver cuál salió. */
  class SagaFactoryPorCuenta extends SagaFactoryConCuenta {
    disponible = true;
    readonly resolveForOrder = vi.fn(
      (_tenantId: string, _orderId: string): Promise<TenantAdapter<FlightProviderAdapter>> =>
        this.disponible
          ? Promise.resolve({
              adapter: this.deLaOrden,
              credentialSource: 'inherited',
              accountId: CUENTA_DE_LA_ORDEN,
              accountUpdatedAt: new Date('2026-03-01T10:00:00.000Z'),
            })
          : Promise.reject(new NotFoundException('fuera de la red')),
    );

    constructor(
      adapter: SagaAdapter,
      readonly deLaOrden: SagaAdapter,
    ) {
      super(adapter);
    }
  }

  function montar(
    factory: SagaFactory,
    semilla?: Record<string, unknown>,
    providerAccounts: Readonly<Record<string, string>> = {},
  ) {
    const { db, fila, operaciones, consultas } = dbFalsa(semilla, { providerAccounts });
    const orders = new OrdersService(
      db,
      new FlightProviderRegistry([factory], { decisionFor: () => Promise.resolve(undefined) }),
      new RecordingQueueService().asService(),
      {} as unknown as AgentCarsProviderFactory,
      new RecordingAuditService().asService(),
      PRICING_SIN_REGLAS,
    );
    return { orders, fila, operaciones, consultas };
  }

  /** La fila tal como la leería el controlador. */
  function filaDe(b: ReturnType<typeof montar>): OrderRow {
    return b.fila() as unknown as OrderRow;
  }

  it('la venta de un proveedor que opera por cuenta la guarda, y el intent comprueba su versión', async () => {
    const factory = new SagaFactoryPorCuenta(new SagaAdapter(), new SagaAdapter());
    const b = montar(factory, undefined, { [CUENTA_VIGENTE]: VERSION_VIGENTE.toISOString() });

    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.fila()).toMatchObject({ provider_account_id: CUENTA_VIGENTE });
    expect(b.consultas()).toEqual(['resolve_order_provider_account']);
    expect(factory.adapter.createOrder).toHaveBeenCalledTimes(1);
    // La venta y su cierre salen con la cuenta vigente: la orden se opera por cuenta después.
    expect(factory.resolveForOrder).not.toHaveBeenCalled();
    expect(factory.deLaOrden.retrieveForDisplay).not.toHaveBeenCalled();
  });

  it('si la cuenta cambió entre resolverla y abrir la orden, 409 y nada sale al proveedor', async () => {
    const factory = new SagaFactoryPorCuenta(new SagaAdapter(), new SagaAdapter());
    const b = montar(factory, undefined, { [CUENTA_VIGENTE]: '2026-06-01T00:00:00.000Z' });

    await expect(b.orders.createOrder(TENANT, USER, dto())).rejects.toBeInstanceOf(
      ProviderAccountChangedError,
    );

    expect(b.fila()).toBeUndefined();
    expect(factory.adapter.priceOffer).not.toHaveBeenCalled();
    expect(factory.adapter.createOrder).not.toHaveBeenCalled();
  });

  it('un proveedor que no opera por cuenta no la guarda, aunque diga con cuál vende', async () => {
    const factory = new SagaFactoryConCuenta(new SagaAdapter());
    const b = montar(factory);

    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.fila()?.['provider_account_id']).toBeUndefined();
    expect(b.consultas()).toEqual([]);
    expect(factory.adapter.createOrder).toHaveBeenCalledTimes(1);
  });

  it('consultar, verificar y cancelar una orden con cuenta salen con la de la orden', async () => {
    const vigente = new SagaAdapter(verificada);
    const factory = new SagaFactoryPorCuenta(vigente, new SagaAdapter(verificada));
    const b = montar(factory, ORDEN_CON_CUENTA);

    await b.orders.retrieveOrder(TENANT, filaDe(b));
    await b.orders.verifyCreationById(TENANT, 'order-1');
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(factory.resolveForOrder).toHaveBeenCalledWith(TENANT, 'order-1');
    expect(factory.deLaOrden.retrieveForDisplay).toHaveBeenCalledTimes(2);
    expect(factory.deLaOrden.cancelOrder).toHaveBeenCalledWith(PNR, { tenantId: TENANT });
    expect(b.fila()?.['status']).toBe('cancelled');
    // La cuenta vigente del tenant no participa: con ella el proveedor no reconoce la reserva.
    expect(factory.vigentes).toBe(0);
    expect(vigente.retrieveForDisplay).not.toHaveBeenCalled();
    expect(vigente.cancelOrder).not.toHaveBeenCalled();
  });

  it('la compensación selectiva también sale con la cuenta de la orden', async () => {
    const factory = new SagaFactoryPorCuenta(
      new SagaAdapter(verificada),
      new SagaAdapter(verificada),
    );
    const b = montar(factory, ORDEN_CON_CUENTA);

    await b.orders.runCompensation(TENANT, 'order-1', ['12'], USER);

    expect(factory.deLaOrden.cancelScopes).toEqual([{ itemIds: ['12'] }]);
    expect(factory.adapter.cancelScopes).toEqual([]);
    expect(factory.vigentes).toBe(0);
  });

  it('pagar, listar servicios y recotizar también salen con la cuenta de la orden', async () => {
    const factory = new SagaFactoryPorCuenta(new SagaAdapter(), new SagaAdapter());
    const b = montar(factory, ORDEN_CON_CUENTA);
    const fila = filaDe(b);

    await b.orders
      .payOrder(TENANT, 'order-1', fila, { type: 'Cash', amount: 100, currency: 'USD' }, USER)
      .catch(() => undefined);
    await b.orders.listServices(TENANT, fila).catch(() => undefined);
    await b.orders
      .reshopOrder(TENANT, fila, {} as Parameters<OrdersService['reshopOrder']>[2], USER)
      .catch(() => undefined);

    expect(factory.deLaOrden.payOrder).toHaveBeenCalledTimes(1);
    expect(factory.deLaOrden.listServices).toHaveBeenCalledTimes(1);
    expect(factory.deLaOrden.reshopWithTickets).toHaveBeenCalledTimes(1);
    expect(factory.adapter.payOrder).not.toHaveBeenCalled();
    expect(factory.adapter.listServices).not.toHaveBeenCalled();
    expect(factory.adapter.reshopWithTickets).not.toHaveBeenCalled();
    expect(factory.vigentes).toBe(0);
  });

  it('con la cuenta de la orden fuera de la red: 409 al consultar y al cancelar, sin claim ni llamada', async () => {
    const factory = new SagaFactoryPorCuenta(
      new SagaAdapter(verificada),
      new SagaAdapter(verificada),
    );
    factory.disponible = false;
    const b = montar(factory, ORDEN_CON_CUENTA);

    await expect(b.orders.retrieveOrder(TENANT, filaDe(b))).rejects.toBeInstanceOf(
      ProviderOrderAccountUnavailableError,
    );
    await expect(b.orders.cancelOrder(TENANT, 'order-1', PNR, USER)).rejects.toBeInstanceOf(
      ProviderOrderAccountUnavailableError,
    );

    // Nunca cae a la vigente, no deja una cancelación fallida en el historial y la orden sigue igual.
    expect(factory.vigentes).toBe(0);
    expect(factory.adapter.cancelOrder).not.toHaveBeenCalled();
    expect(factory.deLaOrden.cancelOrder).not.toHaveBeenCalled();
    expect(b.operaciones()).toEqual([]);
    expect(b.fila()?.['status']).toBe('confirmed');
  });

  it('una orden SIN cuenta guardada (anterior, o de otro proveedor) sigue con la vigente', async () => {
    const vigente = new SagaAdapter(verificada);
    const factory = new SagaFactoryPorCuenta(vigente, new SagaAdapter(verificada));
    const b = montar(factory, { ...ORDEN_CON_CUENTA, provider_account_id: null });

    await b.orders.retrieveOrder(TENANT, filaDe(b));
    await b.orders.cancelOrder(TENANT, 'order-1', PNR, USER);

    expect(factory.resolveForOrder).not.toHaveBeenCalled();
    expect(vigente.retrieveForDisplay).toHaveBeenCalledTimes(1);
    expect(vigente.cancelOrder).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Localizadores, documentos y plazo guardados en la reserva (0082)
// ---------------------------------------------------------------------------------------------

/** Doble del store: graba las lecturas, contesta con los cambios pedidos o falla. */
class TrackingQueGraba {
  readonly lecturas: { tenantId: string; orderId: string; read: FlightOrderRead }[] = [];
  falla: Error | undefined;
  cambios: FlightDocumentChanges = { added: 0, statusChanged: 0 };

  readonly recordRead = vi.fn(
    (tenantId: string, orderId: string, read: FlightOrderRead): Promise<FlightDocumentChanges> => {
      if (this.falla !== undefined) return Promise.reject(this.falla);
      this.lecturas.push({ tenantId, orderId, read });
      return Promise.resolve(this.cambios);
    },
  );

  asStore(): FlightOrderTrackingStore {
    return this as unknown as FlightOrderTrackingStore;
  }
}

const TIQUETE = '0457123456789';

/** Lo que una lectura de cierre de un vuelo emitido trae: localizador, tiquete y plazo. */
function vistaConSeguimiento(): OrderView {
  return {
    ...vistaViva(),
    airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
    ticketNumbers: [TIQUETE],
    documents: [
      {
        number: TIQUETE,
        kind: 'TICKET',
        status: 'ISSUED',
        travelerIndex: 0,
        providerStatusCode: 'TE',
      },
    ],
    ticketingDeadline: { date: '2026-09-08', time: '23:59', zone: 'PROVIDER_LOCAL' },
  };
}

const ORDEN_GUARDADA = { status: 'confirmed', provider_order_id: PNR };

/** `banco` con el store de seguimiento y nada más fuera de lo normal. */
function bancoConSeguimiento(
  opts: AdapterOptions,
  tracking: TrackingQueGraba,
  semilla?: Record<string, unknown>,
): Banco {
  return banco(opts, {}, semilla, {}, undefined, undefined, tracking.asStore());
}

describe('la reserva guarda localizadores, tiquetes y plazo de cada lectura (0082)', () => {
  it('la lectura de cierre de la creación queda guardada, y el alta de un tiquete es un evento con conteos', async () => {
    const tracking = new TrackingQueGraba();
    tracking.cambios = { added: 1, statusChanged: 0 };
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking);

    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'settled', status: 'confirmed' });
    expect(tracking.lecturas).toHaveLength(1);
    expect(tracking.lecturas[0]).toMatchObject({
      tenantId: TENANT,
      orderId: 'order-1',
      read: {
        airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
        documents: [{ number: TIQUETE, kind: 'TICKET', status: 'ISSUED', travelerIndex: 0 }],
        ticketingDeadline: { date: '2026-09-08', time: '23:59', zone: 'PROVIDER_LOCAL' },
      },
    });
    const evento = b.audit.first(ORDER_EVENTS.flightDocumentsChanged);
    expect(evento).toMatchObject({
      tenantId: TENANT,
      actorUserId: USER,
      aggregateId: 'order-1',
      payload: { provider: PROVEEDOR, source: 'verify', added: 1, statusChanged: 0 },
    });
    // Conteos, nunca números: el panel de red lo ve cualquier admin del subárbol.
    expect(JSON.stringify(evento)).not.toContain(TIQUETE);
  });

  it('sin cambios en los documentos no hay evento', async () => {
    const tracking = new TrackingQueGraba();
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking);

    await b.orders.createOrder(TENANT, USER, dto());

    expect(tracking.lecturas).toHaveLength(1);
    expect(b.audit.first(ORDER_EVENTS.flightDocumentsChanged)).toBeUndefined();
  });

  it('si guardar falla, la creación se cierra igual y confirmada', async () => {
    const tracking = new TrackingQueGraba();
    tracking.falla = new Error('flight_order_tracking no disponible');
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking);

    const { order, saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'settled', status: 'confirmed' });
    expect(order.status).toBe('confirmed');
    expect(b.audit.first(ORDER_EVENTS.verified)).toBeDefined();
    expect(b.audit.first(ORDER_EVENTS.flightDocumentsChanged)).toBeUndefined();
    expect(b.audit.first(ORDER_EVENTS.escalated)).toBeUndefined();
  });

  it('si el evento falla, la creación también se cierra', async () => {
    const tracking = new TrackingQueGraba();
    tracking.cambios = { added: 1, statusChanged: 0 };
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking);
    const emit = b.audit.emit.bind(b.audit);
    vi.spyOn(b.audit, 'emit').mockImplementation((event) =>
      event.eventType === ORDER_EVENTS.flightDocumentsChanged
        ? Promise.reject(new Error('domain_events no disponible'))
        : emit(event),
    );

    const { saga } = await b.orders.createOrder(TENANT, USER, dto());

    expect(saga).toMatchObject({ kind: 'settled', status: 'confirmed' });
  });

  it('una lectura de cierre que falló o que no encontró la reserva no guarda nada', async () => {
    const falla = new TrackingQueGraba();
    await bancoConSeguimiento({ viewThrows: new Error('timeout') }, falla).orders.createOrder(
      TENANT,
      USER,
      dto(),
    );
    expect(falla.recordRead).not.toHaveBeenCalled();

    const noEsta = new TrackingQueGraba();
    await bancoConSeguimiento(
      { view: { found: false, airlineLocators: [], warnings: [] } },
      noEsta,
    ).orders.createOrder(TENANT, USER, dto());
    expect(noEsta.recordRead).not.toHaveBeenCalled();
  });

  it('la verificación diferida guarda lo que leyó', async () => {
    const tracking = new TrackingQueGraba();
    tracking.cambios = { added: 0, statusChanged: 1 };
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking, ORDEN_GUARDADA);

    await b.orders.verifyCreationById(TENANT, 'order-1', USER);

    expect(tracking.lecturas.map((l) => l.orderId)).toEqual(['order-1']);
    expect(b.audit.first(ORDER_EVENTS.flightDocumentsChanged)?.payload).toEqual({
      provider: PROVEEDOR,
      source: 'verify',
      added: 0,
      statusChanged: 1,
    });
  });

  it('si guardar falla, la verificación diferida sigue y deja su evento', async () => {
    const tracking = new TrackingQueGraba();
    tracking.falla = new Error('flight_order_tracking no disponible');
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking, ORDEN_GUARDADA);

    await expect(b.orders.verifyCreationById(TENANT, 'order-1', USER)).resolves.toBeUndefined();
    expect(b.audit.first(ORDER_EVENTS.verified)).toBeDefined();
  });

  it('la consulta manual guarda y devuelve la misma lectura, aunque guardar falle', async () => {
    const tracking = new TrackingQueGraba();
    tracking.cambios = { added: 1, statusChanged: 0 };
    const b = bancoConSeguimiento({ view: vistaConSeguimiento() }, tracking, ORDEN_GUARDADA);
    const fila = b.fila() as unknown as OrderRow;

    await expect(b.orders.retrieveOrder(TENANT, fila, USER)).resolves.toEqual(
      vistaConSeguimiento(),
    );
    expect(tracking.lecturas).toHaveLength(1);
    expect(b.audit.first(ORDER_EVENTS.flightDocumentsChanged)?.payload).toMatchObject({
      source: 'retrieve',
    });

    tracking.falla = new Error('flight_order_tracking no disponible');
    await expect(b.orders.retrieveOrder(TENANT, fila, USER)).resolves.toEqual(
      vistaConSeguimiento(),
    );
  });

  it('un proveedor sin estados de documento (sólo ticketNumbers) los guarda como tiquetes sin confirmar', async () => {
    const tracking = new TrackingQueGraba();
    const b = bancoConSeguimiento(
      { view: { ...vistaViva(), ticketNumbers: [TIQUETE, 'NO-ES-UN-NUMERO'] } },
      tracking,
      ORDEN_GUARDADA,
    );

    await b.orders.retrieveOrder(TENANT, b.fila() as unknown as OrderRow, USER);

    expect(tracking.lecturas[0]?.read.documents).toEqual([
      { number: TIQUETE, kind: 'TICKET', status: 'UNKNOWN' },
    ]);
  });

  it('sin store (los dobles de otras suites) la lectura sigue igual', async () => {
    const b = banco({ view: vistaConSeguimiento() }, {}, ORDEN_GUARDADA);
    await expect(
      b.orders.retrieveOrder(TENANT, b.fila() as unknown as OrderRow, USER),
    ).resolves.toEqual(vistaConSeguimiento());
  });
});

// ---------------------------------------------------------------------------------------------
// SAB-16 — asientos al reservar, por la puerta del servicio
// ---------------------------------------------------------------------------------------------

/** Un tramo, cuatro asientos: 12A sin cargo, 12C sin cargo, 12D ocupado, 14B con cargo. */
function mapaDeAsientos(): SeatMap {
  const asiento = (column: string, amountMinor: number | null) => ({
    column,
    available: amountMinor !== null,
    characteristics: [],
    adultOnly: false,
    infantAllowed: true,
    offers:
      amountMinor === null
        ? []
        : [
            {
              passengerIndex: 0,
              price: { amountMinor, currency: 'USD' },
              offerRef: `oferta-${column}-${String(amountMinor)}`,
            },
          ],
  });
  return {
    segments: [
      {
        segmentRef: 0,
        legIndex: 0,
        changeOfGauge: false,
        displayOnly: false,
        cabins: [
          {
            cabin: 'economy',
            columns: ['A', 'B', 'C', 'D'],
            aisleAfter: ['B'],
            rows: [
              { number: 12, seats: [asiento('A', 0), asiento('C', 0), asiento('D', null)] },
              { number: 14, seats: [asiento('B', 4_500)] },
            ],
          },
        ],
      },
    ],
    warnings: [],
  };
}

function dtoConAsiento(row = 12, column = 'C'): CreateOrderDto {
  const base = dto();
  return {
    ...base,
    passengers: [{ ...PASAJERO_ADULTO, requestedTravelerIndex: 0 }],
    seats: [{ passengerIndex: 0, segmentRef: 0, legIndex: 0, row, column }],
  };
}

function bancoConAsientos(
  opts: AdapterOptions,
  caps: Partial<ProviderCapabilities>,
  environment?: ProviderEnvironment,
): Banco {
  const adapter = new SagaAdapter(opts);
  const registry = new FlightProviderRegistry([new SagaFactory(adapter, caps, environment)], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const { db, fila, operaciones } = dbFalsa();
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService();
  return {
    orders: new OrdersService(
      db,
      registry,
      queue.asService(),
      {} as unknown as AgentCarsProviderFactory,
      audit.asService(),
      PRICING_SIN_REGLAS,
    ),
    adapter,
    audit,
    queue,
    fila,
    operaciones,
  };
}

describe('SAB-16 — asientos al reservar', () => {
  it('sin la capacidad del proveedor: 400 antes de abrir la orden, sin tocar al proveedor', async () => {
    const b = bancoConAsientos({ seatMap: mapaDeAsientos() }, {});
    await expect(b.orders.createOrder(TENANT, USER, dtoConAsiento())).rejects.toBeInstanceOf(
      SeatSelectionNotAvailableError,
    );
    expect(b.fila()).toBeUndefined();
    expect(b.adapter.priceOffer).not.toHaveBeenCalled();
    expect(b.adapter.getSeatMap).not.toHaveBeenCalled();
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
  });

  it('con la capacidad pero un adapter que no pinta el mapa: tampoco', async () => {
    const b = bancoConAsientos({}, { seatMap: true });
    await expect(b.orders.createOrder(TENANT, USER, dtoConAsiento())).rejects.toBeInstanceOf(
      SeatSelectionNotAvailableError,
    );
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
  });

  it('el mapa se lee UNA vez, con la oferta revalidada, y el asiento viaja con su oferta', async () => {
    const b = bancoConAsientos(
      {
        seatMap: mapaDeAsientos(),
        revalidated: (offer) => ({ ...offer, provider: { ...offer.provider, offerRef: 'REVAL' } }),
      },
      { seatMap: true },
    );
    await b.orders.createOrder(TENANT, USER, dtoConAsiento());

    const getSeatMap = b.adapter.getSeatMap as ReturnType<typeof vi.fn>;
    expect(getSeatMap).toHaveBeenCalledTimes(1);
    const [ofertaDelMapa] = getSeatMap.mock.calls[0] as [Offer];
    expect(ofertaDelMapa.provider.offerRef).toBe('REVAL');
    // Revalidar, leer el mapa y reservar, en ese orden.
    expect(b.adapter.priceOffer.mock.invocationCallOrder[0]).toBeLessThan(
      getSeatMap.mock.invocationCallOrder[0]!,
    );
    expect(getSeatMap.mock.invocationCallOrder[0]).toBeLessThan(
      b.adapter.createOrder.mock.invocationCallOrder[0]!,
    );
    const [request] = b.adapter.createOrder.mock.calls[0]!;
    expect(request.seats).toEqual([
      {
        passengerIndex: 0,
        segmentRef: 0,
        legIndex: 0,
        row: 12,
        column: 'C',
        offerRef: 'oferta-C-0',
      },
    ]);
    expect(b.audit.first(ORDER_EVENTS.createRequested)?.payload).toMatchObject({ seats: 1 });
  });

  it('«El asiento 12D ya no está disponible»: 400, no sale nada y la cotización queda libre', async () => {
    const b = bancoConAsientos({ seatMap: mapaDeAsientos() }, { seatMap: true });
    await expect(b.orders.createOrder(TENANT, USER, dtoConAsiento(12, 'D'))).rejects.toThrow(
      new BadRequestException('El asiento 12D ya no está disponible. Elige otro.'),
    );
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
    expect(b.fila()?.['status']).toBe('failed');
    // La clave de la cotización se libera: el vendedor elige otro asiento y vuelve a reservar.
    expect(b.fila()?.['create_request_key']).toBeNull();
    expect(b.audit.first(ORDER_EVENTS.createRequested)).toBeUndefined();
  });

  it('un asiento con cargo: 400 con el motivo, sin reservar', async () => {
    const b = bancoConAsientos({ seatMap: mapaDeAsientos() }, { seatMap: true });
    await expect(b.orders.createOrder(TENANT, USER, dtoConAsiento(14, 'B'))).rejects.toThrow(
      'Los asientos con cargo todavía no se pueden reservar desde aquí.',
    );
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
  });

  it('sin asientos nada cambia: ni la capacidad ni el mapa se consultan', async () => {
    const b = bancoConAsientos({ seatMap: mapaDeAsientos() }, {});
    await b.orders.createOrder(TENANT, USER, dto());
    expect(b.adapter.getSeatMap).not.toHaveBeenCalled();
    const [request] = b.adapter.createOrder.mock.calls[0]!;
    expect(request).not.toHaveProperty('seats');
  });

  it('una reserva de prueba con asiento sigue marcada de prueba, como hoy', async () => {
    const b = bancoConAsientos({ seatMap: mapaDeAsientos() }, { seatMap: true }, 'test');
    await b.orders.createOrder(TENANT, USER, dtoConAsiento());

    expect(b.audit.first(ORDER_EVENTS.createRequested)?.payload).toMatchObject({
      environment: 'test',
      seats: 1,
    });
    const [request] = b.adapter.createOrder.mock.calls[0]!;
    expect(request.offer.provider.environment).toBe('test');
  });
});
