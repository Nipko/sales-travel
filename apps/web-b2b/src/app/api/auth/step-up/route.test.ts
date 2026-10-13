import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * POST /api/auth/step-up (USR-13): sólo desde el propio panel, con el cuerpo reconstruido (`{ code }`
 * de 6 dígitos) y el estado y el motivo del API en el error.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import { POST } from './route';

function post(
  body: unknown,
  headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
) {
  return new Request('https://app.test/api/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({
    kind: 'json',
    status: 200,
    body: { ok: true, verifiedAt: '2026-10-13T15:00:00.000Z' },
  });
});

describe('POST /api/auth/step-up', () => {
  it('reenvía sólo el código al API', async () => {
    const res = await POST(post({ code: '123 456', sessionId: 'de-otro' }));
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/auth/step-up', {
      method: 'POST',
      body: JSON.stringify({ code: '123456' }),
    });
  });

  it('un código que no son 6 dígitos, o un cuerpo roto, no llega al API', async () => {
    for (const body of [{ code: '12' }, 'no-es-json', {}]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('desde otro sitio se rechaza sin llegar al API', async () => {
    const res = await POST(post({ code: '123456' }, { 'sec-fetch-site': 'same-site' }));
    expect(res.status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('el rechazo del API vuelve con su estado y su motivo', async () => {
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 429,
      body: { message: 'Demasiados intentos fallidos.', reason: 'MFA_ACCOUNT_LOCKED' },
    });
    const res = await POST(post({ code: '123456' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'Demasiados intentos fallidos.',
      reason: 'MFA_ACCOUNT_LOCKED',
    });
  });
});
