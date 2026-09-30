import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * El layout, cuando el API dice que la sesión terminó: tiene que mandar a cerrarla conservando la
 * pantalla que se pidió, para volver a ella después de entrar. Es el caso de un link profundo
 * (WhatsApp, un correo) abierto con la cookie vigente pero la sesión ya cerrada en el API: el
 * middleware no redirige (la cookie no venció) y sólo el layout se entera.
 */

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  getRequestedPath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../lib/api', () => ({ api: mocks.api }));
vi.mock('../../lib/session', () => ({
  getActiveTenant: vi.fn(() => Promise.resolve(null)),
  getRequestedPath: mocks.getRequestedPath,
  setActiveTenant: vi.fn(() => Promise.resolve()),
}));
vi.mock('sonner', () => ({ Toaster: () => null }));
vi.mock('../../components/layout/app-shell', () => ({
  AppShell: () => null,
  BrandStyle: () => null,
}));
vi.mock('../../components/layout/sales-gate', () => ({ SalesGate: () => null }));
vi.mock('../../components/layout/session-guard', () => ({ SessionGuard: () => null }));
vi.mock('../../components/layout/verify-banner', () => ({ VerifyBanner: () => null }));
vi.mock('./configuracion/seguridad/_components/mfa-enrollment-gate', () => ({
  MfaEnrollmentGate: () => null,
}));

import AppLayout from './layout';

type Reply = { ok: true; data: unknown } | { ok: false; error: Record<string, unknown> };

const OK: Record<string, Reply> = {
  '/me': { ok: true, data: { email: 'ana@agencia.co', emailVerified: true } },
  '/me/memberships': { ok: true, data: [] },
  '/auth/session': { ok: true, data: { sessionId: 's1', idleTimeoutSeconds: 1800 } },
  '/auth/mfa': { ok: true, data: { enabled: false, required: false } },
};

const IDLE: Reply = {
  ok: false,
  error: { status: 401, message: 'Session idle', reason: 'SESSION_IDLE' },
};

/** La URL a la que redirige el layout con estas respuestas del API. */
async function redirectWith(replies: Partial<Record<string, Reply>>): Promise<URL> {
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(path in replies ? replies[path] : OK[path]),
  );
  try {
    await AppLayout({ children: null });
  } catch (err) {
    if (err instanceof RedirectSignal) return new URL(err.url, 'https://panel.test');
    throw err;
  }
  throw new Error('esperaba un redirect');
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.getRequestedPath.mockReset();
  mocks.redirect.mockReset();
  mocks.redirect.mockImplementation((url: string) => {
    throw new RedirectSignal(url);
  });
});

describe('AppLayout: sesión terminada en el API', () => {
  it('manda a cerrarla con el motivo y la pantalla pedida como `next`', async () => {
    mocks.getRequestedPath.mockResolvedValue('/reservas/123?tab=pagos');

    const url = await redirectWith({ '/auth/session': IDLE, '/me': IDLE });

    expect(url.pathname).toBe('/api/session/end');
    expect(url.searchParams.get('motivo')).toBe('inactividad');
    expect(url.searchParams.get('next')).toBe('/reservas/123?tab=pagos');
  });

  it('sin pantalla pedida (o no del panel), sin `next`', async () => {
    mocks.getRequestedPath.mockResolvedValue(null);

    const url = await redirectWith({ '/auth/session': IDLE });

    expect(url.pathname).toBe('/api/session/end');
    expect(url.searchParams.get('motivo')).toBe('inactividad');
    expect(url.searchParams.has('next')).toBe(false);
  });
});
