import { describe, expect, it, vi } from 'vitest';
import type { Offer } from '@sales-travel/canonical';
import type { Passenger } from '@sales-travel/domain';
import type { DatabaseService } from '../database/database.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { ProviderNotAvailableError } from '../providers/provider.types.js';
import {
  StubProviderFactory,
  type StubFactoryOptions,
} from '../providers/__fixtures__/stub-provider.factory.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { ORDER_EVENTS } from './order-events.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';

/**
 * Enrutado de la reserva por proveedor (bug R-07, la mitad de las órdenes).
 *
 * `createOrder` llamaba siempre al adapter del único proveedor inyectado y estampaba su code
 * literal en la fila `orders`, mirara lo que mirara la oferta. Con dos proveedores eso es
 * mandar a reservar una oferta a quien no la emitió, y dejar la reserva atribuida al
 * proveedor equivocado — con lo que toda la post-venta sale luego por el adapter que no es.
 *
 * El segundo proveedor es un stub ANÓNIMO in-repo.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const QUOTATION_ID = '33333333-3333-4333-8333-333333333333';
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
    number: '123456789',
    issuingCountryCode: 'CO',
  },
};

function ofertaDe(code: string): Offer {
  return {
    id: `${code}-offer`,
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: code, offerRef: `${code}-REF` },
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

function dto(code: string): CreateOrderDto {
  return {
    offer: ofertaDe(code),
    searchCriteria: {
      origin: 'BOG',
      destination: 'LIM',
      departureDate: '2026-09-10',
      paxCount: { adults: 1, children: 0, infants: 0 },
      cabin: 'economy',
      currency: 'USD',
    },
    passengers: [PASAJERO_ADULTO],
    contactInfo: { email: 'a@b.test', phone: '+573000000000' },
    quotationId: QUOTATION_ID,
  };
}

/**
 * Doble de la base: encadena como Kysely lo justo para `createOrder` y guarda los valores del
 * INSERT, que es lo que este test necesita mirar.
 */
function dbFalsa(): {
  db: DatabaseService;
  insertado: () => Record<string, unknown> | undefined;
  insertadoInicial: () => Record<string, unknown> | undefined;
} {
  // Los valores se guardan POR TABLA. Antes se guardaba el último INSERT a secas, y desde que la
  // creación registra su lectura de cierre en `order_operations` ese último INSERT ya no es el de
  // `orders`: el doble medía la tabla equivocada y los tests pasaban a hablar de otra cosa.
  const porTabla = new Map<string, Record<string, unknown>>();
  // Lo que llevó el PRIMER insert de cada tabla, antes de que la consolidación lo pise: la fila
  // `pending` que queda si el proceso muere entre el claim y el proveedor.
  const iniciales = new Map<string, Record<string, unknown>>();

  const insertEn = (tabla: string) => {
    const insert = {
      values: (v: Record<string, unknown>) => {
        porTabla.set(tabla, v);
        if (!iniciales.has(tabla)) iniciales.set(tabla, v);
        return insert;
      },
      returningAll: () => insert,
      execute: () => Promise.resolve([]),
      executeTakeFirst: () => Promise.resolve({ id: 'order-1', ...porTabla.get(tabla) }),
      executeTakeFirstOrThrow: () => Promise.resolve({ id: 'order-1', ...porTabla.get(tabla) }),
    };
    return insert;
  };
  const select = {
    select: () => select,
    selectAll: () => select,
    where: () => select,
    forUpdate: () => select,
    executeTakeFirst: () => Promise.resolve({ id: QUOTATION_ID, tenant_id: TENANT }),
    executeTakeFirstOrThrow: () =>
      Promise.resolve({ id: QUOTATION_ID, tenant_id: TENANT, next: 1 }),
  };
  let updateValues: Record<string, unknown> = {};
  const update = {
    set: (values: Record<string, unknown>) => {
      updateValues = values;
      return update;
    },
    where: () => update,
    returningAll: () => update,
    execute: () => {
      porTabla.set('orders', { ...porTabla.get('orders'), ...updateValues });
      return Promise.resolve([{}]);
    },
    executeTakeFirst: () => {
      porTabla.set('orders', { ...porTabla.get('orders'), ...updateValues });
      return Promise.resolve({ id: 'order-1', ...porTabla.get('orders') });
    },
  };
  const trx = {
    selectFrom: () => select,
    insertInto: (tabla: string) => insertEn(tabla),
    updateTable: () => update,
  };

  const db = {
    withTenant: <T>(_tenantId: string, cb: (trx: unknown) => Promise<T>) => cb(trx),
  } as unknown as DatabaseService;

  return {
    db,
    insertado: () => porTabla.get('orders'),
    insertadoInicial: () => iniciales.get('orders'),
  };
}

