import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CarsService } from './cars.service.js';

/*
 * La gestión de autos por apellido + código (consultar, cancelar, activar, reporte diario). Las
 * sub-agencias heredan la cuenta de AgentCars del consolidador: el código de una reserva ajena no
 * puede abrir su voucher ni cancelarla, y la cancelación tiene que dejar la orden cancelada.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Setup {
  readonly owned?: { id: string; provider_order_id: string } | undefined;
  readonly ownsAccount?: boolean;
  readonly ordersInDb?: readonly string[];
  readonly report?: readonly { confirmationCode: string }[];
}

function setup(s: Setup = {}) {
  const adapter = {
    myReservation: vi.fn(() => Promise.resolve({ confirmationCode: 'ABC123' })),
    cancel: vi.fn(() => Promise.resolve({ success: true, confirmationCode: 'ABC123' })),
    release: vi.fn(() => Promise.resolve({ confirmationCode: 'ABC123', status: 'confirmed' })),
    getDailyReport: vi.fn(() =>
      Promise.resolve(
        (s.report ?? []).map((e) => ({
          ...e,
          pickUpDate: '2026-12-01',
          dropOffDate: '2026-12-03',
          status: 'confirmed',
        })),
      ),
    ),
  };
  const factory = {
    forTenant: vi.fn(() => Promise.resolve(adapter)),
    ownsAccount: vi.fn(() => Promise.resolve(s.ownsAccount ?? true)),
  };
  const orders = {
    findByProviderOrderId: vi.fn(() => Promise.resolve(s.owned)),
    cancelOrder: vi.fn(() =>
      Promise.resolve({ result: { success: true, warnings: [] }, order: undefined }),
    ),
  };
  const inDb = (s.ordersInDb ?? []).map((code) => ({ provider_order_id: code }));
  const chain = {
    select: () => chain,
    where: () => chain,
    execute: () => Promise.resolve(inDb),
  };
  const trx = { selectFrom: () => chain };
  const db = { withTenant: (_t: string, fn: (t: typeof trx) => unknown) => fn(trx) };
  const service = new CarsService(
    factory as never,
    db as never,
    {} as never,
    orders as never,
    {} as never,
    {} as never,
  );
  return { service, adapter, factory, orders };
}

const OWNED = { id: 'order-1', provider_order_id: 'ABC123' };

describe('gestión de reservas de autos: sólo las de la agencia', () => {
  it('consultar una reserva ajena es 404 y no llega al proveedor', async () => {
    const { service, adapter } = setup({ owned: undefined });
    await expect(
      service.myReservation(TENANT, { lastName: 'Pérez', confirmationCode: 'XYZ999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adapter.myReservation).not.toHaveBeenCalled();
  });

  it('activar (release) una reserva ajena es 404 y no llega al proveedor', async () => {
    const { service, adapter } = setup({ owned: undefined });
    await expect(
      service.release(TENANT, { lastName: 'Pérez', referenceCode: 'XYZ999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adapter.release).not.toHaveBeenCalled();
  });

  it('cancelar una ajena es 404; una propia sale por la orden y no directo al proveedor', async () => {
    const ajena = setup({ owned: undefined });
    await expect(
      ajena.service.cancel(TENANT, 'user-1', { lastName: 'Pérez', confirmationCode: 'XYZ999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ajena.orders.cancelOrder).not.toHaveBeenCalled();

    const propia = setup({ owned: OWNED });
    const res = await propia.service.cancel(TENANT, 'user-1', {
      lastName: 'García',
      confirmationCode: 'abc123',
    });
    expect(propia.orders.cancelOrder).toHaveBeenCalledWith(TENANT, 'order-1', 'ABC123', 'user-1');
    expect(propia.adapter.cancel).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, confirmationCode: 'ABC123' });
  });

  it('consultar una reserva propia sí llega al proveedor', async () => {
    const { service, adapter } = setup({ owned: OWNED });
    await service.myReservation(TENANT, { lastName: 'García', confirmationCode: 'ABC123' });
    expect(adapter.myReservation).toHaveBeenCalledTimes(1);
  });

  it('el reporte diario de una cuenta compartida trae sólo las reservas de la agencia', async () => {
    const report = [{ confirmationCode: 'ABC123' }, { confirmationCode: 'OTRA01' }];
    const compartida = setup({ ownsAccount: false, ordersInDb: ['abc123'], report });
    const entries = await compartida.service.getDailyReport(TENANT, {});
    expect(entries.map((e) => e.confirmationCode)).toEqual(['ABC123']);

    const propia = setup({ ownsAccount: true, report });
    expect(await propia.service.getDailyReport(TENANT, {})).toHaveLength(2);
  });
});
