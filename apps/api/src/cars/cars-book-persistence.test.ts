import { describe, expect, it, vi } from 'vitest';
import { CAR_RESERVATION_UNRECORDED_EVENT, CarsService } from './cars.service.js';
import type { ConfirmInput } from './cars.schemas.js';

/*
 * La reserva de auto ya quedó hecha en AgentCars cuando se guarda la orden. Si guardarla falla, se
 * reintenta; si igual no entra, queda un evento durable con el código y el vendedor recibe el código
 * con `recorded: false`, no un error genérico (A4 de docs/platform/19).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

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

const BOOKED = {
  confirmationCode: 'ABC123',
  sippCode: 'ECMR',
  rateCode: 'BEST',
  status: 'confirmed',
};

function setup(failures: number) {
  const adapter = { confirm: vi.fn(() => Promise.resolve(BOOKED)) };
  const factory = { forTenant: vi.fn(() => Promise.resolve(adapter)) };
  const pricing = {
    computeWaterfall: vi.fn(() =>
      Promise.resolve({ finalMinor: 15000, netMinor: 14350, totalMarkupMinor: 650 }),
    ),
  };
  let calls = 0;
  const orders = {
    recordExternalOrder: vi.fn(() => {
      calls += 1;
      return calls <= failures
        ? Promise.reject(new Error('connection terminated'))
        : Promise.resolve({ id: 'order-1' });
    }),
  };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const service = new CarsService(
    factory as never,
    {} as never,
    pricing as never,
    orders as never,
    audit as never,
    {} as never,
  );
  const sleep = vi
    .spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
    .mockResolvedValue(undefined);
  return { service, orders, audit, sleep };
}

describe('CarsService.book: guardar la orden después de confirmar', () => {
  it('sin fallos guarda la orden una vez y devuelve recorded: true', async () => {
    const { service, orders, audit, sleep } = setup(0);
    const res = await service.book(TENANT, USER, INPUT);
    expect(res).toEqual({ ...BOOKED, recorded: true });
    expect(orders.recordExternalOrder).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'CarReservationCreated' }),
    );
  });

  it('un fallo pasajero se reintenta y la orden queda', async () => {
    const { service, orders, audit } = setup(2);
    const res = await service.book(TENANT, USER, INPUT);
    expect(res.recorded).toBe(true);
    expect(orders.recordExternalOrder).toHaveBeenCalledTimes(3);
    const types = audit.emit.mock.calls.map(
      (c) => (c as unknown as [{ eventType: string }])[0].eventType,
    );
    expect(types).toEqual(['CarReservationCreated']);
  });

  it('agotados los intentos devuelve el código con recorded: false y deja el rastro', async () => {
    const { service, orders, audit } = setup(99);
    const res = await service.book(TENANT, USER, INPUT);
    expect(res).toEqual({ ...BOOKED, recorded: false });
    expect(orders.recordExternalOrder).toHaveBeenCalledTimes(3);
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [event] = audit.emit.mock.calls[0] as unknown as [
      { eventType: string; aggregateId: string; payload: Record<string, unknown> },
    ];
    expect(event.eventType).toBe(CAR_RESERVATION_UNRECORDED_EVENT);
    expect(event.aggregateId).toBe('ABC123');
    expect(event.payload).toMatchObject({
      provider: 'agent-cars',
      confirmationCode: 'ABC123',
      netTotalMinor: 14350,
      currency: 'USD',
      attempts: 3,
    });
    // El panel de red lo ve cualquier admin: sin datos del conductor.
    const json = JSON.stringify(event.payload);
    expect(json).not.toContain('García');
    expect(json).not.toContain('ana@example.com');
  });
});
