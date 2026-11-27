import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CarSelectionStore } from './car-selection.store.js';
import type { ConfirmInput } from './cars.schemas.js';
import { CarsService } from './cars.service.js';

/*
 * AUT-05 (doc 21 §5.2): el neto de un auto lo cotiza AgentCars en la selección, y el Book manda ese
 * —el que la API guardó—, no el que llega en el cuerpo. Un total tocado en el navegador no llega al
 * proveedor, ni a la orden, ni a la cartera.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';

const SELECTION = {
  uniqid: 'sess-1',
  companyCode: 'ZE',
  sippCode: 'ECMR',
  category: 'Economy',
  base: { amountMinor: 11800, currency: 'USD' },
  tax: { amountMinor: 2550, currency: 'USD' },
  rateAmount: { amountMinor: 14350, currency: 'USD' },
};

const INPUT = {
  uniqid: 'sess-1',
  paymentType: 'ppd',
  rateType: 'best',
  companyCode: 'ZE',
  sippCode: 'ECMR',
  pickUpLocation: 'MIA',
  dropOffLocation: 'MIA',
  pickUpDate: '2026-12-01',
  dropOffDate: '2026-12-05',
  pickUpHour: '1000',
  dropOffHour: '1000',
  pickUpAddress: '',
  dropOffAddress: '',
  firstName: 'Ana',
  lastName: 'García',
  age: 30,
  email: 'ana@example.com',
  realBase: 118,
  realTax: 25.5,
  total: 143.5,
  currency: 'USD',
} as unknown as ConfirmInput;

function setup() {
  const adapter = {
    getSelection: vi.fn(() => Promise.resolve(SELECTION)),
    confirm: vi.fn(() =>
      Promise.resolve({
        confirmationCode: 'ABC123',
        sippCode: 'ECMR',
        rateCode: 'B',
        status: 'confirmed',
      }),
    ),
  };
  const factory = { forTenant: vi.fn(() => Promise.resolve(adapter)) };
  const pricing = {
    computeWaterfall: vi.fn((_t: string, _v: string, net: number) =>
      Promise.resolve({ finalMinor: net + 650, netMinor: net, totalMarkupMinor: 650 }),
    ),
    pricingForTenant: vi.fn(() => Promise.resolve(null)),
  };
  const orders = { recordExternalOrder: vi.fn(() => Promise.resolve({ id: 'order-1' })) };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const selections = new CarSelectionStore();
  const service = new CarsService(
    factory as never,
    {} as never,
    pricing as never,
    orders as never,
    audit as never,
    {} as never,
    undefined,
    selections,
  );
  vi.spyOn(
    service as unknown as { resolveSource: () => Promise<string> },
    'resolveSource',
  ).mockResolvedValue('CO');
  vi.spyOn(
    service as unknown as { withPricing: (o: unknown[]) => Promise<unknown[]> },
    'withPricing',
  ).mockImplementation((o) => Promise.resolve(o));
  return { service, adapter, orders, selections };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return ((e as ConflictException).getResponse() as { reason?: string }).reason ?? 'sin reason';
  }
  throw new Error('esperaba un 409');
}

const elegir = (service: CarsService, tenantId = TENANT) =>
  service.getSelection(tenantId, {
    pickUpLocation: 'MIA',
    dropOffLocation: 'MIA',
    pickUpDate: '2026-12-01',
    dropOffDate: '2026-12-05',
    pickUpHour: '1000',
    dropOffHour: '1000',
    rateType: 'best',
    country: 'US',
    companyCode: 'ZE',
    sippCode: 'ECMR',
  });

describe('AUT-05 el neto de un auto lo pone la selección, no el cliente', () => {
  it('con la selección guardada, reserva con su neto y la orden lleva ese precio', async () => {
    const { service, adapter, orders } = setup();
    await elegir(service);
    await service.book(TENANT, USER, INPUT);
    expect(adapter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        realBase: SELECTION.base,
        realTax: SELECTION.tax,
        total: SELECTION.rateAmount,
      }),
    );
    expect(orders.recordExternalOrder).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({ totalAmountMinor: 14350 + 650 }),
    );
  });

  it('un total más bajo en el cuerpo se frena antes de llegar a AgentCars', async () => {
    const { service, adapter, orders } = setup();
    await elegir(service);
    expect(await reason(service.book(TENANT, USER, { ...INPUT, total: 1 }))).toBe(
      'CAR_PRICE_MISMATCH',
    );
    expect(await reason(service.book(TENANT, USER, { ...INPUT, realBase: 10, realTax: 0 }))).toBe(
      'CAR_PRICE_MISMATCH',
    );
    expect(await reason(service.book(TENANT, USER, { ...INPUT, currency: 'COP' }))).toBe(
      'CAR_PRICE_MISMATCH',
    );
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(orders.recordExternalOrder).not.toHaveBeenCalled();
  });

  it('sin selección guardada (otra sesión, otro nodo o vencida) no reserva', async () => {
    const { service, adapter } = setup();
    expect(await reason(service.book(TENANT, USER, INPUT))).toBe('CAR_SELECTION_EXPIRED');
    await elegir(service, OTRO_TENANT);
    expect(await reason(service.book(TENANT, USER, INPUT))).toBe('CAR_SELECTION_EXPIRED');
    expect(adapter.confirm).not.toHaveBeenCalled();
  });

  it('otro auto u otra arrendadora con la misma sesión no reserva', async () => {
    const { service, adapter } = setup();
    await elegir(service);
    expect(await reason(service.book(TENANT, USER, { ...INPUT, sippCode: 'FFAR' }))).toBe(
      'CAR_SELECTION_MISMATCH',
    );
    expect(await reason(service.book(TENANT, USER, { ...INPUT, companyCode: 'ZI' }))).toBe(
      'CAR_SELECTION_MISMATCH',
    );
    expect(adapter.confirm).not.toHaveBeenCalled();
  });

  it('una sesión reservada no se reserva dos veces; si AgentCars rechaza, se puede reintentar', async () => {
    const { service, adapter } = setup();
    await elegir(service);
    adapter.confirm.mockRejectedValueOnce(new Error('INCOMPLETE_REQUEST'));
    await expect(service.book(TENANT, USER, INPUT)).rejects.toThrow('INCOMPLETE_REQUEST');
    await service.book(TENANT, USER, INPUT);
    expect(await reason(service.book(TENANT, USER, INPUT))).toBe('CAR_SELECTION_EXPIRED');
    expect(adapter.confirm).toHaveBeenCalledTimes(2);
  });
});
