import { BadRequestException, ConflictException } from '@nestjs/common';
import type { OrderView } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { currentTenantId, requestContextStorage } from '../request-context/request-context.js';
import {
  ADMIN_ORDER_ACTION_EVENT,
  AdminOrderActionsService,
  adminProviderReading,
} from './admin-order-actions.service.js';
import {
  AdminOrderNotFoundError,
  AdminOrderNumberMismatchError,
  AdminOrderWithoutLocatorError,
} from './admin-orders.errors.js';
import type { AdminOrdersService } from './admin-orders.service.js';
import type { HotelOrderReadResult } from './hotel-order-reads.service.js';
import type { OrderCapabilitiesService } from './order-capabilities.service.js';
import type { OrderConfirmationService } from './order-confirmation.service.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * La post-venta del superadmin sobre una reserva de otro nodo, sin base: con qué tenant corre cada
 * acción, qué reglas se respetan y qué queda en la auditoría. Contra Postgres lo prueba
 * admin-order-actions.integration.test.ts.
 */

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const PLATAFORMA = '00000000-0000-4000-8000-000000000001';
const DUENO = '0b0e4b7c-9a3d-4c1e-8f2a-1d2c3b4a5f60';
const ORDEN = '7F1D2C3B-4A5F-4E60-8B0E-4B7C9A3D4C1E';
const ORDEN_ID = ORDEN.toLowerCase();
const OPERACION = '1B2C3D4E-5F60-4A1B-8C2D-3E4F5A6B7C8D';
const MOTIVO = 'La agencia no puede entrar al panel';
const RECHAZO_DE_LA_BASE = Object.assign(new Error('admin_superadmin_required'), {
  code: '42501',
});

function fila(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDEN_ID,
    tenant_id: DUENO,
    user_id: 'u-1',
    quotation_id: null,
    provider: 'latam-ndc',
    provider_order_id: 'PNR001',
    status: 'confirmed',
    search_criteria: {},
    selected_offer: {},
    passengers: [],
    contact_info: { email: 'ana@cliente.test' },
    total_amount: 1000,
    currency: 'USD',
    order_number: 1042,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-10-13T10:00:00Z'),
    updated_at: new Date('2026-10-13T10:00:00Z'),
    ...over,
  };
}

function banco(opts: { row?: OrderRow | undefined } = {}) {
  /** El tenant del contexto en el momento en que cada servicio corrió. */
  const seen: Record<string, string | undefined> = {};
  const adminOrders = {
    ownerOf: vi.fn(() => Promise.resolve(DUENO)),
    snapshot: vi.fn(() => Promise.resolve({ order: { id: ORDEN_ID } })),
  };
  const orders = {
    findById: vi.fn(() => {
      seen['findById'] = currentTenantId();
      return Promise.resolve('row' in opts ? opts.row : fila());
    }),
    retrieveOrder: vi.fn((): Promise<OrderView | HotelOrderReadResult> => {
      seen['retrieveOrder'] = currentTenantId();
      return Promise.resolve({
        found: true,
        status: 'CONFIRMED',
        ticketNumbers: ['0451234567890'],
        airlineLocators: [{ carrierCode: 'LA', locator: 'ABC123' }],
        warnings: ['texto libre que no sale'],
      });
    }),
    retryOperation: vi.fn(() => {
      seen['retryOperation'] = currentTenantId();
      return Promise.resolve({ result: { success: true, warnings: [] } });
    }),
    cancelOrder: vi.fn(() => {
      seen['cancelOrder'] = currentTenantId();
      return Promise.resolve({
        result: { success: true, warnings: [], settlement: 'in-progress' as const },
      });
    }),
    cancellationEstimate: vi.fn(() => ({ kind: 'unavailable', reason: 'no-snapshot' })),
    /** El historial después de una cancelación que no canceló: un rechazo del proveedor. */
    listOperations: vi.fn(
      (): Promise<
        { type: string; status: string; reconciliationRequired: boolean; retryable: boolean }[]
      > =>
        Promise.resolve([
          { type: 'cancel', status: 'failed', reconciliationRequired: false, retryable: false },
        ]),
    ),
  };
  const confirmation = {
    resend: vi.fn(() => {
      seen['resend'] = currentTenantId();
      return Promise.resolve({ sent: true, to: 'ana@cliente.test' });
    }),
  };
  const capabilities = { assertSupports: vi.fn() };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const service = new AdminOrderActionsService(
    adminOrders as unknown as AdminOrdersService,
    orders as unknown as OrdersService,
    confirmation as unknown as OrderConfirmationService,
    capabilities as unknown as OrderCapabilitiesService,
    audit as unknown as AuditService,
  );
  return { service, adminOrders, orders, confirmation, capabilities, audit, seen };
}

