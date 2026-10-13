import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOldestPlatformDeposit, loadPlatformOverview } from './platform-overview-client';
import { NODE_SUR, overviewPayload } from './platform-overview.fixture';

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPlatformOverview', () => {
  it('pide el período (y el nodo) al BFF y devuelve el Resumen validado', async () => {
    const fetchMock = respond(200, overviewPayload());
    const res = await loadPlatformOverview('7d', NODE_SUR);
    expect(res.ok).toBe(true);
    expect(res.ok ? res.data.sales.byCurrency.length : 0).toBe(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/admin/overview?period=7d&tenantId=${NODE_SUR}`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' });
  });

  it('el 403 del API llega con su texto', async () => {
    respond(403, { error: 'Sólo el superadmin ve la consola de la plataforma.' });
    expect(await loadPlatformOverview('30d', null)).toEqual({
      ok: false,
      status: 403,
      message: 'Sólo el superadmin ve la consola de la plataforma.',
    });
  });

  it('un 500 no muestra el texto técnico', async () => {
    respond(500, { error: 'Internal server error' });
    expect(await loadPlatformOverview('30d', null)).toEqual({
      ok: false,
      status: 500,
      message: 'No pudimos cargar el resumen. Reintenta en unos segundos.',
    });
  });

  it('una respuesta que no es el Resumen es ilegible', async () => {
    respond(200, { hola: 1 });
    expect(await loadPlatformOverview('30d', null)).toMatchObject({
      ok: false,
      message: 'El servidor respondió algo que no pudimos leer. Recarga la página.',
    });
  });

  it('sin conexión', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await loadPlatformOverview('30d', null)).toEqual({
      ok: false,
      status: 0,
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    });
  });
});

describe('loadOldestPlatformDeposit', () => {
  it('el primero de la cola de pendientes de Planetour es el más antiguo', async () => {
    const fetchMock = respond(200, {
      status: 'pending',
      nextCursor: 'x',
      totals: [],
      reports: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          tenantId: NODE_SUR,
          portfolioId: '20000000-0000-4000-8000-000000000002',
          currency: 'USD',
          exponent: 2,
          amountMinor: 12_000,
          reference: 'WIRE-77',
          depositedOn: null,
          notes: null,
          status: 'pending',
          reportedByName: 'Ana',
          reportedAt: '2026-10-08T15:00:00.000Z',
          resolvedByName: null,
          resolvedAt: null,
          resolutionReason: null,
          tenant: {
            id: NODE_SUR,
            name: 'Agencia Sur',
            slug: 'agencia-sur',
            tenantType: 'agency',
            isBranch: true,
            status: 'active',
          },
          financier: null,
          financedByPlatform: true,
        },
      ],
    });
    expect(await loadOldestPlatformDeposit(NODE_SUR)).toBe('2026-10-08T15:00:00.000Z');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/admin/deposit-reports?status=pending&financedBy=platform&limit=1&tenantId=${NODE_SUR}`,
    );
  });

  it('una cola vacía es null; una que no se pudo leer, undefined', async () => {
    respond(200, { status: 'pending', nextCursor: null, totals: [], reports: [] });
    expect(await loadOldestPlatformDeposit(null)).toBeNull();
    respond(503, { error: 'Servicio no disponible' });
    expect(await loadOldestPlatformDeposit(null)).toBeUndefined();
  });
});
