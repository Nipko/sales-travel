import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    RedirectSignal,
    apiWithStatus: vi.fn(),
    setSession: vi.fn(),
    clearSession: vi.fn(),
    clearTrustedDevice: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus }));
vi.mock('../../../../lib/session', () => ({
  setSession: mocks.setSession,
  clearSession: mocks.clearSession,
  clearTrustedDevice: mocks.clearTrustedDevice,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
}));

import {
  changePasswordAction,
  confirmMfaAction,
  disableMfaAction,
  enrollMfaAction,
  regenerateRecoveryCodesAction,
  revokeAllSessionsAction,
  revokeAllTrustedDevicesAction,
  revokeSessionAction,
  revokeTrustedDeviceAction,
  startPhoneChangeAction,
} from './actions';

// Los nombres de los campos de contraseña van en CAMPO y los valores de prueba en constantes: el
// detector de secretos de GitGuardian marca como contraseña real cualquier línea que ponga un valor
// al lado de esos nombres, aunque sea un texto de prueba.
const CAMPO = { actual: 'currentPassword', nueva: 'newPassword' } as const;
const ACTUAL_LARGA = 'mi-contraseña-larga';
const VIEJA = 'la-contraseña-vieja';
const NUEVA = 'una-contraseña-nueva-larga';
const CORTA = 'corta';
const DISTINTA = 'otra-cosa-distinta-12';
const MISMA = 'misma-contraseña-1';

const SESSION_ID = '0b5f7c1e-3a2d-4c8e-9f10-2b3c4d5e6f70';
const CODES = ['AAAAA-11111', 'BBBBB-22222', 'CCCCC-33333'];

function json(status: number, body: unknown) {
  return { kind: 'json' as const, status, body };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** El cuerpo que se mandó al API en la llamada `n`. */
function sentBody(n = 0): unknown {
  const init = mocks.apiWithStatus.mock.calls[n]?.[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return err.url;
    throw err;
  }
  throw new Error('no redirigió');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enrolamiento', () => {
  it('enrollMfaAction devuelve el secreto y el otpauth', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x?secret=JBSW' }),
    );
    await expect(enrollMfaAction()).resolves.toEqual({
      ok: true,
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/x?secret=JBSW',
    });
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/auth/mfa/enroll', { method: 'POST' });
  });

  it('una respuesta sin otpauth válido no se muestra como QR', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { secret: 'X', otpauthUri: 'https://x' }));
    expect((await enrollMfaAction()).error).toMatch(/No pudimos generar el código QR/);
  });

  it('con el 2FA ya activo (otra pestaña) lo explica', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(409, { message: 'x', reason: 'MFA_ALREADY_ENABLED' }),
    );
    expect((await enrollMfaAction()).error).toMatch(/ya está activa/);
  });

  it('cambiar de teléfono manda contraseña y código actual', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(200, { secret: 'NEWSECRET', otpauthUri: 'otpauth://totp/x?secret=NEW' }),
    );
    const res = await startPhoneChangeAction(
      form({ [CAMPO.actual]: ACTUAL_LARGA, code: '123 456' }),
    );
    expect(res.secret).toBe('NEWSECRET');
    expect(sentBody()).toEqual({ [CAMPO.actual]: ACTUAL_LARGA, code: '123456' });
  });

  it('cambiar de teléfono sin contraseña o sin código no llama al API', async () => {
    expect((await startPhoneChangeAction(form({ code: '123456' }))).error).toMatch(/contraseña/);
    expect((await startPhoneChangeAction(form({ [CAMPO.actual]: 'x', code: '12' }))).error).toMatch(
      /6 dígitos/,
    );
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('cambiar de teléfono con credenciales incorrectas: error del formulario, sin salir', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(401, { message: 'Unauthorized' }));
    const res = await startPhoneChangeAction(form({ [CAMPO.actual]: 'x', code: '123456' }));
    expect(res.error).toBe('La contraseña o el código no son correctos.');
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });
});

describe('confirmMfaAction', () => {
  it('devuelve los códigos y NO revalida (los códigos tienen que llegar a verse)', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { recoveryCodes: CODES }));
    await expect(confirmMfaAction(form({ code: '654321' }))).resolves.toEqual({
      ok: true,
      recoveryCodes: CODES,
    });
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      '/auth/mfa/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(sentBody()).toEqual({ code: '654321' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('un código con forma inválida no llega al API', async () => {
    expect((await confirmMfaAction(form({ code: 'abc' }))).error).toMatch(/6 dígitos/);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('código incorrecto: mensaje y, si el API los informa, los intentos que quedan', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(401, { message: 'x', reason: 'MFA_CODE_INVALID', details: { attemptsLeft: 2 } }),
    );
    const res = await confirmMfaAction(form({ code: '000000' }));
    expect(res.error).toMatch(/El código no es válido/);
    expect(res.error).toMatch(/Te quedan 2 intentos/);
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });

  it('si la sesión se abrió en otro dispositivo, al login con el motivo y la vuelta a Seguridad', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(401, { message: 'x', reason: 'SESSION_REPLACED' }),
    );
    await expect(redirectOf(confirmMfaAction(form({ code: '111111' })))).resolves.toBe(
      '/login?motivo=otro-dispositivo&next=%2Fconfiguracion%2Fseguridad',
    );
    expect(mocks.clearSession).toHaveBeenCalledTimes(1);
  });

  it('una respuesta sin códigos no se da por buena', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { recoveryCodes: [] }));
    expect((await confirmMfaAction(form({ code: '111111' }))).error).toMatch(/No recibimos/);
  });
});