/** Como en un request: el superadmin con la plataforma como tenant activo. */
function comoSuperadmin<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run({ userId: SUPERADMIN, tenantId: PLATAFORMA }, fn);
}

function evento(payload: Record<string, unknown>) {
  return {
    eventType: ADMIN_ORDER_ACTION_EVENT,
    tenantId: DUENO,
    actorUserId: SUPERADMIN,
    aggregateType: 'order',
    aggregateId: ORDEN_ID,
    payload: { orderId: ORDEN_ID, reason: MOTIVO, ...payload },
  };
}

describe('reenviar la confirmación', () => {
  it('con el nodo de la reserva y las reglas de la agencia; queda en la auditoría del nodo', async () => {
    const b = banco();
    const res = await comoSuperadmin(() =>
      b.service.sendConfirmation(SUPERADMIN, ORDEN, { reason: MOTIVO }),
    );

    expect(res).toEqual({ sent: true, to: 'ana@cliente.test' });
    expect(b.adminOrders.ownerOf).toHaveBeenCalledWith(SUPERADMIN, ORDEN_ID);
    expect(b.orders.findById).toHaveBeenCalledWith(DUENO, ORDEN_ID);
    expect(b.confirmation.resend).toHaveBeenCalledWith(DUENO, fila());
    // Corrió con el nodo de la reserva como tenant del contexto, no con la plataforma.
    expect(b.seen).toMatchObject({ findById: DUENO, resend: DUENO });
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({ action: 'send-confirmation', outcome: 'ok', result: { sent: true } }),
    );
    // El correo del cliente no va a la auditoría.
    expect(JSON.stringify(b.audit.emit.mock.calls)).not.toContain('ana@cliente.test');
  });

  it('si el correo no salió, la auditoría lo dice', async () => {
    const b = banco();
    b.confirmation.resend.mockResolvedValueOnce({ sent: false, to: 'ana@cliente.test' });
    await b.service.sendConfirmation(SUPERADMIN, ORDEN, { reason: MOTIVO });
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'send-confirmation',
        outcome: 'error',
        errorReason: 'MAIL_NOT_SENT',
        result: { sent: false },
      }),
    );
  });

  it('un 409 de las reglas sale tal cual y queda como intento fallido', async () => {
    const b = banco();
    b.confirmation.resend.mockRejectedValueOnce(new ConflictException('no'));
    await expect(
      b.service.sendConfirmation(SUPERADMIN, ORDEN, { reason: MOTIVO }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({ action: 'send-confirmation', outcome: 'error', errorReason: 'ConflictException' }),
    );
  });
});

