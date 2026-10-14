import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('../../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import { GET, PATCH } from './route';

/*
 * `GET` y `PATCH /api/orders/:id/travelers` (SAB-25) hablan de personas: ni la lectura enmascarada
 * ni el desenlace se guardan en un caché, salga bien o mal.
 */

const ORDER = '33333333-3333-4333-8333-333333333333';
const params = Promise.resolve({ id: ORDER });

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
});

describe('route /api/orders/:id/travelers', () => {
  it('la lectura no se guarda en ningún caché, ni la que salió bien ni la que no', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 200,
      body: { kind: 'travelers' },
    });
    const ok = await GET(new Request(`https://app.test/api/orders/${ORDER}/travelers`), {
      params,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');

    mocks.apiWithStatus.mockResolvedValueOnce({ kind: 'unreachable', status: 503, message: 'x' });
    const caida = await GET(new Request(`https://app.test/api/orders/${ORDER}/travelers`), {
      params,
    });
    expect(caida.status).toBe(503);
    expect(caida.headers.get('cache-control')).toBe('no-store');
  });

  it('el desenlace del cambio tampoco', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 200,
      body: { outcome: 'MODIFIED' },
    });
    const res = await PATCH(
      new Request(`https://app.test/api/orders/${ORDER}/travelers`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ travelers: [{ index: 0, specialServices: ['WCHR'] }] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
