import { describe, expect, it } from 'vitest';
import {
  LoginSchema,
  LogoutSchema,
  MfaDisableSchema,
  MfaEnrollSchema,
  MfaVerifySchema,
  SeatReleaseSchema,
} from './dto.js';

describe('DTOs de auth', () => {
  it('login: una cookie de equipo rota no hace fallar el login, sólo se descarta', () => {
    const base = { email: 'Ana@Test.local', password: 'x' };
    expect(LoginSchema.parse({ ...base, trustedDeviceToken: 'abc' })).toEqual({
      email: 'ana@test.local',
      password: 'x',
      trustedDeviceToken: 'abc',
    });
    for (const bad of ['', 'x'.repeat(600), 42, null]) {
      expect(LoginSchema.parse({ ...base, trustedDeviceToken: bad }).trustedDeviceToken).toBe(
        undefined,
      );
    }
    expect(LoginSchema.parse(base).trustedDeviceToken).toBeUndefined();
  });

  it('mfa/verify: "recordar este equipo" es opcional y por defecto no', () => {
    const parsed = MfaVerifySchema.parse({ mfaToken: 'x'.repeat(20), code: ' 123456 ' });
    expect(parsed).toEqual({ mfaToken: 'x'.repeat(20), code: '123456', rememberDevice: false });
    expect(
      MfaVerifySchema.parse({ mfaToken: 'x'.repeat(20), code: 'ABCDE-12345', rememberDevice: true })
        .rememberDevice,
    ).toBe(true);
  });

  it('mfa/enroll: sin cuerpo es un enrolamiento; con contraseña y código, una rotación', () => {
    expect(MfaEnrollSchema.parse(undefined)).toEqual({});
    expect(MfaEnrollSchema.parse({ currentPassword: 'p', code: '123456' })).toEqual({
      currentPassword: 'p',
      code: '123456',
    });
  });

  it('mfa/disable exige contraseña y código', () => {
    expect(MfaDisableSchema.safeParse({ currentPassword: 'p' }).success).toBe(false);
    expect(MfaDisableSchema.safeParse({ currentPassword: 'p', code: '123456' }).success).toBe(true);
  });

  it('logout: el motivo es opcional y nunca rompe', () => {
    expect(LogoutSchema.parse(undefined)).toEqual({});
    expect(LogoutSchema.parse({ reason: 'idle' })).toEqual({ reason: 'idle' });
    expect(LogoutSchema.parse({ reason: 'otra-cosa' }).reason).toBeUndefined();
  });

  it('seats/release exige el permiso y el id de una sesión', () => {
    expect(
      SeatReleaseSchema.safeParse({ releaseToken: 'x'.repeat(20), sessionId: 'no-uuid' }).success,
    ).toBe(false);
    expect(
      SeatReleaseSchema.safeParse({
        releaseToken: 'x'.repeat(20),
        sessionId: '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
      }).success,
    ).toBe(true);
  });
});
