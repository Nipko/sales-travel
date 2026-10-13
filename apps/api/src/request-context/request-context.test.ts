import { describe, expect, it } from 'vitest';
import {
  currentContext,
  currentTenantId,
  currentUserId,
  requestContextStorage,
  runWithTenantContext,
} from './request-context.js';

const PLATAFORMA = '00000000-0000-4000-8000-000000000001';
const AGENCIA = '11111111-1111-4111-8111-111111111111';
const SUPERADMIN = '99999999-9999-4999-8999-999999999999';

describe('runWithTenantContext', () => {
  it('cambia sólo el tenant: el usuario, la sesión y la IP siguen siendo los de quien actúa', async () => {
    await requestContextStorage.run(
      {
        userId: SUPERADMIN,
        tenantId: PLATAFORMA,
        role: 'superadmin',
        sessionId: 's-1',
        requestId: 'r-1',
        ip: '203.0.113.7',
      },
      async () => {
        const inside = await runWithTenantContext(AGENCIA, async () => {
          await Promise.resolve();
          return { tenant: currentTenantId(), user: currentUserId(), ctx: currentContext() };
        });

        expect(inside.tenant).toBe(AGENCIA);
        expect(inside.user).toBe(SUPERADMIN);
        expect(inside.ctx).toMatchObject({
          role: 'superadmin',
          sessionId: 's-1',
          requestId: 'r-1',
          ip: '203.0.113.7',
        });
        // Afuera, nada cambió.
        expect(currentTenantId()).toBe(PLATAFORMA);
      },
    );
  });

  it('sin request (un job) arma un contexto con sólo el tenant', () => {
    expect(currentContext()).toBeUndefined();
    expect(runWithTenantContext(AGENCIA, () => currentContext())).toEqual({ tenantId: AGENCIA });
    expect(currentContext()).toBeUndefined();
  });

  it('devuelve lo que devuelve la función, y sus errores salen igual', () => {
    expect(runWithTenantContext(AGENCIA, () => 42)).toBe(42);
    expect(() =>
      runWithTenantContext(AGENCIA, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });
});
