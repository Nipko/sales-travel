import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel para Plataforma → Actividad: la lista sólo lee con la query rearmada; la
 * exportación sólo sale desde el panel, pasa el CSV en bytes (con su BOM) y devuelve el motivo del
 * 403 del 2FA para que el panel pida el código.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn(), apiDownload: vi.fn() }));

vi.mock('../../../../lib/api', () => ({
  apiWithStatus: mocks.apiWithStatus,
  apiDownload: mocks.apiDownload,
}));

import { GET as exportCsv } from './export/route';
import { GET as list } from './route';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

function request(query: string, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`https://app.test/api/admin/audit/export?${query}`, { headers });
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiDownload.mockReset();
  mocks.apiWithStatus.mockResolvedValue({
    kind: 'json',
    status: 200,
    body: { events: [], nextCursor: null },
  });
});

describe('GET /api/admin/audit', () => {
  it('reenvía la query rearmada', async () => {
    const res = await list(
      new Request('https://app.test/api/admin/audit?category=orders&from=2026-10-01&to=2026-10-13'),
    );
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      '/admin/audit?from=2026-10-01&to=2026-10-13&category=orders',
    );
  });

  it('un filtro desconocido no llega al API: 400', async () => {
    const res = await list(new Request('https://app.test/api/admin/audit?tenant=x'));
    expect(res.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('el 403 del API vuelve con su motivo', async () => {
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 403,
      body: { message: 'Esta acción es sólo para el superadmin.', reason: 'SUPERADMIN_REQUIRED' },
    });
    const res = await list(new Request('https://app.test/api/admin/audit'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Esta acción es sólo para el superadmin.',
      reason: 'SUPERADMIN_REQUIRED',
    });
  });
});

describe('GET /api/admin/audit/export', () => {
  it.each(['same-site', 'cross-site'])('desde %s no se exporta nada: 403', async (site) => {
    const res = await exportCsv(request('category=system', { 'sec-fetch-site': site }));
    expect(res.status).toBe(403);
    expect(mocks.apiDownload).not.toHaveBeenCalled();
  });

  it('pasa el CSV en bytes, con su nombre y cuántas filas', async () => {
    const bytes = new TextEncoder().encode('\uFEFFfecha,evento\r\n');
    mocks.apiDownload.mockResolvedValue({
      kind: 'file',
      status: 200,
      body: bytes.buffer,
      contentType: 'text/csv; charset=utf-8',
      headers: {
        'content-disposition': 'attachment; filename="actividad-2026-10-07-a-2026-10-13.csv"',
        'x-export-rows': '0',
        'x-export-truncated': 'false',
      },
    });
    const res = await exportCsv(request('category=system&cursor=x'));
    // `cursor` no es de la exportación: 400 sin llamar al API.
    expect(res.status).toBe(400);
    expect(mocks.apiDownload).not.toHaveBeenCalled();

    const ok = await exportCsv(request('category=system&from=2026-10-07&to=2026-10-13'));
    expect(ok.status).toBe(200);
    expect(mocks.apiDownload).toHaveBeenCalledWith(
      '/admin/audit/export?from=2026-10-07&to=2026-10-13&category=system',
      ['text/csv'],
      ['x-export-rows', 'x-export-truncated'],
    );
    expect(ok.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('content-disposition')).toContain(
      'actividad-2026-10-07-a-2026-10-13.csv',
    );
    expect(ok.headers.get('x-export-rows')).toBe('0');
    const body = new Uint8Array(await ok.arrayBuffer());
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
    const res = await exportCsv(request(''));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Confirma con tu código de verificación en dos pasos para seguir.',
      reason: 'MFA_RECENT_REQUIRED',
    });
  });

  it('un 2xx que no es un CSV no es una exportación', async () => {
    mocks.apiDownload.mockResolvedValue({ kind: 'json', status: 200, body: { ok: true } });
    const res = await exportCsv(request(''));
    expect(res.status).toBe(502);
  });
});