describe('consultar al proveedor', () => {
  it('pide la capacidad, lee con el superadmin como actor y devuelve la lectura y la ficha', async () => {
    const b = banco();
    const res = await comoSuperadmin(() =>
      b.service.retrieve(SUPERADMIN, ORDEN, { reason: MOTIVO }),
    );

    expect(b.capabilities.assertSupports).toHaveBeenCalledWith(fila(), 'retrieve');
    expect(b.orders.retrieveOrder).toHaveBeenCalledWith(DUENO, fila(), SUPERADMIN);
    expect(b.seen['retrieveOrder']).toBe(DUENO);
    expect(res.reading).toMatchObject({
      found: true,
      status: 'CONFIRMED',
      ticketNumbers: ['0451234567890'],
      airlineLocators: [{ carrierCode: 'LA', locator: 'ABC123' }],
      hotelConfirmationNumber: null,
    });
    expect(JSON.stringify(res.reading)).not.toContain('texto libre');
    expect(res.detail).toEqual({ order: { id: ORDEN_ID } });
    expect(b.adminOrders.snapshot).toHaveBeenCalledWith(SUPERADMIN, ORDEN);
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'retrieve',
        outcome: 'ok',
        result: { found: true, providerStatus: 'CONFIRMED' },
      }),
    );
  });

  it('si la ficha no se puede releer, la consulta igual cuenta: detail null', async () => {
    const b = banco();
    b.adminOrders.snapshot.mockRejectedValueOnce(new Error('db caída'));
    const res = await b.service.retrieve(SUPERADMIN, ORDEN, { reason: MOTIVO });
    expect(res.detail).toBeNull();
    expect(res.reading.found).toBe(true);
  });

  it('sin localizador, 409 sin llamar al proveedor', async () => {
    const b = banco({ row: fila({ provider_order_id: null }) });
    await expect(b.service.retrieve(SUPERADMIN, ORDEN, { reason: MOTIVO })).rejects.toBeInstanceOf(
      AdminOrderWithoutLocatorError,
    );
    expect(b.orders.retrieveOrder).not.toHaveBeenCalled();
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({ action: 'retrieve', outcome: 'error', errorReason: 'ORDER_WITHOUT_LOCATOR' }),
    );
  });

  it('un proveedor que no consulta: el 400 de las capacidades, sin llamarlo', async () => {
    const b = banco();
    b.capabilities.assertSupports.mockImplementationOnce(() => {
      throw new BadRequestException('no');
    });
    await expect(b.service.retrieve(SUPERADMIN, ORDEN, { reason: MOTIVO })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(b.orders.retrieveOrder).not.toHaveBeenCalled();
  });
});

describe('reintentar una cancelación', () => {
  it('la del servicio de la agencia, con la operación y el superadmin como actor', async () => {
    const b = banco();
    const res = await comoSuperadmin(() =>
      b.service.retryCancellation(SUPERADMIN, ORDEN, OPERACION, { reason: MOTIVO }),
    );

    expect(res).toEqual({ success: true, warnings: [] });
    expect(b.capabilities.assertSupports).toHaveBeenCalledWith(fila(), 'cancel');
    expect(b.orders.retryOperation).toHaveBeenCalledWith(
      DUENO,
      ORDEN_ID,
      OPERACION.toLowerCase(),
      SUPERADMIN,
    );
    expect(b.seen['retryOperation']).toBe(DUENO);
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'retry-cancel',
        operationId: OPERACION.toLowerCase(),
        outcome: 'ok',
        result: { success: true },
      }),
    );
  });

  it('el proveedor que la rechaza: 200 con el resultado, y en la auditoría como error', async () => {
    const b = banco();
    b.orders.retryOperation.mockResolvedValueOnce({
      result: { success: false, warnings: [], error: 'rechazada' } as never,
    });
    const res = await b.service.retryCancellation(SUPERADMIN, ORDEN, OPERACION, {
      reason: MOTIVO,
    });
    expect(res.success).toBe(false);
    expect(b.orders.listOperations).toHaveBeenCalledWith(DUENO, ORDEN_ID);
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'retry-cancel',
        operationId: OPERACION.toLowerCase(),
        outcome: 'error',
        errorReason: 'PROVIDER_REJECTED',
        result: { success: false },
      }),
    );
  });

  it('el proveedor que no confirma si se aplicó: la auditoría dice que hay que conciliar', async () => {
    const b = banco();
    b.orders.retryOperation.mockResolvedValueOnce({ result: { success: false, warnings: [] } });
    b.orders.listOperations.mockResolvedValueOnce([
      { type: 'pay', status: 'success', reconciliationRequired: false, retryable: false },
      { type: 'cancel', status: 'failed', reconciliationRequired: true, retryable: false },
    ]);
    await b.service.retryCancellation(SUPERADMIN, ORDEN, OPERACION, { reason: MOTIVO });
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'retry-cancel',
        operationId: OPERACION.toLowerCase(),
        outcome: 'error',
        errorReason: 'PROVIDER_UNVERIFIED',
        result: { success: false },
      }),
    );
  });
});

