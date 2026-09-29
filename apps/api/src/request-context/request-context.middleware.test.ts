import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { JwtService } from '../auth/jwt.service.js';
import type { SessionService, ValidatedSession } from '../auth/session.service.js';
import type { NetworkService } from '../network/network.service.js';
import { currentContext, type RequestContext } from './request-context.js';
import { RequestContextMiddleware } from './request-context.middleware.js';

/**
 * Lo que la sesión resuelve contra la base llega al contexto del request, que es lo que lee
 * RolesGuard. En particular `platformUser`: sin él, el superadmin con una membership de vendedor en
 * una sucursal volvería a vender.
 */
async function contextFor(validated: ValidatedSession | null): Promise<RequestContext | undefined> {
  const jwt = {
    verify: vi.fn(() => Promise.resolve({ sub: 'u-1', tid: 't-1', jti: 's-1' })),
  } as unknown as JwtService;
  const network = {} as NetworkService;
  const sessions = {
    validate: vi.fn(() => Promise.resolve(validated)),
  } as unknown as SessionService;
  const middleware = new RequestContextMiddleware(jwt, network, sessions);

  let seen: RequestContext | undefined;
  const req = { headers: { authorization: 'Bearer token' }, ip: '127.0.0.1' } as Request;
  await middleware.use(req, {} as Response, () => {
    seen = currentContext();
  });
  return seen;
}

describe('RequestContextMiddleware', () => {
  it('pasa el rol y la marca de usuario de plataforma que resolvió la sesión', async () => {
    const context = await contextFor({ role: 'vendedor', platformUser: true });
    expect(context).toMatchObject({
      userId: 'u-1',
      tenantId: 't-1',
      role: 'vendedor',
      platformUser: true,
    });
  });

  it('sin la marca, el usuario no es de plataforma', async () => {
    const context = await contextFor({ role: 'vendedor' });
    expect(context).toMatchObject({ userId: 'u-1', role: 'vendedor', platformUser: false });
  });

  it('una sesión inválida no deja usuario, rol ni marca', async () => {
    const context = await contextFor(null);
    expect(context?.userId).toBeUndefined();
    expect(context?.role).toBeUndefined();
    expect(context?.platformUser).toBe(false);
  });
});
