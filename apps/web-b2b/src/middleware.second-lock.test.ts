import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

// Simula un `safeNextPath` que dejó pasar un `//host` (como pasaba con `/.//evil.example`): el
// middleware no redirige fuera del panel aunque la validación de la ruta falle.
vi.mock('./lib/safe-next', () => ({
  SAFE_NEXT_FALLBACK: '/',
  safeNextPath: () => '//evil.example',
}));

const { middleware } = await import('./middleware');

const ORIGIN = 'https://panel.planetour.cloud';

function liveToken(): string {
  const b64url = (value: string) =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ sub: 'u', exp }))}.firma`;
}

describe('middleware: segunda llave del next', () => {
  it('un destino que resuelve a otro origen cae al inicio del panel', () => {
    const req = new NextRequest(new URL('/login?next=x', ORIGIN), {
      headers: { cookie: `st_session=${liveToken()}` },
    });
    const to = new URL(middleware(req).headers.get('location') ?? '');
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe('/');
  });
});
