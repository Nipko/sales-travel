import { describe, expect, it, vi } from 'vitest';
import type { Offer } from '@sales-travel/canonical';
import type { Passenger } from '@sales-travel/domain';
import type { DatabaseService } from '../database/database.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { ProviderNotAvailableError } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
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

function ofertaDe(code: string): Offer {
  return {
    id: `${code}-offer`,
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: code, offerRef: `${code}-REF` },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
  };
}

function dto(code: string): CreateOrderDto {
  return {
    offer: ofertaDe(code),
    searchCriteria: { origin: 'BOG', destination: 'LIM' },
    passengers: [] as Passenger[],
    contactInfo: { email: 'a@b.test', phone: '+573000000000' },
  };
}

/**
 * Doble de la base: encadena como Kysely lo justo para `createOrder` y guarda los valores del
 * INSERT, que es lo que este test necesita mirar.
 */
function dbFalsa(): { db: DatabaseService; insertado: () => Record<string, unknown> | undefined } {
  // Los valores se guardan POR TABLA. Antes se guardaba el último INSERT a secas, y desde que la
  // creación registra su lectura de cierre en `order_operations` ese último INSERT ya no es el de
  // `orders`: el doble medía la tabla equivocada y los tests pasaban a hablar de otra cosa.
  const porTabla = new Map<string, Record<string, unknown>>();

  const insertEn = (tabla: string) => {
    const insert = {
      values: (v: Record<string, unknown>) => {
        porTabla.set(tabla, v);
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
    executeTakeFirst: () => Promise.resolve(undefined),
    executeTakeFirstOrThrow: () => Promise.resolve({ next: 1 }),
  };
  const update = {
    set: () => update,
    where: () => update,
    returningAll: () => update,
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(undefined),
  };
  const trx = {
    selectFrom: () => select,
    insertInto: (tabla: string) => insertEn(tabla),
    updateTable: () => update,
  };

  const db = {
    withTenant: <T>(_tenantId: string, cb: (trx: unknown) => Promise<T>) => cb(trx),
  } as unknown as DatabaseService;

  return { db, insertado: () => porTabla.get('orders') };
}

function banco(codes: string[]): {
  orders: OrdersService;
  factories: Map<string, StubProviderFactory>;
  insertado: () => Record<string, unknown> | undefined;
} {
  const factories = new Map(codes.map((code) => [code, new StubProviderFactory({ code })]));
  const registry = new FlightProviderRegistry([...factories.values()], {
    isEnabledForTenant: () => Promise.resolve(false),
  });
  const { db, insertado } = dbFalsa();

  const orders = new OrdersService(
    db,
    registry,
    new RecordingQueueService().asService(),
    {} as unknown as AgentCarsProviderFactory,
    new RecordingAuditService().asService(),
  );

  return { orders, factories, insertado };
}

describe('OrdersService.createOrder — enrutado por proveedor', () => {
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

    await b.orders.retrieveFromProvider(TENANT, 'PNR123', 'beta-air');

    const beta = b.factories.get('beta-air')!.adapterFor(TENANT);
    expect(beta.retrieveForDisplay).toHaveBeenCalledWith('PNR123', { tenantId: TENANT });
    expect(
      b.factories.get('alfa-air')!.adapterFor(TENANT).retrieveForDisplay,
    ).not.toHaveBeenCalled();
  });

  it('una reserva sin proveedor asociado no se manda a ciegas a ningún adapter', async () => {
    const b = banco(['alfa-air']);
    const espia = vi.spyOn(b.factories.get('alfa-air')!, 'resolveForTenant');

    await expect(b.orders.retrieveFromProvider(TENANT, 'PNR123', '')).rejects.toThrow(
      /no tiene proveedor/,
    );
    expect(espia).not.toHaveBeenCalled();
  });
});
