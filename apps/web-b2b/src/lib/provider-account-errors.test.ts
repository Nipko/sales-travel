import { describe, expect, it } from 'vitest';
import { providerAccountSaveError } from './provider-account-errors';

/** RF-29 CA 2 en Mi Red → Credenciales: el 409 de una cuenta con reservas vivas es un aviso. */

const MENSAJE =
  'Esta cuenta tiene 3 reserva(s) activa(s) hechas con ella. No se puede desactivar hasta que terminen: es la única con la que el proveedor deja consultarlas y cancelarlas. Podés actualizar la contraseña sin desactivarla.';

describe('providerAccountSaveError', () => {
  it('409 PROVIDER_ACCOUNT_IN_USE: aviso con el conteo y el motivo del API tal cual', () => {
    const error = providerAccountSaveError(
      409,
      { error: MENSAJE, reason: 'PROVIDER_ACCOUNT_IN_USE', details: { activeOrders: 3 } },
      'Error al guardar credenciales',
    );
    expect(error).toEqual({
      kind: 'in-use',
      notice: {
        tone: 'warn',
        title: 'No se guardó: la cuenta tiene 3 reservas activas',
        body: MENSAJE,
      },
    });
  });

  it('una sola reserva, en singular; sin conteo, que no se pudo comprobar', () => {
    const una = providerAccountSaveError(
      409,
      { error: 'x', reason: 'PROVIDER_ACCOUNT_IN_USE', details: { activeOrders: 1 } },
      'f',
    );
    expect(una.kind === 'in-use' && una.notice.title).toBe(
      'No se guardó: la cuenta tiene 1 reserva activa',
    );
    const sinConteo = providerAccountSaveError(
      409,
      { error: 'x', reason: 'PROVIDER_ACCOUNT_IN_USE', details: { activeOrders: null } },
      'f',
    );
    expect(sinConteo.kind === 'in-use' && sinConteo.notice.title).toMatch(/no pudimos comprobar/);
  });

  it('se reconoce por el código, no por el texto: otro 409 es un error común', () => {
    expect(
      providerAccountSaveError(409, { error: 'reserva(s) activa(s)', reason: 'OTRO' }, 'f'),
    ).toEqual({ kind: 'error', message: 'reserva(s) activa(s)' });
    expect(providerAccountSaveError(400, { message: ['a', 'b'] }, 'f')).toEqual({
      kind: 'error',
      message: 'a, b',
    });
    expect(providerAccountSaveError(500, null, 'Error al guardar')).toEqual({
      kind: 'error',
      message: 'Error al guardar',
    });
  });
});
