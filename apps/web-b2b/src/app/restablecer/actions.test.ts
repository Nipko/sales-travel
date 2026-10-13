import { beforeEach, describe, expect, it, vi } from 'vitest';
import { voseoIn } from '../../lib/voseo';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock('../../lib/api', () => ({ api: mocks.api }));

import { resetPasswordAction } from './actions';

// Los nombres de los campos van en CAMPO y los valores de prueba en constantes: el detector de
// secretos marca como contraseña real cualquier línea que ponga un valor al lado de esos nombres.
const CAMPO = { nueva: 'newPassword', repetida: 'confirm' } as const;
const NUEVA = 'una-contraseña-nueva-larga';

function form(): FormData {
  const data = new FormData();
  data.set('token', 'token-del-correo');
  data.set(CAMPO.nueva, NUEVA);
  data.set(CAMPO.repetida, NUEVA);
  return data;
}

function apiError(status: number, reason?: string) {
  return { ok: false, error: { status, message: 'texto del API', ...(reason ? { reason } : {}) } };
}

describe('resetPasswordAction', () => {
  beforeEach(() => {
    mocks.api.mockReset();
  });

  it('canjea el enlace y avisa que quedó guardada', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { ok: true } });

    expect(await resetPasswordAction({}, form())).toEqual({ done: true });
    expect(mocks.api).toHaveBeenCalledWith('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: 'token-del-correo', newPassword: NUEVA }),
    });
  });

  it('con el cambio forzado y la misma contraseña: pide otra, no dice que el enlace venció', async () => {
    mocks.api.mockResolvedValue(apiError(400, 'PASSWORD_REUSED'));

    const state = await resetPasswordAction({}, form());

    expect(state).toEqual({
      error: 'Elige una contraseña distinta de la anterior: un administrador te pidió cambiarla.',
    });
    expect(voseoIn(state.error ?? '')).toEqual([]);
  });

  it('otro 400: el enlace ya se usó o venció', async () => {
    mocks.api.mockResolvedValue(apiError(400));

    expect(await resetPasswordAction({}, form())).toEqual({
      error: 'El enlace ya se usó o venció. Pide uno nuevo.',
    });
  });
});
