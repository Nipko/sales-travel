import { describe, expect, it } from 'vitest';
import { estadoHttpValido, readApiResponse, SERVICIO_NO_DISPONIBLE } from './api';

/**
 * La avería concreta: `ApiError.status` viaja sin mirar a 48 rutas de `app/api/`, que hacen
 * `NextResponse.json(cuerpo, { status })`. Ese `status` tiene que estar entre 200 y 599; con
 * cualquier otra cosa lanza `RangeError`, Next responde su página HTML de error, y el cliente
 * —que espera JSON— muere con «Unexpected token '<', "<!DOCTYPE "... is not valid JSON».
 *
 * Un fallo de conexión al API devolvía `status: 0`. O sea: el mensaje que veía el vendedor no se
 * parecía en nada a lo que había pasado, y apuntaba al sitio equivocado para depurarlo.
 */
describe('estadoHttpValido: ningún estado puede reventar NextResponse.json', () => {
  it('el 0 del fallo de conexión se convierte en 503, que es lo que de verdad pasó', () => {
    expect(estadoHttpValido(0)).toBe(SERVICIO_NO_DISPONIBLE);
    expect(SERVICIO_NO_DISPONIBLE).toBe(503);
  });

  it('los estados reales del API pasan intactos', () => {
    for (const status of [200, 201, 400, 401, 403, 404, 409, 422, 500, 502, 503, 599]) {
      expect(estadoHttpValido(status)).toBe(status);
    }
  });

  it('todo lo que está fuera del rango cae a 503 en vez de reventar la ruta', () => {
    for (const status of [-1, 0, 1, 100, 199, 600, 999, 1000]) {
      expect(estadoHttpValido(status)).toBe(SERVICIO_NO_DISPONIBLE);
    }
  });

  it('lo que ni siquiera es un entero tampoco se cuela', () => {
    for (const status of [Number.NaN, Number.POSITIVE_INFINITY, 200.5]) {
      expect(estadoHttpValido(status)).toBe(SERVICIO_NO_DISPONIBLE);
    }
  });
});

/**
 * `readApiResponse` es lo que usa la ruta de reserva de hotel (RF-22): tiene que dejar pasar el
 * estado y el cuerpo ENTEROS, porque ahí viajan el `202` de una reserva en curso, el precio nuevo
 * de un `409` y las marcas que prohíben repetirla.
 */
describe('readApiResponse: estado y cuerpo completos', () => {
  it('un 202 sigue siendo 202, con su cuerpo', async () => {
    const body = { orderId: 'o-1', status: 'pending', retryForbidden: true };
    const read = await readApiResponse(new Response(JSON.stringify(body), { status: 202 }));
    expect(read).toEqual({ kind: 'json', status: 202, body });
  });

  it('un error conserva todo su cuerpo, no sólo `message`', async () => {
    const body = {
      statusCode: 409,
      message: 'El precio subió.',
      reason: 'PRICE_INCREASED',
      details: { currentTotal: { amountMinor: 1, currency: 'USD' } },
      orderId: 'o-1',
      duplicateRequest: true,
    };
    const read = await readApiResponse(new Response(JSON.stringify(body), { status: 409 }));
    expect(read).toEqual({ kind: 'json', status: 409, body });
  });

  it('una página de un proxy no rompe: queda el estado y un mensaje que dice qué hacer', async () => {
    const read = await readApiResponse(
      new Response('<!DOCTYPE html><html>timeout</html>', { status: 524 }),
    );
    expect(read.kind).toBe('not-json');
    expect(read.status).toBe(524);
    if (read.kind === 'not-json') expect(read.message).toMatch(/NO la repitas/);
  });
});
