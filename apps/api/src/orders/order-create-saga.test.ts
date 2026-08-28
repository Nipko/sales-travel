import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type {
  OrderCancelResult,
  OrderCreateRequest,
  OrderCreateResult,
  OrderView,
  Passenger,
  SearchContext,
} from '@sales-travel/domain';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type {
  CallPolicy,
  FlightProviderAdapter,
  OrderCancelAudit,
  OrderCancelScope,
  OrderCreateAudit,
  ProviderCapabilities,
  ProviderVertical,
  TenantAdapter,
  TenantProviderFactory,
} from '../providers/provider.types.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { ORDER_EVENTS } from './order-events.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';
import { runPostSaleJob } from './post-sale.worker.js';

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
  /** Los ámbitos con los que se pidió cancelar, en orden. */
  readonly cancelScopes: (OrderCancelScope | undefined)[] = [];

  constructor(private readonly opts: AdapterOptions = {}) {
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
    Promise.resolve({ offer, priceChanged: false, warnings: [] }),
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
    return Promise.resolve({ adapter: this.adapter, credentialSource: 'own' });
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
}

/** Doble de la base: guarda por tabla y aplica los UPDATE, que es lo que el saga mira. */
function dbFalsa(
  semilla?: Record<string, unknown>,
  options: FakeDbOptions = {},
): {
  db: DatabaseService;
  fila: () => Record<string, unknown> | undefined;
  operaciones: () => Record<string, unknown>[];
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
        throw Object.assign(new Error('duplicate pending cancel'), { code: '23505' });
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
  const trx = {
    selectFrom: (tabla: string) => selectEn(tabla),
    insertInto: (tabla: string) => insertEn(tabla),
    updateTable: (tabla: string) => updateEn(tabla),
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
): Banco {
  const adapter = new SagaAdapter(opts);
  const registry = new FlightProviderRegistry([new SagaFactory(adapter, caps)], {
    isEnabledForTenant: () => Promise.resolve(false),
  });
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
      },
    ],
    compensation: { cancellableItemIds: ['12'] },
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
  });

  it('un PARTIAL no se persiste como confirmado aunque haya PNR', async () => {
    const b = banco({ created: parcial() });
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

    expect(saga).toEqual({
      kind: 'escalate',
      reason: 'partial-without-essential-failure',
      status: 'pending',
    });
    // Las dos formas de perder el vuelo: cancelarlo aquí, o encolar una compensación que lo
    // cancele dentro de un minuto. Ninguna ocurre —y el proveedor había declarado el vuelo
    // cancelable, así que la protección no viene de que la lista llegara vacía.
    expect(b.queue.compensations).toEqual([]);
    expect(b.adapter.cancelOrder).not.toHaveBeenCalled();
  });

  it('y el caso ESCALA: sin reintento automático, porque lo tiene que ver una persona', async () => {
    // Un asiento no se recupera solo. Lo que hace falta es alguien que pida otro, o que pregunte
    // al cliente si quiere la reserva así — decisiones que ninguna cola puede tomar.
    const b = banco({ created: parcial() });
    await b.orders.createOrder(TENANT, USER, dto());

    const escalado = b.audit.first(ORDER_EVENTS.escalated);
    expect(escalado?.payload).toMatchObject({
      reason: 'partial-without-essential-failure',
      outcome: 'PARTIAL',
      queued: false,
    });
    expect(b.queue.verifications).toEqual([]);
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
      isEnabledForTenant: () => Promise.resolve(false),
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

    expect(b.queue.cancels).toEqual([{ tenantId: TENANT, orderId: 'order-1', type: 'cancel' }]);
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

describe('runPostSaleJob — el runner enruta, no decide', () => {
  function servicioEspiado(): {
    orders: OrdersService;
    runCancelById: ReturnType<typeof vi.fn>;
    verifyCreationById: ReturnType<typeof vi.fn>;
    runCompensation: ReturnType<typeof vi.fn>;
  } {
    const runCancelById = vi.fn(() => Promise.resolve());
    const verifyCreationById = vi.fn(() => Promise.resolve());
    const runCompensation = vi.fn(() => Promise.resolve());
    return {
      orders: { runCancelById, verifyCreationById, runCompensation } as unknown as OrdersService,
      runCancelById,
      verifyCreationById,
      runCompensation,
    };
  }

  it('enruta la cancelación', async () => {
    const e = servicioEspiado();
    await runPostSaleJob(e.orders, 'cancel', { tenantId: TENANT, orderId: 'o1', type: 'cancel' });
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
      runPostSaleJob(e.orders, 'inventado', { tenantId: TENANT, orderId: 'o1', type: 'cancel' }),
    ).rejects.toThrow(/desconocido/);
  });
});

describe('enrutado — ninguna oferta sale por el adapter de otro proveedor', () => {
  it('el saga usa el proveedor de la OFERTA para crear Y para verificar', async () => {
    const otro = new StubProviderFactory({ code: 'otro-air' });
    const mio = new SagaAdapter();
    const registry = new FlightProviderRegistry([new SagaFactory(mio), otro], {
      isEnabledForTenant: () => Promise.resolve(false),
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
