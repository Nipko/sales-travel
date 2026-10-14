import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Reservas de la red › Exportar CSV en el BFF: sólo desde el panel, con la query rearmada con los
 * filtros de la lista (sin la página), el CSV en bytes con su BOM y su nombre, y los errores del API
 * con su motivo: el 403 del 2FA para que el panel pida el código y el 422 de más de 5.000.
 */

const mocks = vi.hoisted(() => ({ apiDownload: vi.fn() }));

vi.mock('../../../../../lib/api', () => ({ apiDownload: mocks.apiDownload }));

import { GET } from './route';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const NODE = '10000000-0000-4000-8000-0000000000AA';

function request(query: string, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`https://app.test/api/admin/orders/export?${query}`, { headers });
}

function file(rows = '2') {
  const bytes = new TextEncoder().encode('\uFEFFfecha (America/Bogota),nodo\r\n');
  return {
    kind: 'file',
    status: 200,
    body: bytes.buffer,
    contentType: 'text/csv; charset=utf-8',
    headers: {
      'content-disposition': 'attachment; filename="reservas-2026-10-13.csv"',
      'x-export-rows': rows,
    },
  };
}

beforeEach(() => {
  mocks.apiDownload.mockReset();
});

describe('GET /api/admin/orders/export', () => {
  it.each(['same-site', 'cross-site'])('desde %s no se exporta nada: 403', async (site) => {
    const res = await GET(request('status=confirmed', { 'sec-fetch-site': site }));
    expect(res.status).toBe(403);
    expect(mocks.apiDownload).not.toHaveBeenCalled();
  });

  it('rearma los filtros de la lista y pasa el CSV en bytes, con su nombre y cuántas', async () => {
    mocks.apiDownload.mockResolvedValue(file());
    const res = await GET(
      request(
        `tenantId=${NODE}&subtree=false&status=confirmed,ticketed&from=2026-10-01&to=2026-10-13&q=ABC123&attention=true`,
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.apiDownload).toHaveBeenCalledWith(
      `/admin/orders/export?tenantId=${NODE.toLowerCase()}&subtree=false&status=confirmed%2Cticketed&from=2026-10-01&to=2026-10-13&q=ABC123&attention=true`,
      ['text/csv'],
      ['x-export-rows'],
    );
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="reservas-2026-10-13.csv"',
    );
    expect(res.headers.get('x-export-rows')).toBe('2');
    const body = new Uint8Array(await res.arrayBuffer());
    // El BOM llega: sin él Excel lee mal las tildes.
    expect([...body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('un parámetro que no es un filtro de la lista (o la página) no llega al API: 400', async () => {
    for (const query of ['cursor=abc', 'limit=10', 'tenant_id=x', 'status=borrador']) {
      const res = await GET(request(query));
      expect(res.status, query).toBe(400);
    }
    expect(mocks.apiDownload).not.toHaveBeenCalled();
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
    const res = await GET(request(''));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Confirma con tu código de verificación en dos pasos para seguir.',
      reason: 'MFA_RECENT_REQUIRED',
    });
  });

  it('más de 5.000: el 422 vuelve con su mensaje', async () => {
    mocks.apiDownload.mockResolvedValue({
      kind: 'json',
      status: 422,
      body: {
        message: 'Hay más de 5.000 reservas con estos filtros: acota las fechas o el nodo.',
        reason: 'EXPORT_TOO_LARGE',
      },
    });
    const res = await GET(request('provider=latam-ndc'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Hay más de 5.000 reservas con estos filtros: acota las fechas o el nodo.',
      reason: 'EXPORT_TOO_LARGE',
    });
  });

  it('un 2xx que no es un CSV no es una exportación', async () => {
    mocks.apiDownload.mockResolvedValue({ kind: 'json', status: 200, body: { ok: true } });
    const res = await GET(request(''));
    expect(res.status).toBe(502);
  });
});
