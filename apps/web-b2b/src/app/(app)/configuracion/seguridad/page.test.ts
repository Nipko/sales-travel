import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityClientProps } from './SecurityClient';

/*
 * Qué le pasa la página a la pantalla cuando alguna lectura falla: un error no puede pintarse como
 * un dato ("Desactivada", "0 sesiones activas").
 */

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ api: mocks.api }));
vi.mock('./SecurityClient', () => ({ SecurityClient: () => null }));

import SeguridadPage from './page';

type Reply =
  | { ok: true; data: unknown }
  | { ok: false; error: { status: number; message: string } };

const SERVER_ERROR: Reply = { ok: false, error: { status: 500, message: 'Internal server error' } };

const OK: Record<string, Reply> = {
  '/auth/mfa': {
    ok: true,
    data: { enabled: true, recoveryCodesRemaining: 8, required: false, pendingEnrollment: false },
  },
  '/auth/sessions': {
    ok: true,
    data: [{ id: 's1', lastSeenAt: '2026-09-29T11:00:00Z', current: true }],
  },
  '/auth/trusted-devices': { ok: true, data: [] },
  '/me': { ok: true, data: { email: 'ana@agencia.co' } },
};

async function propsWith(
  replies: Partial<Record<string, Reply>>,
  params: { enrolar?: string } = {},
): Promise<SecurityClientProps> {
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(path in replies ? replies[path] : OK[path]),
  );
  const element = (await SeguridadPage({
    searchParams: Promise.resolve(params),
  })) as ReactElement<SecurityClientProps>;
  return element.props;
}

beforeEach(() => {
  mocks.api.mockReset();
});

describe('SeguridadPage', () => {
  it('con todo en orden, el estado real y sin errores', async () => {
    const props = await propsWith({});
    expect(props.mfa).toEqual({
      enabled: true,
      recoveryCodesRemaining: 8,
      required: false,
      pendingEnrollment: false,
    });
    expect(props.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(props.sessionsError).toBeUndefined();
    expect(props.trustedDevicesError).toBeUndefined();
    expect(props.email).toBe('ana@agencia.co');
  });

  it('si /auth/mfa falla, el 2FA queda "desconocido", no "desactivado"', async () => {
    const props = await propsWith({ '/auth/mfa': SERVER_ERROR }, { enrolar: '1' });
    expect(props.mfa).toBeNull();
    // Sin estado no se puede decir que falte enrolar: sería ofrecer "Activar" a quien ya la tiene.
    expect(props.enrollmentRequired).toBe(false);
    // El mensaje crudo del API (en inglés) no llega a la pantalla.
    expect(JSON.stringify(props)).not.toContain('Internal server error');
  });

  it('si /auth/sessions falla, se avisa en vez de una lista vacía', async () => {
    const props = await propsWith({ '/auth/sessions': SERVER_ERROR });
    expect(props.sessions).toEqual([]);
    expect(props.sessionsError).toMatch(/No pudimos cargar tus sesiones/);
  });

  it('?enrolar=1 con el 2FA apagado pide enrolar; el rol que lo exige, también', async () => {
    const off = { enabled: false, recoveryCodesRemaining: 0, required: false };
    expect(
      (await propsWith({ '/auth/mfa': { ok: true, data: off } }, { enrolar: '1' }))
        .enrollmentRequired,
    ).toBe(true);
    expect(
      (await propsWith({ '/auth/mfa': { ok: true, data: { ...off, required: true } } }))
        .enrollmentRequired,
    ).toBe(true);
    expect((await propsWith({ '/auth/mfa': { ok: true, data: off } })).enrollmentRequired).toBe(
      false,
    );
  });
});
