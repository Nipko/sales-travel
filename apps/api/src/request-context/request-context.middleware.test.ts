import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JwtService } from '../auth/jwt.service.js';
import type { SessionService, SessionValidation } from '../auth/session.service.js';
import type { NetworkService } from '../network/network.service.js';
import { currentContext, type RequestContext } from './request-context.js';
import { RequestContextMiddleware } from './request-context.middleware.js';

const SECRET = 's'.repeat(40);

const LAST_SEEN = new Date('2026-09-29T12:00:00Z');
const EXPIRES = new Date('2026-09-29T23:00:00Z');

function valid(extra: Partial<Extract<SessionValidation, { ok: true }>> = {}): SessionValidation {
  return {
    ok: true,
    mfaRequired: false,
    mfaEnabled: false,
    mfaVerified: false,
    idleTimeoutSeconds: 1800,
    lastSeenAt: LAST_SEEN,
    expiresAt: EXPIRES,
    ...extra,
  };
}

/**
 * Lo que la sesión resuelve contra la base llega al contexto del request, que es lo que leen
 * AuthGuard, MfaEnforcementGuard y RolesGuard. En particular `platformUser`: sin él, el superadmin
 * con una membership de vendedor en una sucursal volvería a vender.
 */
async function contextFor(
  validated: SessionValidation,
  opts: {
    headers?: Record<string, string>;
    verify?: () => Promise<unknown>;
    /** canAccessTenant del header x-tenant-id. */
    canAccess?: boolean;
    /** Reemplaza la validación de la sesión (p. ej. una base que no responde). */
    validate?: () => Promise<SessionValidation>;
  } = {},
): Promise<{ context: RequestContext | undefined; validate: ReturnType<typeof vi.fn> }> {
  const jwt = {
    verify: vi.fn(opts.verify ?? (() => Promise.resolve({ sub: 'u-1', tid: 't-1', jti: 's-1' }))),
  } as unknown as JwtService;
  const network = {
    canAccessTenant: vi.fn(() => Promise.resolve(opts.canAccess === true)),
  } as unknown as NetworkService;
  const validate = vi.fn(opts.validate ?? (() => Promise.resolve(validated)));
  const sessions = { validate } as unknown as SessionService;
  const middleware = new RequestContextMiddleware(jwt, network, sessions);

  let seen: RequestContext | undefined;
  const req = {
    headers: { authorization: 'Bearer token', ...opts.headers },
    ip: '172.18.0.5',
  } as unknown as Request;
  await middleware.use(req, {} as Response, () => {
    seen = currentContext();
  });
  return { context: seen, validate };
}

