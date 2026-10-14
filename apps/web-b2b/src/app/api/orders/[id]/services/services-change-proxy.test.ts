import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../../../../lib/api';
import {
  SERVICES_CHANGE_INVALID,
  SERVICES_CHANGE_INVALID_ORDER,
  SERVICES_CHANGE_UNREADABLE,
  addServicesBodyOf,
  proxyServicesChange,
  removeServicesBodyOf,
} from './services-change-proxy';

/*
 * `POST /api/orders/:id/services/add` y `/remove` (SAB-20): el cuerpo se valida en el borde y la
 * respuesta se reenvía completa. Sin respuesta legible no se inventa un éxito ni un rechazo.
 */

const ORDER = '33333333-3333-4333-8333-333333333333';
const LINE = '44444444-4444-4444-8444-444444444444';
const ALTA = {
  selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0, 1] }],
  expectedTotalMinor: 9000,
  currency: 'USD',
};
const BAJA = { lineIds: [LINE], expectedTotalMinor: 4500, currency: 'USD' };

function pedido(body: unknown): Request {
  return new Request(`http://panel.test/api/orders/${ORDER}/services/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('addServicesBodyOf', () => {
  it('acepta qué y para quién, con lo que suma', () => {
    expect(addServicesBodyOf(ALTA)).toEqual(ALTA);
  });

  it.each([
    ['una tarjeta colada', { ...ALTA, payment: { card: '4111111111111111' } }],
    ['un precio por línea', { ...ALTA, selections: [{ ...ALTA.selections[0], amountMinor: 1 }] }],
    ['sin selecciones', { ...ALTA, selections: [] }],
    ['un servicio repetido', { ...ALTA, selections: [ALTA.selections[0], ALTA.selections[0]] }],
    [
      'un pasajero repetido',
      { ...ALTA, selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0, 0] }] },
    ],
    [
      'un pasajero fuera de rango',
      { ...ALTA, selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [9] }] },
    ],
    ['un total con decimales', { ...ALTA, expectedTotalMinor: 90.5 }],
    ['una moneda en minúsculas', { ...ALTA, currency: 'usd' }],
    ['nada', null],
  ])('rechaza %s', (_caso, raw) => {
    expect(addServicesBodyOf(raw)).toBeNull();
  });
});

describe('removeServicesBodyOf', () => {
  it('acepta líneas nuestras y lo que suman', () => {
    expect(removeServicesBodyOf(BAJA)).toEqual(BAJA);
  });

  it.each([
    ['ids del proveedor', { ...BAJA, lineIds: ['XBAG1'] }],
    ['una línea repetida', { ...BAJA, lineIds: [LINE, LINE] }],
    ['sin líneas', { ...BAJA, lineIds: [] }],
    ['una clave de más', { ...BAJA, providerItemIds: ['1'] }],
  ])('rechaza %s', (_caso, raw) => {
    expect(removeServicesBodyOf(raw)).toBeNull();
  });
});

describe('proxyServicesChange', () => {
  it('reenvía el alta validada a su ruta, y la respuesta tal cual', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 200, body: { outcome: 'ADDED', message: 'ok' } }),
    );
    const reply = await proxyServicesChange(pedido(ALTA), ORDER, 'add', call);
    expect(reply).toEqual({ status: 200, body: { outcome: 'ADDED', message: 'ok' } });
    expect(call).toHaveBeenCalledWith(`/orders/${ORDER}/services/add`, {
      method: 'POST',
      body: JSON.stringify(ALTA),
    });
  });

  it('la baja va a su ruta', async () => {
    const call = vi.fn(
      (_path: string, _init: RequestInit): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 200, body: { outcome: 'REMOVED' } }),
    );
    await proxyServicesChange(pedido(BAJA), ORDER, 'remove', call);
    expect(call.mock.calls[0]?.[0]).toBe(`/orders/${ORDER}/services/remove`);
  });

  it('un 409 llega con su mensaje', async () => {
    const reply = await proxyServicesChange(pedido(ALTA), ORDER, 'add', () =>
      Promise.resolve({ kind: 'json', status: 409, body: { message: 'El precio cambió.' } }),
    );
    expect(reply).toEqual({ status: 409, body: { message: 'El precio cambió.' } });
  });

  it('un cuerpo inválido no llega al API', async () => {
    const call = vi.fn();
    expect(await proxyServicesChange(pedido({ ...ALTA, x: 1 }), ORDER, 'add', call)).toEqual({
      status: 400,
      body: SERVICES_CHANGE_INVALID,
    });
    expect(await proxyServicesChange(pedido('no es json'), ORDER, 'add', call)).toEqual({
      status: 400,
      body: SERVICES_CHANGE_INVALID,
    });
    expect(await proxyServicesChange(pedido(ALTA), '../otra', 'add', call)).toEqual({
      status: 400,
      body: SERVICES_CHANGE_INVALID_ORDER,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('sin respuesta legible no se sabe si salió: 5xx que pide no repetirlo', async () => {
    const reply = await proxyServicesChange(pedido(ALTA), ORDER, 'add', () =>
      Promise.resolve({ kind: 'not-json', status: 404, message: 'html' }),
    );
    expect(reply).toEqual({
      status: 502,
      body: { statusCode: 502, message: SERVICES_CHANGE_UNREADABLE },
    });
  });
});
