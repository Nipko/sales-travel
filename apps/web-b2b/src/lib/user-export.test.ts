import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStepUpCancelled, registerStepUpPrompt } from './step-up';
import {
  exportPlatformUsers,
  exportTeam,
  PLATFORM_EXPORT_NOTE,
  TEAM_EXPORT_HINT,
  usersExportDoneMessage,
  usersExportErrorMessage,
  usersExportFilename,
} from './user-export';
import { voseoIn } from './voseo';

/*
 * Exportar la lista de usuarios (USR-16) desde el navegador: qué se pide (los filtros de la pantalla,
 * sin paginar), la reconfirmación del 2FA en el medio (USR-13), qué se lee de la respuesta y cómo se
 * dice cada resultado.
 */

const NODO = '11111111-1111-4111-8111-111111111111';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function csv(headers: Record<string, string> = {}): Response {
  return new Response('﻿Correo\r\n', {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="usuarios-2026-10-13.csv"',
      'x-export-users': '12',
      'x-export-rows': '15',
      'x-export-truncated': 'false',
      ...headers,
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

describe('exportPlatformUsers: el directorio con los filtros de la pantalla', () => {
  it('pide la exportación con la misma consulta que la lista, sin cursor', async () => {
    fetchMock.mockResolvedValue(csv());
    const res = await exportPlatformUsers({
      q: '  ana ',
      status: 'suspended',
      role: 'vendedor',
      tenantId: NODO,
      withoutMfa: true,
      locked: true,
      neverLoggedIn: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/admin/exports/users?q=ana&status=suspended&role=vendedor&tenantId=${NODO}&mfa=off&locked=true&neverLoggedIn=true`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' });
    expect(res).toMatchObject({
      ok: true,
      data: { filename: 'usuarios-2026-10-13.csv', users: 12, truncated: false },
    });
  });

  it('sin filtros, la ruta sola', async () => {
    fetchMock.mockResolvedValue(csv());
    await exportPlatformUsers({ q: '   ' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/exports/users');
  });

  it('sin el 2FA reciente pide el código y repite la exportación una vez', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    unregister = registerStepUpPrompt(prompt);
    fetchMock.mockResolvedValueOnce(json(403, MFA_403)).mockResolvedValueOnce(csv());
    const res = await exportPlatformUsers({ q: '' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: true });
  });

  it('si se cierra el diálogo no se exporta nada', async () => {
    unregister = registerStepUpPrompt(() => Promise.resolve(false));
    fetchMock.mockResolvedValueOnce(json(403, MFA_403));
    const res = await exportPlatformUsers({ q: '' });
    expect(isStepUpCancelled(res)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un 403 de quien no es superadmin trae el mensaje del API; sin red, que no se pudo conectar', async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: 'Esta acción es sólo para el superadmin.',
        reason: 'SUPERADMIN_REQUIRED',
      }),
    );
    expect(await exportPlatformUsers({ q: '' })).toEqual({
      ok: false,
      message: 'Esta acción es sólo para el superadmin.',
      reason: 'SUPERADMIN_REQUIRED',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await exportPlatformUsers({ q: '' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/No pudimos conectar/),
    });
  });
});

describe('exportTeam: el equipo del nodo', () => {
  it('pide la ruta del nodo y lee si se cortó', async () => {
    fetchMock.mockResolvedValue(
      csv({
        'content-disposition': 'attachment; filename="equipo-norte-2026-10-13.csv"',
        'x-export-users': '10000',
        'x-export-truncated': 'true',
      }),
    );
    const res = await exportTeam(NODO);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/tenants/${NODO}/members-export`);
    expect(res).toMatchObject({
      ok: true,
      data: { filename: 'equipo-norte-2026-10-13.csv', users: 10_000, truncated: true },
    });
  });

  it('sin el 2FA reciente pide el código y repite; si se cierra el diálogo, nada', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    unregister = registerStepUpPrompt(prompt);
    fetchMock.mockResolvedValueOnce(json(403, MFA_403)).mockResolvedValueOnce(csv());
    expect(await exportTeam(NODO)).toMatchObject({ ok: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unregister();
    unregister = registerStepUpPrompt(() => Promise.resolve(false));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(403, MFA_403));
    expect(isStepUpCancelled(await exportTeam(NODO))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el 403 de un nodo ajeno, tal cual; el 429, en castellano', async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, { error: 'No administras este nodo.', reason: 'TENANT_NOT_MANAGED' }),
    );
    expect(await exportTeam(NODO)).toMatchObject({
      ok: false,
      message: 'No administras este nodo.',
    });
    fetchMock.mockResolvedValueOnce(json(429, { error: 'Too Many Requests' }));
    expect(await exportTeam(NODO)).toMatchObject({
      ok: false,
      message: 'Exportaste varias veces seguidas. Espera un minuto y vuelve a intentarlo.',
    });
  });

  it('cabeceras raras: el nombre propio y cero personas', async () => {
    fetchMock.mockResolvedValue(
      csv({ 'content-disposition': 'attachment; filename="../../x.sh"', 'x-export-users': '-1' }),
    );
    expect(await exportTeam(NODO)).toMatchObject({
      ok: true,
      data: { filename: 'equipo.csv', users: 0 },
    });
  });
});

describe('los textos', () => {
  it('lo que se exportó, y si se cortó en el tope', () => {
    expect(usersExportDoneMessage({ users: 1, truncated: false }, 'platform')).toBe(
      'Exportamos 1 persona.',
    );
    expect(usersExportDoneMessage({ users: 1234, truncated: false }, 'platform')).toBe(
      'Exportamos 1.234 personas.',
    );
    expect(usersExportDoneMessage({ users: 10_000, truncated: true }, 'platform')).toBe(
      'Exportamos 10.000 personas: las altas más recientes. Acota los filtros para ver el resto.',
    );
    expect(usersExportDoneMessage({ users: 0, truncated: false }, 'platform')).toBe(
      'Exportamos el archivo: no hay personas con estos filtros.',
    );
    expect(usersExportDoneMessage({ users: 3, truncated: false }, 'node')).toBe(
      'Exportamos el equipo: 3 personas.',
    );
    expect(usersExportDoneMessage({ users: 0, truncated: false }, 'node')).toBe(
      'Exportamos el archivo: este nodo no tiene miembros.',
    );
  });

  it('por qué no salió', () => {
    expect(usersExportErrorMessage(401, 'x', 'platform')).toBe(
      'Tu sesión venció. Vuelve a iniciar sesión.',
    );
    expect(usersExportErrorMessage(403, undefined, 'platform')).toBe(
      'Exportar el directorio es sólo para el superadmin.',
    );
    expect(usersExportErrorMessage(403, '  ', 'node')).toBe(
      'No tienes permiso para exportar el equipo de este nodo.',
    );
    expect(usersExportErrorMessage(400, undefined, 'platform')).toBe(
      'Los filtros no son válidos. Recarga la página.',
    );
    expect(usersExportErrorMessage(400, 'Nodo inválido.', 'node')).toBe('Nodo inválido.');
    expect(usersExportErrorMessage(502, 'detalle interno', 'node')).toBe(
      'No pudimos exportar la lista. Inténtalo de nuevo en unos segundos.',
    );
  });

  it('el nombre del archivo: el del API si es limpio, si no uno propio', () => {
    expect(usersExportFilename('attachment; filename="usuarios-2026-10-13.csv"', 'platform')).toBe(
      'usuarios-2026-10-13.csv',
    );
    expect(usersExportFilename('attachment; filename="a b.csv"', 'platform')).toBe('usuarios.csv');
    expect(usersExportFilename(null, 'node')).toBe('equipo.csv');
  });

  it('todo en tú', () => {
    const all = [
      PLATFORM_EXPORT_NOTE,
      TEAM_EXPORT_HINT,
      usersExportDoneMessage({ users: 10_000, truncated: true }, 'platform'),
      usersExportDoneMessage({ users: 10_000, truncated: true }, 'node'),
      ...[401, 403, 400, 429, 500].flatMap((s) => [
        usersExportErrorMessage(s, undefined, 'platform'),
        usersExportErrorMessage(s, undefined, 'node'),
      ]),
    ].join(' ');
    expect(voseoIn(all)).toEqual([]);
  });
});
