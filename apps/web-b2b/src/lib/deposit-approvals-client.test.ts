import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPROVALS_FILTERS, PENDING_DEPOSITS_CHANGED } from './deposit-approvals';
import {
  loadDepositApprovals,
  loadPendingDeposits,
  notifyPendingDepositsChanged,
} from './deposit-approvals-client';

function respond(status: number, body: unknown, asText = false) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(asText ? String(body) : JSON.stringify(body), {
        status,
        headers: { 'content-type': asText ? 'text/html' : 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadDepositApprovals', () => {
  it('pide la cola con los filtros y el cursor, y la devuelve validada', async () => {
    const fetchMock = respond(200, {
      status: 'pending',
      reports: [],
      nextCursor: null,
      totals: [],
    });
    const res = await loadDepositApprovals(DEFAULT_APPROVALS_FILTERS, 'cur_1');
    expect(res).toEqual({
      ok: true,
      data: { status: 'pending', reports: [], nextCursor: null, totals: [] },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/admin/deposit-reports?status=pending&financedBy=platform&cursor=cur_1',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' });
  });

  it('un error con mensaje del BFF lo muestra tal cual', async () => {
    respond(403, { error: 'Sólo el superadmin ve los depósitos informados de toda la red.' });
    expect(await loadDepositApprovals(DEFAULT_APPROVALS_FILTERS)).toEqual({
      ok: false,
      status: 403,
      message: 'Sólo el superadmin ve los depósitos informados de toda la red.',
    });
  });

  it('sin mensaje, uno nuestro según el estado', async () => {
    respond(502, { error: '' });
    const res = await loadDepositApprovals(DEFAULT_APPROVALS_FILTERS);
    expect(res.ok ? '' : res.message).toBe(
      'No pudimos cargar los depósitos. Reintenta en unos segundos.',
    );
  });

  it('una respuesta con otra forma no se muestra como datos', async () => {
    respond(200, { reports: 'nada' });
    const res = await loadDepositApprovals(DEFAULT_APPROVALS_FILTERS);
    expect(res.ok ? '' : res.message).toMatch(/no pudimos leer/);
  });

  it('sin conexión, lo dice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await loadDepositApprovals(DEFAULT_APPROVALS_FILTERS)).toEqual({
      ok: false,
      status: 0,
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    });
  });
});

describe('loadPendingDeposits', () => {
  it('lee el contador', async () => {
    const fetchMock = respond(200, { total: 4, platform: 3, network: 1 });
    expect(await loadPendingDeposits()).toEqual({
      ok: true,
      data: { total: 4, platform: 3, network: 1 },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/deposit-reports/pending-count');
  });
});

describe('notifyPendingDepositsChanged', () => {
  it('avisa al menú con el evento acordado', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    notifyPendingDepositsChanged();
    expect((dispatchEvent.mock.calls[0]?.[0] as Event).type).toBe(PENDING_DEPOSITS_CHANGED);
  });
});