function banco(
  codes: string[],
  opciones: Readonly<Record<string, Omit<StubFactoryOptions, 'code'>>> = {},
): {
  orders: OrdersService;
  factories: Map<string, StubProviderFactory>;
  insertado: () => Record<string, unknown> | undefined;
  insertadoInicial: () => Record<string, unknown> | undefined;
  audit: RecordingAuditService;
} {
  const factories = new Map(
    codes.map((code) => [code, new StubProviderFactory({ ...opciones[code], code })]),
  );
  const registry = new FlightProviderRegistry([...factories.values()], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const { db, insertado, insertadoInicial } = dbFalsa();
  const audit = new RecordingAuditService();

  const orders = new OrdersService(
    db,
    registry,
    new RecordingQueueService().asService(),
    {} as unknown as AgentCarsProviderFactory,
    audit.asService(),
    PRICING_SIN_REGLAS,
  );

  return { orders, factories, insertado, insertadoInicial, audit };
}

/** Una orden ya hecha con `provider`, sin cuenta guardada: su post-venta sale con la vigente. */
function ordenGuardada(provider: string) {
  return { id: 'order-1', provider, provider_order_id: 'PNR123', provider_account_id: null };
}

/** El `selected_offer` tal como lo escribió el servicio (JSON, como en la columna JSONB). */
function guardada(fila: Record<string, unknown> | undefined): Offer {
  const raw = fila?.['selected_offer'];
  if (typeof raw !== 'string') throw new Error('la fila no tiene selected_offer serializado');
  return JSON.parse(raw) as Offer;
}

describe('OrdersService.createOrder — enrutado por proveedor', () => {
  it('rechaza paxCount inconsistente antes de resolver o tocar el proveedor', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    input.passengers = [];
    const factory = b.factories.get('beta-air')!;
    const adapter = factory.adapterFor(TENANT);

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(
      /pasajeros no coinciden/i,
    );

    expect(factory.resolveCalls).toEqual([]);
    expect(adapter.priceOffer).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('rechaza moneda inconsistente antes de resolver o tocar el proveedor', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    input.searchCriteria = { ...input.searchCriteria, currency: 'COP' };
    const factory = b.factories.get('beta-air')!;
    const adapter = factory.adapterFor(TENANT);

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(/moneda.+no coincide/i);

    expect(factory.resolveCalls).toEqual([]);
    expect(adapter.priceOffer).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: 'ruta',
      mutate: (input: CreateOrderDto) => {
        const outbound = input.offer.itineraries![0]!;
        input.offer = {
          ...input.offer,
          itineraries: [
            {
              ...outbound,
              segments: outbound.segments.map((segment, index) =>
                index === outbound.segments.length - 1
                  ? { ...segment, destination: 'MDE' }
                  : segment,
              ),
            },
          ],
        };
      },
    },
    {
      caseName: 'fecha',
      mutate: (input: CreateOrderDto) => {
        const outbound = input.offer.itineraries![0]!;
        input.offer = {
          ...input.offer,
          itineraries: [
            {
              ...outbound,
              segments: outbound.segments.map((segment, index) =>
                index === 0 ? { ...segment, departureAt: '2026-09-11T09:00:00-05:00' } : segment,
              ),
            },
          ],
        };
      },
    },
    {
      caseName: 'ida-vuelta',
      mutate: (input: CreateOrderDto) => {
        input.searchCriteria = { ...input.searchCriteria, returnDate: '2026-09-20' };
      },
    },
  ])('rechaza $caseName inconsistente antes de resolver el proveedor', async ({ mutate }) => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    mutate(input);
    const factory = b.factories.get('beta-air')!;
    const adapter = factory.adapterFor(TENANT);

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(
      /ruta.+fechas.+tipo de viaje/i,
    );

    expect(factory.resolveCalls).toEqual([]);
    expect(adapter.priceOffer).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('rechaza una oferta de vuelo sin itinerario antes de resolver el proveedor', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    const { itineraries: _missing, ...offerWithoutItinerary } = input.offer;
    input.offer = offerWithoutItinerary;
    const factory = b.factories.get('beta-air')!;
    const adapter = factory.adapterFor(TENANT);

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(
      /sin itinerario|no contiene/i,
    );

    expect(factory.resolveCalls).toEqual([]);
    expect(adapter.priceOffer).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('revalida antes del write y pasa los criterios reales —no la oferta— a createOrder', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);

    await b.orders.createOrder(TENANT, USER, input);

    expect(adapter.priceOffer).toHaveBeenCalledWith(input.offer, input.searchCriteria, {
      tenantId: TENANT,
    });
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ criteria: input.searchCriteria }),
      { tenantId: TENANT, requestId: 'order-1' },
    );
  });

  it('si el precio cambió no crea ni persiste una reserva silenciosamente', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
    adapter.priceOffer.mockResolvedValue({
      offer: {
        ...input.offer,
        total: { ...input.offer.total, amountMinor: input.offer.total.amountMinor + 10_000 },
      },
      priceChanged: true,
      warnings: [],
    });

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(/precio cambió/i);
    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(b.insertado()).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: 'La creación no se envió al proveedor.',
    });
  });

  it.each(['fecha-invalida', '2000-01-01T00:00:00.000Z'])(
    'una oferta revalidada expirada/inválida (%s) no llega a createOrder',
    async (expiresAt) => {
      const b = banco(['beta-air']);
      const input = dto('beta-air');
      const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
      adapter.priceOffer.mockResolvedValue({
        offer: { ...input.offer, expiresAt },
        priceChanged: false,
        warnings: [],
      });

      await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(
        /venció|vigencia válida/i,
      );
      expect(adapter.createOrder).not.toHaveBeenCalled();
      expect(b.insertado()).toMatchObject({ status: 'failed', create_request_key: null });
    },
  );

  it('descarta el markup enviado por el navegador y persiste el total recalculado', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    input.offer = {
      ...input.offer,
      pricing: {
        costMinor: 1,
        finalMinor: 1,
        ownMarkupMinor: 0,
        currency: 'USD',
      },
    };

    await b.orders.createOrder(TENANT, USER, input);
    const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
    const request = adapter.createOrder.mock.calls[0]?.[0];

    expect(b.insertado()?.['total_amount']).toBe(input.offer.total.amountMinor);
    expect(request?.offer).not.toHaveProperty('pricing');
    expect(adapter.createOrder).toHaveBeenCalledWith(request, {
      tenantId: TENANT,
      requestId: 'order-1',
    });
  });

  it('si Flight Check cambia la familia o fare basis exige una nueva aceptación', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    input.offer = {
      ...input.offer,
      fareComponents: [
        {
          segmentRefs: [0],
          fareBasisCode: 'BASIC1',
          bookingClasses: ['U'],
          brand: { code: 'BASIC', name: 'Basic' },
        },
      ],
    };
    const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
    adapter.priceOffer.mockResolvedValue({
      offer: {
        ...input.offer,
        fareComponents: [
          {
            segmentRefs: [0],
            fareBasisCode: 'FLEX1',
            bookingClasses: ['M'],
            brand: { code: 'FLEX', name: 'Flex' },
          },
        ],
      },
      priceChanged: false,
      warnings: [],
    });

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(/familia/i);
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('si Flight Check cambia sólo la cabina de la familia también exige nueva aceptación', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    input.offer = {
      ...input.offer,
      fareComponents: [
        {
          segmentRefs: [0],
          fareBasisCode: 'FLEX1',
          bookingClasses: ['M'],
          cabin: 'economy',
          brand: { code: 'FLEX', name: 'Flex' },
        },
      ],
    };
    const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
    adapter.priceOffer.mockResolvedValue({
      offer: {
        ...input.offer,
        fareComponents: [
          {
            ...input.offer.fareComponents![0]!,
            cabin: 'premium_economy',
          },
        ],
      },
      priceChanged: false,
      warnings: [],
    });

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(/familia/i);
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('una oferta legacy también exige aceptación si cambia fareFamily', async () => {
    const b = banco(['beta-air']);
    const input = dto('beta-air');
    input.offer = {
      ...input.offer,
      fareFamily: { name: '  Basic ', cabin: 'economy' },
    };
    const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
    adapter.priceOffer.mockResolvedValue({
      offer: {
        ...input.offer,
        fareFamily: { name: 'Flex', cabin: 'economy' },
      },
      priceChanged: false,
      warnings: [],
    });

    await expect(b.orders.createOrder(TENANT, USER, input)).rejects.toThrow(/familia/i);
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('reserva contra el adapter que EMITIÓ la oferta, no contra el primero de la lista', async () => {
    const b = banco(['alfa-air', 'beta-air']);

    await b.orders.createOrder(TENANT, USER, dto('beta-air'));

    expect(b.factories.get('beta-air')!.adapterFor(TENANT).createOrder).toHaveBeenCalledTimes(1);
    expect(b.factories.get('alfa-air')!.adapterFor(TENANT).createOrder).not.toHaveBeenCalled();
  });

  it('la fila `orders` guarda el proveedor de la oferta, no un code literal', async () => {
    const b = banco(['alfa-air', 'beta-air']);

    await b.orders.createOrder(TENANT, USER, dto('beta-air'));

    expect(b.insertado()?.['provider']).toBe('beta-air');
    expect(b.insertado()?.['provider_order_id']).toBe('beta-air-PNR');
  });

  it('una oferta de un proveedor no habilitado es 400 y NO deja fila de orden', async () => {
    const b = banco(['alfa-air']);

    await expect(b.orders.createOrder(TENANT, USER, dto('fantasma'))).rejects.toBeInstanceOf(
      ProviderNotAvailableError,
    );
    expect(b.insertado()).toBeUndefined();
  });

  it('la post-venta sale por el proveedor de la reserva, no por uno fijo', async () => {
    const b = banco(['alfa-air', 'beta-air']);

    await b.orders.retrieveFromProvider(TENANT, ordenGuardada('beta-air'));

    const beta = b.factories.get('beta-air')!.adapterFor(TENANT);
    expect(beta.retrieveForDisplay).toHaveBeenCalledWith('PNR123', { tenantId: TENANT });
    expect(
      b.factories.get('alfa-air')!.adapterFor(TENANT).retrieveForDisplay,
    ).not.toHaveBeenCalled();
  });

  describe('reserva contra una cuenta de pruebas del proveedor', () => {
    function conEntorno(offer: Offer, environment: 'test' | 'live'): Offer {
      return { ...offer, provider: { ...offer.provider, environment } };
    }

    it('el navegador manda `live` y la cuenta es de pruebas: la orden se guarda `test`', async () => {
      const b = banco(['beta-air'], { 'beta-air': { providerEnvironment: 'test' } });
      const input = dto('beta-air');
      input.offer = conEntorno(input.offer, 'live');

      await b.orders.createOrder(TENANT, USER, input);

      // La fila `pending` del claim ya nace marcada, y la consolidación no la desmarca.
      expect(guardada(b.insertadoInicial()).provider.environment).toBe('test');
      expect(guardada(b.insertado()).provider.environment).toBe('test');
      // Lo que llega al adapter también: el ACL reserva sobre la oferta ya marcada.
      const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
      expect(adapter.createOrder.mock.calls[0]?.[0].offer.provider.environment).toBe('test');
      expect(b.audit.first(ORDER_EVENTS.createRequested)?.payload).toMatchObject({
        environment: 'test',
      });
    });

    it('el navegador no puede desmarcarla quitando el campo', async () => {
      const b = banco(['beta-air'], { 'beta-air': { providerEnvironment: 'test' } });

      await b.orders.createOrder(TENANT, USER, dto('beta-air'));

      expect(guardada(b.insertado()).provider.environment).toBe('test');
    });

    it('un ACL que construye su respuesta sin la marca no la borra de la orden', async () => {
      const b = banco(['beta-air'], { 'beta-air': { providerEnvironment: 'test' } });
      const input = dto('beta-air');
      const adapter = b.factories.get('beta-air')!.adapterFor(TENANT);
      adapter.priceOffer.mockResolvedValueOnce({
        offer: { ...input.offer, provider: { name: 'beta-air', offerRef: 'beta-air-REF' } },
        priceChanged: false,
        warnings: [],
      });

      await b.orders.createOrder(TENANT, USER, input);

      expect(guardada(b.insertado()).provider.environment).toBe('test');
    });

    it('con una cuenta real, un `test` del navegador no marca la orden', async () => {
      const b = banco(['beta-air'], { 'beta-air': { providerEnvironment: 'live' } });
      const input = dto('beta-air');
      input.offer = conEntorno(input.offer, 'test');

      await b.orders.createOrder(TENANT, USER, input);

      expect(guardada(b.insertadoInicial()).provider).not.toHaveProperty('environment');
      expect(guardada(b.insertado()).provider).not.toHaveProperty('environment');
      expect(b.audit.first(ORDER_EVENTS.createRequested)?.payload).toMatchObject({
        environment: 'live',
      });
    });
  });

  it('una reserva sin proveedor asociado no se manda a ciegas a ningún adapter', async () => {
    const b = banco(['alfa-air']);
    const espia = vi.spyOn(b.factories.get('alfa-air')!, 'resolveForTenant');

    await expect(b.orders.retrieveFromProvider(TENANT, ordenGuardada(''))).rejects.toThrow(
      /no tiene proveedor/,
    );
    expect(espia).not.toHaveBeenCalled();
  });
});
