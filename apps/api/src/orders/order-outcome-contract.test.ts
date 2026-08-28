import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type {
  OrderCreateResult,
  OrderForModification,
  OrderView,
  Passenger,
  ProviderIssue,
} from '@sales-travel/domain';
import type { BrandingService } from '../branding/branding.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { FlightProviderAdapter, ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';

/**
 * El desenlace de una reserva no es un booleano (RF-08, `docs/sabre/04-create-booking.md` §5.4).
 *
 * `errorHandlingPolicy` es un parámetro de ENTRADA de `createBooking`
 * (`booking-management-v1.yml:698`, 8 valores, seis de ellos `DO_NOT_HALT_ON_*`): el éxito
 * parcial es un modo que elegimos ANTES de llamar, no una anomalía que se detecta después. Una
 * reserva con el vuelo dentro y el asiento fuera marcada como confirmada es una mentira que se
 * descubre en el mostrador, y estos tests son lo que impide que vuelva.
 *
 * Todo entra por la PUERTA PÚBLICA: `OrdersService.createOrder` (lo que se INSERTA en `orders`)
 * y `OrdersController.create` (lo que sale por HTTP). Nada llama a funciones internas.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROVEEDOR = 'stub-air';
const QUOTATION_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Un número de documento: PII que el proveedor nos devuelve en `fieldValue` tal cual se la mandamos. */
const DOCUMENTO_DEL_PASAJERO = 'AB1234567';
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
    // Distinto del sentinel que el proveedor devuelve en `fieldValue`: la respuesta de creación
    // sí incluye al pasajero de la orden, pero nunca debe copiar el valor libre de la incidencia.
    number: 'CC999999',
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