describe('RequestContextMiddleware', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pasa el rol y la marca de usuario de plataforma que resolvió la sesión', async () => {
    const { context } = await contextFor(valid({ role: 'vendedor', platformUser: true }));
    expect(context).toMatchObject({
      userId: 'u-1',
      tenantId: 't-1',
      role: 'vendedor',
      platformUser: true,
    });
  });

  it('sin la marca, el usuario no es de plataforma', async () => {
    const { context } = await contextFor(valid({ role: 'vendedor' }));
    expect(context).toMatchObject({ userId: 'u-1', role: 'vendedor', platformUser: false });
  });

  it('pasa el estado del MFA y los tiempos de la sesión', async () => {
    const { context } = await contextFor(
      valid({ mfaRequired: true, mfaEnabled: true, mfaVerified: false }),
    );
    expect(context).toMatchObject({
      mfaRequired: true,
      mfaEnabled: true,
      mfaVerified: false,
      session: { idleTimeoutSeconds: 1800, lastSeenAt: LAST_SEEN, expiresAt: EXPIRES },
    });
    expect(context?.authFailure).toBeUndefined();
  });

  it('una sesión inválida no deja usuario, rol ni marca, y guarda el motivo', async () => {
    const { context } = await contextFor({ ok: false, reason: 'SESSION_REPLACED' });
    expect(context?.userId).toBeUndefined();
    expect(context?.sessionId).toBeUndefined();
    expect(context?.role).toBeUndefined();
    expect(context?.platformUser).toBe(false);
    expect(context?.mfaRequired).toBeUndefined();
    expect(context?.authFailure).toBe('SESSION_REPLACED');
    expect(context?.sessionCheckUnavailable).toBeUndefined();
  });

  it('si la base no responde al validar: sin usuario (fail-closed), pero marcado para el 503', async () => {
    const { context } = await contextFor(valid(), {
      validate: () => Promise.reject(new Error('Connection terminated unexpectedly')),
    });
    expect(context?.userId).toBeUndefined();
    expect(context?.sessionId).toBeUndefined();
    expect(context?.role).toBeUndefined();
    expect(context?.authFailure).toBeUndefined();
    expect(context?.sessionCheckUnavailable).toBe(true);
  });

  it('un token vencido da SESSION_EXPIRED sin tocar la base', async () => {
    const expired = Object.assign(new Error('"exp" claim timestamp check failed'), {
      code: 'ERR_JWT_EXPIRED',
    });
    const { context, validate } = await contextFor(valid(), {
      verify: () => Promise.reject(expired),
    });
    expect(context?.userId).toBeUndefined();
    expect(context?.authFailure).toBe('SESSION_EXPIRED');
    expect(validate).not.toHaveBeenCalled();
  });

  it('una firma inválida no da motivo: es un 401 genérico', async () => {
    const { context } = await contextFor(valid(), {
      verify: () => Promise.reject(new Error('signature verification failed')),
    });
    expect(context?.userId).toBeUndefined();
    expect(context?.authFailure).toBeUndefined();
  });

  it.each([
    ['passive', 'passive'],
    ['active', 'active'],
    [undefined, 'default'],
    ['cualquier-cosa', 'default'],
  ])('x-session-ping %s → actividad %s', async (header, mode) => {
    const { validate } = await contextFor(valid(), {
      headers: header === undefined ? {} : { 'x-session-ping': header },
    });
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ activity: mode }));
  });

  it('el header de otro nodo va aparte del tid firmado y se adopta si la sesión lo acepta', async () => {
    const { context, validate } = await contextFor(valid({ role: 'agency_admin' }), {
      headers: { 'x-tenant-id': 't-2' },
      canAccess: true,
    });
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't-1', requestedTenantId: 't-2' }),
    );
    expect(context).toMatchObject({ tenantId: 't-2', role: 'agency_admin' });
  });

  it('un nodo de otro cupo de puestos no se adopta: vuelve al tid firmado', async () => {
    const { context } = await contextFor(
      valid({ role: 'vendedor', requestedTenantRejected: true }),
      { headers: { 'x-tenant-id': 't-cupo-lleno' }, canAccess: true },
    );
    expect(context).toMatchObject({ userId: 'u-1', tenantId: 't-1', role: 'vendedor' });
  });

  it('el header igual al tid, o uno no autorizado, no pide nada aparte', async () => {
    for (const [header, canAccess] of [
      ['t-1', true],
      ['t-ajeno', false],
    ] as const) {
      const { context, validate } = await contextFor(valid(), {
        headers: { 'x-tenant-id': header },
        canAccess,
      });
      const params = (validate.mock.calls[0] as unknown[] | undefined)?.[0];
      expect(params).toMatchObject({ tenantId: 't-1' });
      expect(params).not.toHaveProperty('requestedTenantId');
      expect(context?.tenantId).toBe('t-1');
    }
  });

  it('con el secreto del panel, la IP y el navegador son los del usuario', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const { context } = await contextFor(valid(), {
      headers: {
        'x-internal-proxy': SECRET,
        'x-client-ip': '190.24.8.9',
        'x-client-user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
        'user-agent': 'undici',
      },
    });
    expect(context).toMatchObject({
      ip: '190.24.8.9',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
    });
  });

  it('directo al api, la IP es la que resolvió Caddy y no CF-Connecting-IP', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const { context } = await contextFor(valid(), {
      headers: {
        'x-edge-peer-ip': '190.24.8.9',
        'cf-connecting-ip': '203.0.113.66',
        'user-agent': 'curl/8',
      },
    });
    expect(context).toMatchObject({ ip: '190.24.8.9', userAgent: 'curl/8' });
  });

  it('sin el secreto, los x-client-* se ignoran', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const { context } = await contextFor(valid(), {
      headers: {
        'x-internal-proxy': 'otro-secreto-que-no-es-el-del-panel-0000',
        'x-client-ip': '190.24.8.9',
        'x-client-user-agent': 'Falso/1.0',
        'user-agent': 'curl/8',
      },
    });
    expect(context).toMatchObject({ ip: '172.18.0.5', userAgent: 'curl/8' });
  });
});
