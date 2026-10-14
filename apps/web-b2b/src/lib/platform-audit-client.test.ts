import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACTIVITY_FILTERS } from './platform-audit';
import { exportPlatformActivity, loadPlatformActivity } from './platform-audit-client';
import { isStepUpCancelled, registerStepUpPrompt } from './step-up';

/*
 * Las llamadas del navegador a Plataforma → Actividad: la lista, y la exportación con la
 * reconfirmación del 2FA en el medio (USR-13).
 */

const NOW = new Date('2026-10-13T15:00:00.000Z');

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function csv(): Response {
  return new Response('\uFEFFfecha\r\n', {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="actividad-2026-10-07-a-2026-10-13.csv"',
      'x-export-rows': '12',
      'x-export-truncated': 'false',
    },
  });
}

const MFA_403 = {
  error: 'Confirma con tu código de verificación en dos pasos para seguir.',
  reason: 'MFA_RECENT_REQUIRED',
};

let unregister: (() => void) | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

describe('loadPlatformActivity', () => {
  it('pide la página con las fechas resueltas y la lee', async () => {
    fetchMock.mockResolvedValue(json(200, { events: [], nextCursor: null }));
    const res = await loadPlatformActivity(DEFAULT_ACTIVITY_FILTERS, NOW, 'abc');
    expect(res).toEqual({ ok: true, data: { events: [], nextCursor: null } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/admin/audit?from=2026-10-07&to=2026-10-13&cursor=abc',
    );
  });

  it('un 403 dice que es sólo del superadmin; sin red, que no se pudo conectar', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'x' }));
    expect(await loadPlatformActivity(DEFAULT_ACTIVITY_FILTERS, NOW)).toEqual({
      ok: false,
      message: 'Sólo el superadmin de la plataforma ve la actividad de toda la red.',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await loadPlatformActivity(DEFAULT_ACTIVITY_FILTERS, NOW)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/No pudimos conectar/),
    });
  });
});

describe('exportPlatformActivity', () => {
  it('sin el 2FA reciente pide el código y repite la exportación una vez', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    unregister = registerStepUpPrompt(prompt);
    fetchMock.mockResolvedValueOnce(json(403, MFA_403)).mockResolvedValueOnce(csv());

    const res = await exportPlatformActivity(DEFAULT_ACTIVITY_FILTERS, NOW);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/admin/audit/export?from=2026-10-07&to=2026-10-13',
    );
    expect(res).toMatchObject({
      ok: true,
      data: { filename: 'actividad-2026-10-07-a-2026-10-13.csv', rows: 12, truncated: false },
    });
  });

  it('si se cierra el diálogo no se exporta nada', async () => {
    unregister = registerStepUpPrompt(() => Promise.resolve(false));
    fetchMock.mockResolvedValueOnce(json(403, MFA_403));
    const res = await exportPlatformActivity(DEFAULT_ACTIVITY_FILTERS, NOW);
    expect(isStepUpCancelled(res)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sin el 2FA activo, el mensaje del API dice qué hacer', async () => {
    unregister = registerStepUpPrompt(() => Promise.resolve(true));
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: 'Para hacer esto necesitas la verificación en dos pasos.',
        reason: 'MFA_REQUIRED_FOR_ACTION',
      }),
    );
    expect(await exportPlatformActivity(DEFAULT_ACTIVITY_FILTERS, NOW)).toEqual({
      ok: false,
      message: 'Para hacer esto necesitas la verificación en dos pasos.',
      reason: 'MFA_REQUIRED_FOR_ACTION',
    });
  });
});
