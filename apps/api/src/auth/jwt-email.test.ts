import { beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from './jwt.service.js';

/**
 * Verifica los tokens de verificación de email y, sobre todo, la SEPARACIÓN DE AUDIENCIA:
 * un token de email NO debe servir como bearer de API y viceversa (propiedad de seguridad).
 */
describe('JwtService email tokens', () => {
  const svc = new JwtService();

  beforeAll(() => {
    process.env['JWT_SECRET'] = 'x'.repeat(32);
    svc.onModuleInit();
  });

  it('signs and verifies an email token (returns the userId)', async () => {
    const token = await svc.signEmailToken('user-1');
    expect(await svc.verifyEmailToken(token)).toBe('user-1');
  });

  it('an email token is NOT accepted as an access token (different audience)', async () => {
    const token = await svc.signEmailToken('user-1');
    await expect(svc.verify(token)).rejects.toThrow();
  });

  it('an access token is NOT accepted as an email-verification token', async () => {
    const token = await svc.sign({ sub: 'user-1' });
    await expect(svc.verifyEmailToken(token)).rejects.toThrow();
  });
});

describe('AuthService.verifyEmail con un enlace vencido o inválido (QA-H-05)', () => {
  it('401 EMAIL_VERIFICATION_EXPIRED en español, sin tocar la base', async () => {
    const { AuthService } = await import('./auth.service.js');
    const { EmailVerificationExpiredError } = await import('./auth-errors.js');
    const jwt = { verifyEmailToken: () => Promise.reject(new Error('exp')) };
    const self = { jwt, db: { db: {} }, audit: {} } as unknown as InstanceType<typeof AuthService>;
    const err = await AuthService.prototype.verifyEmail
      .call(self, 'token-vencido')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailVerificationExpiredError);
    expect((err as Error).message).toMatch(/venció/);
    expect((err as { reason: string }).reason).toBe('EMAIL_VERIFICATION_EXPIRED');
  });
});
