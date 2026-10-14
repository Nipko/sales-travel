import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel que exportan la lista de usuarios a CSV (USR-16): sólo desde el panel, con la
 * consulta del directorio rearmada parámetro por parámetro (sin paginar) o el id del nodo validado;
 * pasan el CSV en bytes (con su BOM y sin caché) y devuelven el motivo del 403 del 2FA para que el
 * panel pida el código.
 */

const mocks = vi.hoisted(() => ({ apiDownload: vi.fn() }));

vi.mock('../../../../../lib/api', () => ({ apiDownload: mocks.apiDownload }));

import { platformUsersExportTarget } from '../../../../../lib/platform-users-proxy';
import { teamExportTarget } from '../../../../../lib/tenant-admin-proxy';
import { GET as exportTeam } from '../../../tenants/[tenantId]/members-export/route';
import { GET as exportDirectory } from './route';

const NODE = '0B6F6A52-7A47-4C8E-9A3B-1A2B3C4D5E6F';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const EXPOSED = ['x-export-users', 'x-export-rows', 'x-export-truncated'];

function directory(query: string, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`https://app.test/api/admin/exports/users?${query}`, { headers });
}

function team(tenantId: string, headers: Record<string, string> = SAME_ORIGIN) {
  return exportTeam(
    new Request(`https://app.test/api/tenants/${tenantId}/members-export`, { headers }),
    { params: Promise.resolve({ tenantId }) },
  );
}

function file(filename: string) {
  return {
    kind: 'file',
    status: 200,
    body: new TextEncoder().encode('﻿Correo,Nombre\r\n').buffer,
    contentType: 'text/csv; charset=utf-8',
    headers: {
      'content-disposition': `attachment; filename="${filename}"`,
      'x-export-users': '2',
      'x-export-rows': '3',
      'x-export-truncated': 'false',
    },
  };
}

beforeEach(() => {
  mocks.apiDownload.mockReset();
});

describe('platformUsersExportTarget: la consulta del directorio, sin paginar', () => {
  const target = (search: string) => platformUsersExportTarget(new URLSearchParams(search));

  it('los filtros de la lista, rearmados, hacia la ruta de la exportación', () => {
    expect(target('')).toEqual({ ok: true, path: '/admin/exports/users' });
    expect(
      target(`q=%20ana%20&role=vendedor&tenantId=${NODE}&mfa=off&locked=true&status=active`),
    ).toEqual({
      ok: true,
      path: `/admin/exports/users?q=ana&status=active&role=vendedor&tenantId=${NODE.toLowerCase()}&mfa=off&locked=true`,
    });
  });

  it('un cursor, un límite, un parámetro de más o uno repetido no pasan', () => {
    expect(target('cursor=abc').ok).toBe(false);
    expect(target('limit=10').ok).toBe(false);
    expect(target('format=xlsx').ok).toBe(false);
    expect(target('role=vendedor&role=admin').ok).toBe(false);
    expect(target('role=platform_admin').ok).toBe(false);
    expect(target('tenantId=../../admin').ok).toBe(false);
  });
});

describe('teamExportTarget: el id del nodo', () => {
  it('sólo un UUID, en minúsculas', () => {
    expect(teamExportTarget(NODE)).toEqual({
      ok: true,
      path: `/tenants/${NODE.toLowerCase()}/members-export`,
    });
    expect(teamExportTarget('../admin')).toEqual({ ok: false, error: 'Nodo inválido.' });
  });
});

describe('GET /api/admin/exports/users', () => {
  it.each(['same-site', 'cross-site'])('desde %s no se exporta nada: 403', async (site) => {
    const res = await exportDirectory(directory('', { 'sec-fetch-site': site }));
    expect(res.status).toBe(403);
    expect(mocks.apiDownload).not.toHaveBeenCalled();
  });

  it('un cursor es 400 sin llamar al API', async () => {
    const res = await exportDirectory(directory('cursor=abc'));
    expect(res.status).toBe(400);
    expect(mocks.apiDownload).not.toHaveBeenCalled();
  });

  it('pasa el CSV en bytes, con su nombre, cuántas personas y sin caché', async () => {
    mocks.apiDownload.mockResolvedValue(file('usuarios-2026-10-13.csv'));
    const res = await exportDirectory(directory('role=vendedor&mfa=on'));
    expect(res.status).toBe(200);
    expect(mocks.apiDownload).toHaveBeenCalledWith(
      '/admin/exports/users?role=vendedor&mfa=on',
      ['text/csv'],
      EXPOSED,
    );
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toContain('usuarios-2026-10-13.csv');
    expect(res.headers.get('x-export-users')).toBe('2');
    expect(res.headers.get('x-export-truncated')).toBe('false');
    const body = new Uint8Array(await res.arrayBuffer());
    // El BOM llega: sin él Excel lee mal las tildes.
    expect([...body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('el 403 del 2FA vuelve con MFA_RECENT_REQUIRED para que el panel pida el código', async () => {
    mocks.apiDownload.mockResolvedValue({
      kind: 'json',
      status: 403,
      body: {
        message: 'Confirma con tu código de verificación en dos pasos para seguir.',
        reason: 'MFA_RECENT_REQUIRED',
      },
    });
    const res = await exportDirectory(directory(''));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Confirma con tu código de verificación en dos pasos para seguir.',
      reason: 'MFA_RECENT_REQUIRED',
    });
  });

  it('el 429 vuelve como 429; un 2xx que no es un CSV no es una exportación', async () => {
    mocks.apiDownload.mockResolvedValueOnce({
      kind: 'json',
      status: 429,
      body: { message: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.' },
    });
    expect((await exportDirectory(directory(''))).status).toBe(429);
    mocks.apiDownload.mockResolvedValueOnce({ kind: 'json', status: 200, body: { ok: true } });
    expect((await exportDirectory(directory(''))).status).toBe(502);
  });
});

describe('GET /api/tenants/:tenantId/members-export', () => {
  it('desde otro sitio, 403; un id que no es UUID, 400; nada llega al API', async () => {
    expect((await team(NODE, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await team('..%2Fadmin')).status).toBe(400);
    expect(mocks.apiDownload).not.toHaveBeenCalled();
  });

  it('pasa el CSV del equipo', async () => {
    mocks.apiDownload.mockResolvedValue(file('equipo-norte-2026-10-13.csv'));
    const res = await team(NODE);
    expect(res.status).toBe(200);
    expect(mocks.apiDownload).toHaveBeenCalledWith(
      `/tenants/${NODE.toLowerCase()}/members-export`,
      ['text/csv'],
      EXPOSED,
    );
    expect(res.headers.get('content-disposition')).toContain('equipo-norte-2026-10-13.csv');
  });

  it('el 403 de un nodo ajeno vuelve con su motivo', async () => {
    mocks.apiDownload.mockResolvedValue({
      kind: 'json',
      status: 403,
      body: { message: 'No administras este nodo.', reason: 'TENANT_NOT_MANAGED' },
    });
    const res = await team(NODE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'No administras este nodo.',
      reason: 'TENANT_NOT_MANAGED',
    });
  });
});