describe('regenerateRecoveryCodesAction', () => {
  it('pide un código TOTP y devuelve los códigos nuevos sin revalidar', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { recoveryCodes: CODES }));
    const res = await regenerateRecoveryCodesAction(form({ code: '222222' }));
    expect(res.recoveryCodes).toEqual(CODES);
    expect(mocks.apiWithStatus.mock.calls[0]?.[0]).toBe('/auth/mfa/recovery-codes');
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('disableMfaAction', () => {
  it('exige contraseña y código', async () => {
    expect((await disableMfaAction(form({ code: '123456' }))).error).toMatch(/contraseña/);
    expect((await disableMfaAction(form({ [CAMPO.actual]: 'x' }))).error).toMatch(/6 dígitos/);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('si el rol lo exige, lo dice', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(403, { message: 'x', reason: 'MFA_REQUIRED_BY_ROLE' }),
    );
    const res = await disableMfaAction(form({ [CAMPO.actual]: 'x', code: '123456' }));
    expect(res.error).toMatch(/Tu rol exige/);
  });

  it('si el API cerró también esta sesión, al login', async () => {
    mocks.apiWithStatus
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(401, { message: 'x', reason: 'SESSION_REVOKED' }));
    await expect(
      redirectOf(disableMfaAction(form({ [CAMPO.actual]: 'x', code: '123456' }))),
    ).resolves.toBe('/login?motivo=cerrada');
    expect(sentBody(0)).toEqual({ [CAMPO.actual]: 'x', code: '123456' });
    expect(mocks.clearSession).toHaveBeenCalled();
  });

  it('sin el teléfono, con un código de recuperación (se manda sin guion y en mayúsculas)', async () => {
    mocks.apiWithStatus
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { enabled: false }));
    const res = await disableMfaAction(
      form({ [CAMPO.actual]: 'x', mode: 'recovery', code: ' abcde-12345 ' }),
    );
    expect(res).toEqual({ ok: true });
    expect(sentBody(0)).toEqual({ [CAMPO.actual]: 'x', code: 'ABCDE12345' });
  });

  it('un código de recuperación mal tipeado no llega al API', async () => {
    for (const code of ['ABCDE-1234', 'GHIJK-12345', '123456', '']) {
      const res = await disableMfaAction(form({ [CAMPO.actual]: 'x', mode: 'recovery', code }));
      expect(res.error).toMatch(/código de recuperación: son 10 caracteres/);
    }
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('en modo app, un código de recuperación no pasa por uno de 6 dígitos', async () => {
    const res = await disableMfaAction(form({ [CAMPO.actual]: 'x', code: 'ABCDE-12345' }));
    expect(res.error).toMatch(/6 dígitos/);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('si la sesión sigue viva, revalida', async () => {
    mocks.apiWithStatus
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { enabled: false }));
    const res = await disableMfaAction(form({ [CAMPO.actual]: 'x', code: '123456' }));
    expect(res).toEqual({ ok: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/configuracion/seguridad');
  });
});

describe('changePasswordAction', () => {
  const valid = {
    [CAMPO.actual]: VIEJA,
    [CAMPO.nueva]: NUEVA,
    confirm: NUEVA,
  };

  it('guarda el token nuevo: la sesión actual sigue', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(200, { ok: true, token: 'nuevo.jwt.token', expiresAt: '2026-09-30T00:00:00.000Z' }),
    );
    await expect(changePasswordAction(form(valid))).resolves.toEqual({ ok: true });
    expect(sentBody()).toEqual({
      [CAMPO.actual]: valid[CAMPO.actual],
      [CAMPO.nueva]: valid[CAMPO.nueva],
    });
    expect(mocks.setSession).toHaveBeenCalledWith('nuevo.jwt.token', '2026-09-30T00:00:00.000Z');
    // Los equipos de confianza anteriores al cambio ya no valen en el API.
    expect(mocks.clearTrustedDevice).toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/configuracion/seguridad');
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });

  it('un API sin token nuevo que cerró la sesión: al login en vez de un panel roto', async () => {
    mocks.apiWithStatus
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(401, { message: 'x' }));
    await expect(redirectOf(changePasswordAction(form(valid)))).resolves.toBe(
      '/login?motivo=cerrada',
    );
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it('valida antes de llamar al API', async () => {
    expect((await changePasswordAction(form({ ...valid, [CAMPO.actual]: '' }))).error).toMatch(
      /contraseña actual/,
    );
    expect(
      (await changePasswordAction(form({ ...valid, [CAMPO.nueva]: CORTA, confirm: CORTA }))).error,
    ).toMatch(/al menos 12/);
    expect((await changePasswordAction(form({ ...valid, confirm: DISTINTA }))).error).toMatch(
      /no coinciden/,
    );
    expect(
      (
        await changePasswordAction(
          form({
            [CAMPO.actual]: MISMA,
            [CAMPO.nueva]: MISMA,
            confirm: MISMA,
          }),
        )
      ).error,
    ).toMatch(/distinta de la actual/);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('contraseña actual incorrecta (401 sin motivo): error del formulario, sin cerrar la sesión', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(401, { message: 'Unauthorized' }));
    const res = await changePasswordAction(form(valid));
    expect(res.error).toBe('La contraseña actual no es correcta.');
    expect(mocks.clearSession).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
  });
});

describe('sesiones', () => {
  it('cierra una sesión por id', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { ok: true }));
    await expect(revokeSessionAction(SESSION_ID)).resolves.toEqual({ ok: true });
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/auth/sessions/${SESSION_ID}/revoke`, {
      method: 'POST',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/configuracion/seguridad');
  });

  it('si ya estaba cerrada, cuenta como hecho y refresca la lista (no deja la fila vieja)', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(404, { message: 'x', reason: 'SESSION_NOT_FOUND' }),
    );
    await expect(revokeSessionAction(SESSION_ID)).resolves.toEqual({ ok: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/configuracion/seguridad');
  });

  it('otros errores sí se muestran, sin refrescar', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(400, { message: 'x', reason: 'CANNOT_REVOKE_CURRENT_SESSION' }),
    );
    expect((await revokeSessionAction(SESSION_ID)).error).toMatch(/Cerrar sesión/);
    mocks.apiWithStatus.mockResolvedValueOnce(json(404, { message: 'Not Found' }));
    expect((await revokeSessionAction(SESSION_ID)).error).toBeDefined();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('un id que no es uuid no se interpola en la ruta', async () => {
    expect((await revokeSessionAction('../logout-all')).error).toBeDefined();
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('un 204 también es éxito', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({ kind: 'not-json', status: 204, message: '' });
    await expect(revokeSessionAction(SESSION_ID)).resolves.toEqual({ ok: true });
  });

  it('cerrar en todos los dispositivos borra la cookie y va al login', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { revoked: 3 }));
    await expect(redirectOf(revokeAllSessionsAction())).resolves.toBe('/login?motivo=cerrada');
    expect(mocks.apiWithStatus.mock.calls[0]?.[0]).toBe('/auth/logout-all');
    expect(mocks.clearSession).toHaveBeenCalled();
  });

  it('si falla, no borra nada', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'unreachable',
      status: 503,
      message: 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.',
    });
    expect((await revokeAllSessionsAction()).error).toMatch(/No pudimos conectar/);
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });
});

describe('equipos de confianza', () => {
  it('quitar ESTE equipo borra también su cookie', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { ok: true }));
    await revokeTrustedDeviceAction(SESSION_ID, true);
    expect(mocks.apiWithStatus.mock.calls[0]?.[0]).toBe(
      `/auth/trusted-devices/${SESSION_ID}/revoke`,
    );
    expect(mocks.clearTrustedDevice).toHaveBeenCalled();
  });

  it('quitar otro equipo no toca la cookie de éste', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { ok: true }));
    await revokeTrustedDeviceAction(SESSION_ID, false);
    expect(mocks.clearTrustedDevice).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it('si ya no estaba, cuenta como hecho: refresca y, si era éste, borra la cookie muerta', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(404, { message: 'x', reason: 'TRUSTED_DEVICE_NOT_FOUND' }),
    );
    await expect(revokeTrustedDeviceAction(SESSION_ID, true)).resolves.toEqual({ ok: true });
    expect(mocks.clearTrustedDevice).toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/configuracion/seguridad');
  });

  it('un error de verdad al quitar no toca la cookie ni refresca', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(500, { message: 'Internal server error' }));
    expect((await revokeTrustedDeviceAction(SESSION_ID, true)).error).toMatch(/No pudimos/);
    expect(mocks.clearTrustedDevice).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('quitar todos borra la cookie', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(200, { revoked: 2 }));
    await expect(revokeAllTrustedDevicesAction()).resolves.toEqual({ ok: true });
    expect(mocks.apiWithStatus.mock.calls[0]?.[0]).toBe('/auth/trusted-devices/revoke-all');
    expect(mocks.clearTrustedDevice).toHaveBeenCalled();
  });

  it('un id inválido no llega al API', async () => {
    expect((await revokeTrustedDeviceAction('x', false)).error).toBeDefined();
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});
