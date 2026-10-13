import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { requestContextStorage } from '../request-context/request-context.js';
import { AuthController } from './auth.controller.js';
import type { AuthService } from './auth.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordResetService } from './password-reset.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

/*
 * POST /auth/step-up reconfirma el 2FA de la sesión DEL REQUEST: el id sale del contexto que validó
 * el middleware, nunca del cuerpo.
 */

const SESSION = '5e551011-0000-4000-8000-0000000000aa';
const VERIFIED = new Date('2026-10-13T15:00:00.000Z');

function controller() {
  const stepUp = vi.fn(() => Promise.resolve({ verifiedAt: VERIFIED }));
  const ctl = new AuthController(
    {} as AuthService,
    { stepUp } as unknown as MfaService,
    {} as PasswordResetService,
    {} as TrustedDeviceService,
  );
  return { ctl, stepUp };
}

describe('AuthController.stepUp', () => {
  it('reconfirma la sesión del request y devuelve el instante', async () => {
    const { ctl, stepUp } = controller();
    const res = await requestContextStorage.run({ userId: 'u-1', sessionId: SESSION }, () =>
      ctl.stepUp('u-1', { code: '123456' }),
    );
    expect(res).toEqual({ ok: true, verifiedAt: VERIFIED.toISOString() });
    expect(stepUp).toHaveBeenCalledWith('u-1', SESSION, '123456');
  });

  it('sin usuario o sin sesión: 401 sin probar el código', async () => {
    const { ctl, stepUp } = controller();
    await expect(
      requestContextStorage.run({ userId: 'u-1' }, () => ctl.stepUp('u-1', { code: '123456' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      requestContextStorage.run({ sessionId: SESSION }, () =>
        ctl.stepUp(undefined, { code: '123456' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stepUp).not.toHaveBeenCalled();
  });
});
