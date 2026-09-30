import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { AuthService } from './auth.service.js';
import type { JwtService } from './jwt.service.js';
import type { LoginAttemptsService } from './login-attempts.service.js';
import type { MfaChallengeService } from './mfa-challenge.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordService } from './password.service.js';
import type { SeatService } from './seat.service.js';
import type { SessionService } from './session.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

/**
 * `GET /auth/session` es lo que lee la guardia del panel en cada ping (parseSessionSnapshot en
 * apps/web-b2b). Con `mfaRequired` y `mfaEnabled` se entera de que el rol pasó a exigir 2FA en
 * plena sesión; sin ellos, esa rama de la web nunca se activaba. Acá se fija la forma completa.
 */

const auth = new AuthService(
  {} as DatabaseService,
  {} as JwtService,
  {} as PasswordService,
  {} as AuditService,
  {} as MailerService,
  {} as SessionService,
  {} as MfaService,
  {} as SeatService,
  {} as MfaChallengeService,
  {} as TrustedDeviceService,
  {} as LoginAttemptsService,
);

const SESSION = {
  idleTimeoutSeconds: 1800,
  lastSeenAt: new Date('2026-09-29T12:00:00Z'),
  expiresAt: new Date('2026-09-29T23:00:00Z'),
};

function infoWith(ctx: RequestContext) {
  return requestContextStorage.run(ctx, () => auth.sessionInfo());
}

describe('AuthService.sessionInfo (GET /auth/session)', () => {
  it('devuelve el estado del 2FA completo que resolvió el middleware', () => {
    const info = infoWith({
      userId: 'u1',
      sessionId: 's1',
      session: SESSION,
      mfaRequired: true,
      mfaEnabled: false,
      mfaVerified: false,
    });

    expect(info).toEqual({
      sessionId: 's1',
      idleTimeoutSeconds: 1800,
      lastSeenAt: '2026-09-29T12:00:00.000Z',
      expiresAt: '2026-09-29T23:00:00.000Z',
      serverNow: expect.any(String) as string,
      mfaRequired: true,
      mfaEnabled: false,
      mfaVerified: false,
    });
  });

  it('lo que el contexto no trae es false, nunca ausente', () => {
    const info = infoWith({ userId: 'u1', sessionId: 's1', session: SESSION });
    expect(info).toMatchObject({ mfaRequired: false, mfaEnabled: false, mfaVerified: false });
  });

  it('sin sesión validada, 401', () => {
    expect(() => infoWith({ userId: 'u1' })).toThrow(UnauthorizedException);
  });
});