describe('cancelar en nombre de la agencia', () => {
  it('con el número de la orden: el servicio de la agencia, con el PNR y el superadmin', async () => {
    const b = banco();
    const res = await comoSuperadmin(() =>
      b.service.cancel(SUPERADMIN, ORDEN, { reason: MOTIVO, orderNumber: 1042 }),
    );

    expect(res).toMatchObject({ success: true, settlement: 'in-progress' });
    expect(b.orders.cancelOrder).toHaveBeenCalledWith(DUENO, ORDEN_ID, 'PNR001', SUPERADMIN);
    expect(b.seen['cancelOrder']).toBe(DUENO);
    // Salió bien: no hace falta mirar el historial.
    expect(b.orders.listOperations).not.toHaveBeenCalled();
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'cancel',
        outcome: 'ok',
        result: { success: true, settlement: 'in-progress' },
      }),
    );
  });

  it('sin cancelar y sin historial que lo explique, la auditoría no adivina', async () => {
    const sinIntento = banco();
    sinIntento.orders.cancelOrder.mockResolvedValueOnce({
      result: { success: false, warnings: [] } as never,
    });
    sinIntento.orders.listOperations.mockResolvedValueOnce([]);
    const res = await sinIntento.service.cancel(SUPERADMIN, ORDEN, {
      reason: MOTIVO,
      orderNumber: 1042,
    });
    expect(res).toEqual({ success: false, warnings: [] });

    const historialCaido = banco();
    historialCaido.orders.cancelOrder.mockResolvedValueOnce({
      result: { success: false, warnings: [] } as never,
    });
    historialCaido.orders.listOperations.mockRejectedValueOnce(new Error('db caída'));
    await expect(
      historialCaido.service.cancel(SUPERADMIN, ORDEN, { reason: MOTIVO, orderNumber: 1042 }),
    ).resolves.toEqual({ success: false, warnings: [] });

    for (const b of [sinIntento, historialCaido]) {
      expect(b.audit.emit).toHaveBeenCalledWith(
        evento({
          action: 'cancel',
          outcome: 'error',
          errorReason: 'PROVIDER_NOT_CANCELLED',
          result: { success: false },
        }),
      );
    }
  });

  it('otro número: 400 y no se cancela nada, pero el intento queda', async () => {
    const b = banco();
    await expect(
      b.service.cancel(SUPERADMIN, ORDEN, { reason: MOTIVO, orderNumber: 1043 }),
    ).rejects.toBeInstanceOf(AdminOrderNumberMismatchError);
    expect(b.orders.cancelOrder).not.toHaveBeenCalled();
    expect(b.capabilities.assertSupports).not.toHaveBeenCalled();
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({ action: 'cancel', outcome: 'error', errorReason: 'ORDER_NUMBER_MISMATCH' }),
    );
  });

  it('una emitida: el 400 de las capacidades, sin llamar al proveedor', async () => {
    const b = banco({ row: fila({ status: 'ticketed' }) });
    b.capabilities.assertSupports.mockImplementationOnce(() => {
      throw new BadRequestException('emitida');
    });
    await expect(
      b.service.cancel(SUPERADMIN, ORDEN, { reason: MOTIVO, orderNumber: 1042 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.orders.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('la penalidad estimada', () => {
  it('la del servicio de la agencia, con la fila leída en el nodo; no deja evento', async () => {
    const b = banco();
    await expect(b.service.cancellationEstimate(SUPERADMIN, ORDEN)).resolves.toEqual({
      orderId: ORDEN_ID,
      estimate: { kind: 'unavailable', reason: 'no-snapshot' },
    });
    expect(b.orders.findById).toHaveBeenCalledWith(DUENO, ORDEN_ID);
    expect(b.capabilities.assertSupports).toHaveBeenCalledWith(fila(), 'cancel');
    expect(b.audit.emit).not.toHaveBeenCalled();
  });

  it('sin la reserva, 404; sin localizador, 409', async () => {
    await expect(
      banco({ row: undefined }).service.cancellationEstimate(SUPERADMIN, ORDEN),
    ).rejects.toBeInstanceOf(AdminOrderNotFoundError);
    await expect(
      banco({ row: fila({ provider_order_id: null }) }).service.cancellationEstimate(
        SUPERADMIN,
        ORDEN,
      ),
    ).rejects.toBeInstanceOf(AdminOrderWithoutLocatorError);
  });
});

describe('quién puede y qué queda cuando no', () => {
  it('si la base dice que no es el superadmin: 403, nada corre y nada queda en la auditoría', async () => {
    const b = banco();
    b.adminOrders.ownerOf.mockRejectedValue(new SuperadminRequiredError());
    await expect(
      b.service.cancel(SUPERADMIN, ORDEN, { reason: MOTIVO, orderNumber: 1042 }),
    ).rejects.toBeInstanceOf(SuperadminRequiredError);
    await expect(
      b.service.sendConfirmation(SUPERADMIN, ORDEN, { reason: MOTIVO }),
    ).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(b.orders.findById).not.toHaveBeenCalled();
    expect(b.audit.emit).not.toHaveBeenCalled();
  });

  it('una reserva que desaparece entre las dos lecturas: 404 y el intento queda', async () => {
    const b = banco({ row: undefined });
    await expect(b.service.retrieve(SUPERADMIN, ORDEN, { reason: MOTIVO })).rejects.toBeInstanceOf(
      AdminOrderNotFoundError,
    );
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({ action: 'retrieve', outcome: 'error', errorReason: 'ORDER_NOT_FOUND' }),
    );
  });

  it('un error sin motivo de máquina queda con su nombre, nunca con su mensaje', async () => {
    const b = banco();
    b.orders.cancelOrder.mockRejectedValueOnce(
      Object.assign(new Error('ana@cliente.test no responde'), { name: 'LatamNdcError' }),
    );
    await expect(
      b.service.cancel(SUPERADMIN, ORDEN, { reason: MOTIVO, orderNumber: 1042 }),
    ).rejects.toThrow();
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({ action: 'cancel', outcome: 'error', errorReason: 'LatamNdcError' }),
    );
    expect(JSON.stringify(b.audit.emit.mock.calls)).not.toContain('no responde');
  });

  it('lo que no es un Error también se registra', async () => {
    const b = banco();
    b.orders.retryOperation.mockRejectedValueOnce('raro');
    await expect(
      b.service.retryCancellation(SUPERADMIN, ORDEN, OPERACION, { reason: MOTIVO }),
    ).rejects.toBe('raro');
    expect(b.audit.emit).toHaveBeenCalledWith(
      evento({
        action: 'retry-cancel',
        operationId: OPERACION.toLowerCase(),
        outcome: 'error',
        errorReason: 'UnknownError',
      }),
    );
  });

  it('cualquier otro error al resolver el nodo sale tal cual y no deja evento', async () => {
    const b = banco();
    b.adminOrders.ownerOf.mockRejectedValue(RECHAZO_DE_LA_BASE);
    await expect(b.service.retrieve(SUPERADMIN, ORDEN, { reason: MOTIVO })).rejects.toBe(
      RECHAZO_DE_LA_BASE,
    );
    expect(b.audit.emit).not.toHaveBeenCalled();
  });
});

describe('adminProviderReading', () => {
  const AT = new Date('2026-10-13T15:00:00.000Z');

  it('de un hotel: su estado en el proveedor y la confirmación del hotel', () => {
    const read: HotelOrderReadResult = {
      vertical: 'hotels',
      orderId: ORDEN_ID,
      found: true,
      status: 'CONFIRMED',
      providerStatus: 'Vouchered',
      refundAwaited: false,
      hotelConfirmationNumber: 'HCN-1',
      warnings: [],
      tracking: null,
    };
    expect(adminProviderReading(read, AT)).toEqual({
      found: true,
      status: 'Vouchered',
      airlineLocators: [],
      ticketNumbers: [],
      hotelConfirmationNumber: 'HCN-1',
      readAt: '2026-10-13T15:00:00.000Z',
    });
    expect(
      adminProviderReading({ ...read, providerStatus: undefined, found: false }, AT),
    ).toMatchObject({ found: false, status: 'CONFIRMED' });
  });

  it('de un vuelo: descarta lo vacío o malformado y acota los textos', () => {
    const reading = adminProviderReading(
      {
        found: true,
        status: '  ',
        airlineLocators: [
          { carrierCode: 'LA', locator: 'ABC123' },
          { carrierCode: '', locator: 'X' },
        ],
        ticketNumbers: ['', '0451234567890123456789'],
        warnings: [],
      },
      AT,
    );
    expect(reading).toEqual({
      found: true,
      status: null,
      airlineLocators: [{ carrierCode: 'LA', locator: 'ABC123' }],
      ticketNumbers: ['04512345678901234567'],
      hotelConfirmationNumber: null,
      readAt: '2026-10-13T15:00:00.000Z',
    });
    expect(
      adminProviderReading({ found: false, airlineLocators: [], warnings: [] }, AT),
    ).toMatchObject({ found: false, ticketNumbers: [] });
  });
});
