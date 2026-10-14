import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel para la post-venta del superadmin sobre una reserva de otro nodo. Hacen lo más
 * delicado de la consola (cancelar en nombre de una agencia) con la cookie de quien las llama: sólo
 * reenvían lo que viene del propio panel, con el cuerpo rearmado campo por campo.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('../../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import { POST as cancel } from './cancel/route';
import { GET as estimate } from './cancellation-estimate/route';
import { POST as retry } from './operations/[opId]/retry/route';
import { POST as retrieve } from './retrieve/route';
import { POST as sendConfirmation } from './send-confirmation/route';

const ORDER = '20000000-0000-4000-8000-0000000000BB';
const OPERATION = '40000000-0000-4000-8000-0000000000CC';
const BASE = `/admin/orders/${ORDER.toLowerCase()}`;
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

function post(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`https://app.test/api/admin/orders/${ORDER}/x`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const order = { params: Promise.resolve({ orderId: ORDER }) };

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({ kind: 'json', status: 200, body: { ok: true } });
});

describe('sólo desde el panel', () => {
  it('desde otro sitio no se reenvía nada: 403', async () => {
    for (const handler of [sendConfirmation, retrieve, cancel]) {
      const res = await handler(
        post({ reason: 'Lo pidió el cliente', orderNumber: 1 }, { 'sec-fetch-site': 'same-site' }),
        order,
      );
      expect(res.status).toBe(403);
    }
    const res = await retry(
      post({ reason: 'Lo pidió el cliente' }, { 'sec-fetch-site': 'cross-site' }),
      {
        params: Promise.resolve({ orderId: ORDER, opId: OPERATION }),
      },
    );
    expect(res.status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});

describe('cada acción, con su cuerpo rearmado', () => {
  it('reenviar y consultar: sólo el motivo', async () => {
    await sendConfirmation(post({ reason: 'Lo pidió el cliente', to: 'otro@x.co' }), order);
    expect(mocks.apiWithStatus).toHaveBeenLastCalledWith(`${BASE}/send-confirmation`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Lo pidió el cliente' }),
    });
    await retrieve(post({ reason: 'Revisar el estado' }), order);
    expect(mocks.apiWithStatus).toHaveBeenLastCalledWith(`${BASE}/retrieve`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Revisar el estado' }),
    });
  });

  it('reintentar: la operación en la ruta', async () => {
    await retry(post({ reason: 'La agencia no entra' }), {
      params: Promise.resolve({ orderId: ORDER, opId: OPERATION }),
    });
    expect(mocks.apiWithStatus).toHaveBeenLastCalledWith(
      `${BASE}/operations/${OPERATION.toLowerCase()}/retry`,
      { method: 'POST', body: JSON.stringify({ reason: 'La agencia no entra' }) },
    );
  });

  it('cancelar: el motivo y el número escrito', async () => {
    await cancel(post({ reason: 'Pedido del cliente', orderNumber: 1042, extra: true }), order);
    expect(mocks.apiWithStatus).toHaveBeenLastCalledWith(`${BASE}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Pedido del cliente', orderNumber: 1042 }),
    });
  });

  it('sin motivo o con un cuerpo ilegible: 400 sin llamar al API', async () => {
    for (const body of ['no-json', {}, { reason: 7 }]) {
      const res = await sendConfirmation(post(body), order);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Escribe el motivo: queda en la auditoría.' });
    }
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('el error del API vuelve con su mensaje y su motivo de máquina', async () => {
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 400,
      body: {
        message: 'El número de orden no coincide: escríbelo tal como aparece en la reserva.',
        reason: 'ORDER_NUMBER_MISMATCH',
      },
    });
    const res = await cancel(post({ reason: 'Pedido del cliente', orderNumber: 1 }), order);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'El número de orden no coincide: escríbelo tal como aparece en la reserva.',
      reason: 'ORDER_NUMBER_MISMATCH',
    });
  });
});

describe('la penalidad estimada', () => {
  it('es una lectura: GET al API, sin cuerpo', async () => {
    const res = await estimate(new Request('https://app.test/x'), order);
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`${BASE}/cancellation-estimate`);
  });
});
