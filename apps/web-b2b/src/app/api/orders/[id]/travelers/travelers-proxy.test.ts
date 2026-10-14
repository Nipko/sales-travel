import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../../../../lib/api';
import {
  TRAVELERS_INVALID,
  TRAVELERS_INVALID_ORDER,
  TRAVELERS_READ_UNREADABLE,
  TRAVELERS_UNREADABLE,
  modifyTravelersBodyOf,
  proxyTravelersChange,
  proxyTravelersRead,
} from './travelers-proxy';

/*
 * `GET` y `PATCH /api/orders/:id/travelers` (SAB-25): el cuerpo se valida en el borde y la respuesta
 * se reenvía completa. Sin respuesta legible no se inventa un éxito ni un rechazo.
 */

const ORDER = '33333333-3333-4333-8333-333333333333';
const CAMBIO = {
  travelers: [
    {
      index: 0,
      identityDocument: {
        type: 'PASSPORT',
        number: 'AB1234567',
        issuingCountry: 'CO',
        nationality: 'CO',
        expiryDate: '2034-05-31',
      },
      loyalty: { carrierCode: 'AV', number: '55667788' },
      specialServices: ['WCHR'],
    },
  ],
};

function pedido(body: unknown): Request {
  return new Request(`http://panel.test/api/orders/${ORDER}/travelers`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('modifyTravelersBodyOf', () => {
  it('acepta documento, viajero frecuente y servicios especiales de la lista', () => {
    expect(modifyTravelersBodyOf(CAMBIO)).toEqual(CAMBIO);
  });

  const conCambio = (cambio: Record<string, unknown>) => ({
    travelers: [{ ...CAMBIO.travelers[0], ...cambio }],
  });

  it.each([
    ['un nombre colado', conCambio({ givenName: 'Otro' })],
    ['un contacto colado', { ...CAMBIO, contactInfo: {} }],
    ['un SSR fuera de la lista', conCambio({ specialServices: ['XBAG'] })],
    ['texto libre como SSR', conCambio({ specialServices: ['WCHR/OSI'] })],
    ['un SSR repetido', conCambio({ specialServices: ['WCHR', 'WCHR'] })],
    [
      'un número con separadores',
      conCambio({ identityDocument: { ...CAMBIO.travelers[0]!.identityDocument, number: 'AB-1' } }),
    ],
    [
      'un tipo que no se edita',
      conCambio({ identityDocument: { ...CAMBIO.travelers[0]!.identityDocument, type: 'VISA' } }),
    ],
    [
      'un campo de más en el documento',
      conCambio({ identityDocument: { ...CAMBIO.travelers[0]!.identityDocument, surname: 'X' } }),
    ],
    [
      'una aerolínea de tres letras',
      conCambio({ loyalty: { carrierCode: 'AVA', number: '1234' } }),
    ],
    ['un pasajero fuera de rango', { travelers: [{ index: 9, specialServices: [] }] }],
    [
      'el mismo pasajero dos veces',
      {
        travelers: [
          { index: 0, specialServices: [] },
          { index: 0, specialServices: ['WCHR'] },
        ],
      },
    ],
    ['un pasajero sin cambios', { travelers: [{ index: 0 }] }],
    ['sin pasajeros', { travelers: [] }],
    ['nada', null],
  ])('rechaza %s', (_caso, raw) => {
    expect(modifyTravelersBodyOf(raw)).toBeNull();
  });
});

describe('proxyTravelersChange', () => {
  it('reenvía el cambio validado y la respuesta completa, con su estado', async () => {
    const call = vi.fn(
      (): Promise<ApiResponse> =>
        Promise.resolve({ kind: 'json', status: 409, body: { message: 'Ya hay un cambio' } }),
    );
    const reply = await proxyTravelersChange(pedido(CAMBIO), ORDER, call);
    expect(reply).toEqual({ status: 409, body: { message: 'Ya hay un cambio' } });
    expect(call).toHaveBeenCalledWith(`/orders/${ORDER}/travelers`, {
      method: 'PATCH',
      body: JSON.stringify(CAMBIO),
    });
  });

  it('un cuerpo inválido, ilegible o una orden que no es un UUID no salen del borde', async () => {
    const call = vi.fn();
    expect(await proxyTravelersChange(pedido({ travelers: [] }), ORDER, call)).toEqual({
      status: 400,
      body: TRAVELERS_INVALID,
    });
    expect(await proxyTravelersChange(pedido('{no json'), ORDER, call)).toEqual({
      status: 400,
      body: TRAVELERS_INVALID,
    });
    expect(await proxyTravelersChange(pedido(CAMBIO), 'ABC', call)).toEqual({
      status: 400,
      body: TRAVELERS_INVALID_ORDER,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('sin respuesta legible no inventa nada: 5xx y que revise la reserva', async () => {
    const reply = await proxyTravelersChange(pedido(CAMBIO), ORDER, () =>
      Promise.resolve({ kind: 'unreachable', status: 503, message: 'x' }),
    );
    expect(reply).toEqual({
      status: 503,
      body: { statusCode: 503, message: TRAVELERS_UNREADABLE },
    });
    const html = await proxyTravelersChange(pedido(CAMBIO), ORDER, () =>
      Promise.resolve({ kind: 'not-json', status: 200, message: 'x' }),
    );
    expect(html.status).toBe(502);
  });
});

describe('proxyTravelersRead', () => {
  it('reenvía la lectura, y sin respuesta legible dice que no se pudo consultar', async () => {
    const ok = await proxyTravelersRead(ORDER, () =>
      Promise.resolve({ kind: 'json', status: 200, body: { kind: 'travelers' } }),
    );
    expect(ok).toEqual({ status: 200, body: { kind: 'travelers' } });
    const caida = await proxyTravelersRead(ORDER, () =>
      Promise.resolve({ kind: 'not-json', status: 404, message: 'x' }),
    );
    expect(caida).toEqual({
      status: 502,
      body: { statusCode: 502, message: TRAVELERS_READ_UNREADABLE },
    });
    expect(await proxyTravelersRead('nada', vi.fn())).toEqual({
      status: 400,
      body: TRAVELERS_INVALID_ORDER,
    });
  });
});
