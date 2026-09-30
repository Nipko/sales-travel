import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
  headers: vi.fn(() => Promise.resolve(requestHeaders)),
}));

const { getRequestedPath } = await import('./session');

describe('getRequestedPath', () => {
  beforeEach(() => {
    requestHeaders.delete('x-st-path');
  });

  it('la pantalla que puso el middleware', async () => {
    requestHeaders.set('x-st-path', '/reservas/123?tab=pagos');
    expect(await getRequestedPath()).toBe('/reservas/123?tab=pagos');
  });

  it('sin header, el inicio o algo que no es del panel: null', async () => {
    expect(await getRequestedPath()).toBeNull();
    requestHeaders.set('x-st-path', '/');
    expect(await getRequestedPath()).toBeNull();
    requestHeaders.set('x-st-path', '/.//evil.example');
    expect(await getRequestedPath()).toBeNull();
    requestHeaders.set('x-st-path', '/login?next=/hoteles');
    expect(await getRequestedPath()).toBeNull();
  });
});