function dto(): CreateOrderDto {
  return {
    offer: ofertaDe(PROVEEDOR),
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

/** Doble de la base que guarda los valores del INSERT: es lo que estos tests miran. */
function dbFalsa(): { db: DatabaseService; insertado: () => Record<string, unknown> | undefined } {
  // Los valores se guardan POR TABLA. Antes se guardaba el último INSERT a secas, y desde que la
  // creación registra su lectura de cierre en `order_operations` ese último INSERT ya no es el de
  // `orders`: el doble medía la tabla equivocada y los tests pasaban a hablar de otra cosa.
  const porTabla = new Map<string, Record<string, unknown>>();

  const filaLeida = (tabla: string): Record<string, unknown> => ({
    id: 'order-1',
    order_number: 1,
    total_amount: 100_000,
    currency: 'USD',
    ...porTabla.get(tabla),
    // Postgres devuelve JSONB ya parseado; el INSERT manda el string de `JSON.stringify`.
    // El doble reproduce la LECTURA, que es lo que el controlador recibe de verdad.
    contact_info: { email: 'pasajero@ejemplo.test' },
  });

  const insertEn = (tabla: string) => {
    const insert = {
      values: (v: Record<string, unknown>) => {
        porTabla.set(tabla, v);
        return insert;
      },
      returningAll: () => insert,
      execute: () => Promise.resolve([]),
      executeTakeFirst: () => Promise.resolve(filaLeida(tabla)),
      executeTakeFirstOrThrow: () => Promise.resolve(filaLeida(tabla)),
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
  const update = {
    set: (v: Record<string, unknown>) => {
      porTabla.set('orders', { ...porTabla.get('orders'), ...v });
      return update;
    },
    where: () => update,
    returningAll: () => update,
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(filaLeida('orders')),
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

interface Banco {
  orders: OrdersService;
  adapter: FlightProviderAdapter;
  insertado: () => Record<string, unknown> | undefined;
}

function banco(resultado: OrderCreateResult): Banco {
  const factory = new StubProviderFactory({ code: PROVEEDOR });
  const registry = new FlightProviderRegistry([factory], {
    isEnabledForTenant: () => Promise.resolve(false),
  });
  const { db, insertado } = dbFalsa();

  const adapter = factory.adapterFor(TENANT);
  adapter.createOrder.mockResolvedValue(resultado);

  const orders = new OrdersService(
    db,
    registry,
    new RecordingQueueService().asService(),
    {} as unknown as AgentCarsProviderFactory,
    new RecordingAuditService().asService(),
    PRICING_SIN_REGLAS,
  );

  return { orders, adapter, insertado };
}

function resultado(over: Partial<OrderCreateResult>): OrderCreateResult {
  return { outcome: 'CONFIRMED', pnr: 'ABC123', items: [], issues: [], ...over };
}

/** El PARTIAL de verdad: vuelo dentro, asiento fuera, y PNR en el proveedor. */
function vueloSiAsientoNo(): OrderCreateResult {
  return resultado({
    outcome: 'PARTIAL',
    pnr: 'ABC123',
    items: [
      { kind: 'flight', providerItemId: '12', status: 'CONFIRMED', statusCode: 'HK' },
      { kind: 'seat', providerItemId: '13', status: 'FAILED', statusCode: 'UC' },
    ],
    issues: [
      {
        severity: 'ERROR',
        category: 'APPLICATION_ERROR',
        type: 'SEAT_NOT_AVAILABLE',
        message: `The requested seat for document ${DOCUMENTO_DEL_PASAJERO} is no longer available`,
        fieldPath: 'flights[0].seats[0]',
        fieldName: 'documentNumber',
        fieldValue: DOCUMENTO_DEL_PASAJERO,
      },
    ],
    compensation: { cancellableItemIds: ['12'] },
  });
}

describe('OrdersService.createOrder — el desenlace decide el estado de la fila', () => {
  it('CONFIRMED se persiste como confirmed', async () => {
    const b = banco(resultado({ outcome: 'CONFIRMED' }));
    await b.orders.createOrder(TENANT, USER, dto());
    expect(b.insertado()?.status).toBe('confirmed');
  });

  it('PARTIAL NO se persiste como confirmed: hay PNR pero hay un ítem fuera', async () => {
    const b = banco(vueloSiAsientoNo());
    await b.orders.createOrder(TENANT, USER, dto());

    expect(b.insertado()?.status).not.toBe('confirmed');
    expect(b.insertado()?.status).toBe('pending');
    // Y sin embargo la fila conserva el PNR: sin él no se puede compensar lo que sí entró.
    expect(b.insertado()?.provider_order_id).toBe('ABC123');
  });

  it('PENDING se persiste como pending y FAILED como failed', async () => {
    const pendiente = banco(resultado({ outcome: 'PENDING' }));
    await pendiente.orders.createOrder(TENANT, USER, dto());
    expect(pendiente.insertado()?.status).toBe('pending');

    const fallido = banco(resultado({ outcome: 'FAILED', pnr: undefined }));
    await fallido.orders.createOrder(TENANT, USER, dto());
    expect(fallido.insertado()?.status).toBe('failed');
  });

  it('error_message resume los errores del proveedor y NUNCA incluye fieldValue', async () => {
    const b = banco(vueloSiAsientoNo());
    await b.orders.createOrder(TENANT, USER, dto());

    const mensaje = b.insertado()?.error_message;
    expect(mensaje).toContain('SEAT_NOT_AVAILABLE');
    expect(mensaje).not.toContain('The requested seat');
    // Tanto `fieldValue` como `message` son texto libre que puede repetir lo que mandamos: PII
    // hoy, y un PAN el día que alguien encienda el flag de tarjeta.
    expect(mensaje).not.toContain(DOCUMENTO_DEL_PASAJERO);
  });

  it('un desenlace sin errores deja error_message en null, no en cadena vacía', async () => {
    const b = banco(
      resultado({
        issues: [{ severity: 'WARNING', category: 'WARNING', type: 'EMAIL_NOT_FOUND' }],
      }),
    );
    await b.orders.createOrder(TENANT, USER, dto());
    expect(b.insertado()?.error_message).toBeNull();
  });
});

interface BancoHttp {
  controller: OrdersController;
  orders: OrdersService;
  insertado: () => Record<string, unknown> | undefined;
  brandingResolve: ReturnType<typeof vi.fn>;
  mailerSend: ReturnType<typeof vi.fn>;
}

function bancoHttp(
  res: OrderCreateResult,
  capabilities: Partial<ProviderCapabilities> = {},
): BancoHttp {
  const { orders, insertado } = banco(res);

  const brandingResolve = vi.fn(() => Promise.resolve(null));
  const mailerSend = vi.fn(() => Promise.resolve(true));

  const controller = new OrdersController(
    orders,
    {} as unknown as DatabaseService,
    { sendToTenant: mailerSend } as unknown as MailerService,
    { resolve: brandingResolve } as unknown as BrandingService,
    { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    new FlightProviderRegistry([new StubProviderFactory({ code: PROVEEDOR, capabilities })], {
      isEnabledForTenant: () => Promise.resolve(false),
    }),
  );

  return { controller, orders, insertado, brandingResolve, mailerSend };
}

describe('OrdersController.create — lo que sale por HTTP', () => {
  it('exige Idempotency-Key UUID cuando el body no lleva quotationId', async () => {
    const b = bancoHttp(resultado({ outcome: 'CONFIRMED' }));
    const input = dto();
    delete input.quotationId;

    await expect(b.controller.create(USER, input)).rejects.toBeInstanceOf(BadRequestException);
    await expect(b.controller.create(USER, input, 'no-es-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await expect(b.controller.create(USER, input, IDEMPOTENCY_KEY)).resolves.toMatchObject({
      providerResult: { outcome: 'CONFIRMED' },
    });
    expect(b.insertado()?.create_request_key).toBe(`c:${IDEMPOTENCY_KEY}`);
  });

  it('serializa las capacidades del proveedor para gatear la post-venta en UI', async () => {
    const b = bancoHttp(resultado({ outcome: 'CONFIRMED' }), {
      retrieve: true,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
    });

    const respuesta = await b.controller.create(USER, dto());

    expect(respuesta.order.capabilities).toEqual({
      retrieve: true,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
    });
  });

  it('una orden emitida anuncia cancel=false y el endpoint no toca el servicio de cancelación', async () => {
    const b = bancoHttp(resultado({ outcome: 'CONFIRMED' }), {
      retrieve: true,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
    });
    const settled = await b.orders.createOrder(TENANT, USER, dto());
    const ticketed = { ...settled.order, status: 'ticketed' as const };
    vi.spyOn(b.orders, 'findById').mockResolvedValue(ticketed);
    const cancel = vi.spyOn(b.orders, 'cancelOrder');

    await expect(b.controller.findOne(USER, ticketed.id)).resolves.toMatchObject({
      order: { capabilities: { cancel: false } },
    });
    await expect(b.controller.cancel(USER, ticketed.id)).rejects.toThrow(/emitida|VOID|REFUND/i);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('viaja el outcome, no un booleano', async () => {
    const b = bancoHttp(vueloSiAsientoNo());
    const respuesta = await b.controller.create(USER, dto());

    expect(respuesta.providerResult.outcome).toBe('PARTIAL');
    expect(respuesta.providerResult).not.toHaveProperty('success');
    expect(respuesta.providerResult.items).toHaveLength(2);
  });

  it('expone flags top-level cuando el resultado externo no pudo conciliarse', async () => {
    const b = bancoHttp(resultado({ outcome: 'CONFIRMED' }));
    const settled = await b.orders.createOrder(TENANT, USER, dto());
    vi.spyOn(b.orders, 'createOrder').mockResolvedValue({
      ...settled,
      order: { ...settled.order, status: 'pending' },
      saga: {
        kind: 'escalate',
        reason: 'result-persistence-unavailable',
        status: 'pending',
      },
    });

    const respuesta = await b.controller.create(USER, dto());

    expect(respuesta).toMatchObject({
      orderId: 'order-1',
      retryForbidden: true,
      reconciliationRequired: true,
      providerResult: { outcome: 'CONFIRMED', pnr: 'ABC123' },
      saga: { kind: 'escalate', reason: 'result-persistence-unavailable', status: 'pending' },
    });
    expect(b.brandingResolve).not.toHaveBeenCalled();
    expect(b.mailerSend).not.toHaveBeenCalled();
  });

  it('las incidencias salen con lista blanca, SIN fieldValue ni message libre', async () => {
    const b = bancoHttp(vueloSiAsientoNo());
    const respuesta = await b.controller.create(USER, dto());

    const incidencia = respuesta.providerResult.issues[0];
    expect(incidencia?.type).toBe('SEAT_NOT_AVAILABLE');
    expect(incidencia?.fieldPath).toBe('flights[0].seats[0]');
    expect(incidencia).not.toHaveProperty('fieldValue');
    expect(incidencia).not.toHaveProperty('message');
    expect(JSON.stringify(respuesta)).not.toContain(DOCUMENTO_DEL_PASAJERO);
  });

  it('un PARTIAL no dispara el email de "reserva confirmada"', async () => {
    const b = bancoHttp(vueloSiAsientoNo());
    await b.controller.create(USER, dto());
    await new Promise((r) => setTimeout(r, 0));

    expect(b.brandingResolve).not.toHaveBeenCalled();
    expect(b.mailerSend).not.toHaveBeenCalled();
  });

  it('un CONFIRMED sí lo dispara', async () => {
    const b = bancoHttp(resultado({ outcome: 'CONFIRMED' }));
    await b.controller.create(USER, dto());
    await new Promise((r) => setTimeout(r, 0));

    expect(b.mailerSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * RF-09 CA-1, criterio de salida de COMPILACIÓN: la lectura de sólo visualización no expone
 * `bookingSignature`. No es estilo — el fabricante dice literalmente que la firma sólo sale de
 * un `getBooking` SIN `returnOnly`, así que una lectura filtrada no puede alimentar un modify.
 *
 * Estos `@ts-expect-error` son el test: si alguien volviera a meter el sello en `OrderView`, el
 * `@ts-expect-error` se quedaría sin error que suprimir y `tsc` pondría el build en rojo.
 */
/** `true` si `T` tiene la clave `K`. Convierte "este tipo no expone X" en un error de `tsc`. */
type TieneClave<T, K extends string> = K extends keyof T ? true : false;

describe('RF-09 — las dos lecturas no se pueden confundir', () => {
  it('OrderView no tiene sello de versión ni firma', () => {
    // Si `OrderView` ganara cualquiera de las dos claves, `TieneClave` pasaría a `true` y estas
    // dos asignaciones dejarían de compilar. Es el criterio de salida, verificado por `tsc`.
    const sinSello: TieneClave<OrderView, 'versionStamp'> = false;
    const sinFirma: TieneClave<OrderView, 'bookingSignature'> = false;

    expect(sinSello).toBe(false);
    expect(sinFirma).toBe(false);
  });

  it('una vista de sólo lectura no vale como lectura para modificar', () => {
    const vista: OrderView = { found: true, orderId: 'ABC123', airlineLocators: [], warnings: [] };

    const lectura: Extract<OrderForModification, { retrieved: true }> = {
      retrieved: true,
      order: vista,
      // @ts-expect-error — sin `versionStamp` esto no compila; con él, el objeto ya no es una vista.
      versionStamp: undefined,
    };

    expect(lectura.order.orderId).toBe('ABC123');
  });

  it('el sello lleva SIEMPRE el perfil de flags con el que se leyó', () => {
    const lectura: OrderForModification = {
      retrieved: true,
      order: { found: true, airlineLocators: [], warnings: [] },
      versionStamp: {
        signature: '76c2817b178cc264fa44cf85df1da5fb',
        featureProfile: { returnEmptySeatObjects: false, returnFiscalId: true },
        retrievedAt: '2026-08-26T12:00:00.000Z',
      },
    };

    // Sin narrowing por `retrieved` no hay acceso al sello: la unión lo impide.
    if (!lectura.retrieved) throw new Error('inalcanzable');
    expect(lectura.versionStamp.featureProfile.returnEmptySeatObjects).toBe(false);
  });

  it('el adapter de vuelos ya no expone el `retrieveOrder` ambiguo', () => {
    const sinMetodoAmbiguo: TieneClave<FlightProviderAdapter, 'retrieveOrder'> = false;
    const conLecturaDeDisplay: TieneClave<FlightProviderAdapter, 'retrieveForDisplay'> = true;

    expect(sinMetodoAmbiguo).toBe(false);
    expect(conLecturaDeDisplay).toBe(true);
  });
});

describe('ProviderIssue — la forma del proveedor no se aplana a string', () => {
  it('conserva category y type, que son los dos campos requeridos del contrato', () => {
    const issue: ProviderIssue = {
      severity: 'ERROR',
      category: 'BAD_REQUEST',
      type: 'REQUIRED_FIELD_MISSING',
    };

    expect(issue.category).toBe('BAD_REQUEST');
    expect(issue.type).toBe('REQUIRED_FIELD_MISSING');
  });
});
