import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from './jwt.service.js';

/**
 * Los tokens intermedios del login (desafío MFA, liberar un puesto) tienen audiencia propia: ninguno
 * sirve como bearer de API ni como el otro.
 */
describe('JwtService: desafío MFA y liberación de puesto', () => {
  const svc = new JwtService();

  beforeAll(() => {
    process.env['JWT_SECRET'] = 'x'.repeat(32);
    svc.onModuleInit();
  });

  it('el desafío MFA lleva el id de su fila como jti', async () => {
    const challengeId = randomUUID();
    const token = await svc.signMfaChallenge('user-1', challengeId, new Date(Date.now() + 60_000));
    expect(await svc.verifyMfaChallenge(token)).toEqual({ userId: 'user-1', challengeId });
    await expect(svc.verify(token)).rejects.toThrow();
  });

  it('un desafío vencido no se acepta', async () => {
    const token = await svc.signMfaChallenge('user-1', randomUUID(), new Date(Date.now() - 1000));
    await expect(svc.verifyMfaChallenge(token)).rejects.toThrow();
  });

  it('el permiso de liberar un puesto conserva cómo completar el login', async () => {
    const jti = randomUUID();
    const { token, expiresAt } = await svc.signSeatRelease({
      userId: 'user-1',
      poolTenantId: 'pool-1',
      tenantId: 'tenant-1',
      mfa: true,
      remember: true,
      jti,
    });
    const claims = await svc.verifySeatRelease(token);
    expect(claims).toMatchObject({
      userId: 'user-1',
      poolTenantId: 'pool-1',
      tenantId: 'tenant-1',
      mfa: true,
      remember: true,
      jti,
    });
    // Vence a los 5 minutos (el claim `exp` tiene resolución de segundos).
    expect(Math.abs(claims.expiresAt.getTime() - expiresAt.getTime())).toBeLessThan(1000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('sin tenant, sin MFA ni "recordar"', async () => {
    const { token } = await svc.signSeatRelease({
      userId: 'user-1',
      poolTenantId: 'pool-1',
      tenantId: null,
      mfa: false,
      remember: false,
      jti: randomUUID(),
    });
    expect(await svc.verifySeatRelease(token)).toMatchObject({
      tenantId: null,
      mfa: false,
      remember: false,
    });
  });

  it('ni el permiso sirve de bearer ni el bearer de permiso', async () => {
    const { token } = await svc.signSeatRelease({
      userId: 'user-1',
      poolTenantId: 'pool-1',
      tenantId: null,
      mfa: false,
      remember: false,
      jti: randomUUID(),
    });
    await expect(svc.verify(token)).rejects.toThrow();
    await expect(svc.verifyMfaChallenge(token)).rejects.toThrow();
    await expect(svc.verifySeatRelease(await svc.sign({ sub: 'user-1' }))).rejects.toThrow();
  });

  it('el access token vence en el instante de su sesión', async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const token = await svc.sign({ sub: 'user-1', jti: randomUUID() }, expiresAt);
    const [, body = ''] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp: number };
    expect(payload.exp).toBe(Math.floor(expiresAt.getTime() / 1000));
  });
});
