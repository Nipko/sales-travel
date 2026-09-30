import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: () => Promise.reject(new Error('fuera de un request')),
}));
vi.mock('../../../lib/session', () => ({
  getSession: () => Promise.resolve(null),
  getActiveTenant: () => Promise.resolve(null),
  getTrustedDevice: () => Promise.resolve(null),
}));

import { GET } from './route';

const SECRET = 'x'.repeat(40);
const SRC = join(__dirname, '..', '..', '..');

describe('GET /api/airports: el api ve al usuario, no al contenedor del panel', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"items":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reenvía la IP que resolvió Caddy, el navegador y el secreto', async () => {
    await GET(
      new Request('https://app.test/api/airports?q=bog', {
        headers: {
          'x-edge-peer-ip': '190.24.8.9',
          'cf-connecting-ip': '1.2.3.4',
          'user-agent': 'Mozilla/5.0 Firefox/130',
        },
      }),
    );
    const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(sent.get('x-internal-proxy')).toBe(SECRET);
    expect(sent.get('x-client-ip')).toBe('190.24.8.9');
    expect(sent.get('x-client-user-agent')).toBe('Mozilla/5.0 Firefox/130');
  });
});

/** Los .ts/.tsx de `src`, sin tests. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('todo llamado del panel al api manda el origen del usuario', () => {
  it('quien lee INTERNAL_API_URL fuera de lib/api.ts arma las cabeceras con clientOriginHeaders', () => {
    const offenders = sources(SRC)
      .filter((file) => relative(SRC, file).replace(/\\/g, '/') !== 'lib/api.ts')
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('INTERNAL_API_URL') && !text.includes('clientOriginHeaders(');
      })
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
