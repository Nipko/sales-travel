import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveDepositReport,
  loadAgencyNetworkHolds,
  loadAgencyWallets,
  loadFinancedNetworkHolds,
  loadFinancedWallets,
  recordEntry,
  refreshAfterFailure,
  submitDepositReport,
  walletErrorMessage,
} from './wallet-client';

const NODE = '10000000-0000-4000-8000-000000000001';
const WALLET = '20000000-0000-4000-8000-000000000002';
const REPORT = '30000000-0000-4000-8000-000000000001';
const KEY = '40000000-0000-4000-8000-000000000001';

const API_WALLET = {
  id: WALLET,
  tenantId: NODE,
  currency: 'USD',
  exponent: 2,
  creditLimitMinor: 0,
  balanceMinor: 50_000,
  availableMinor: 50_000,
  status: 'active',
  updatedAt: '2026-09-29T12:00:00.000Z',
};

const API_MOVEMENT = {
  id: '50000000-0000-4000-8000-000000000001',
  portfolioId: WALLET,
  currency: 'USD',
  exponent: 2,
  amountMinor: 50_000,
  transactionType: 'DEPOSIT_PAYMENT',
  referenceId: null,
  notes: 'Transferencia verificada',
  createdBy: NODE,
  createdByName: 'Luis',
  createdAt: '2026-09-29T12:00:00.000Z',
};

const API_REPORT = {
  id: REPORT,
  portfolioId: WALLET,
  currency: 'USD',
  exponent: 2,
  amountMinor: 50_000,
  reference: '54223',
  depositedOn: null,
  notes: null,
  status: 'approved',
  reportedByName: 'Ana',
  reportedAt: '2026-09-29T12:00:00.000Z',
  resolvedByName: 'Luis',
  resolvedAt: '2026-09-29T13:00:00.000Z',
  resolutionReason: null,
};

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

describe('lecturas', () => {
  it('las carteras de la agencia, validadas', async () => {
    respond(200, { portfolios: [API_WALLET], financier: null });
    const res = await loadAgencyWallets();
    expect(res.ok && res.data.portfolios[0]?.currency).toBe('USD');
  });

  it('un 403 de quien no financia trae el mensaje y el motivo del API', async () => {
    respond(403, { error: 'Sólo quien financia…', reason: 'PORTFOLIO_FINANCIER_REQUIRED' });
    expect(await loadFinancedWallets(NODE)).toEqual({
      ok: false,
      status: 403,
      message: 'Sólo quien financia…',
      reason: 'PORTFOLIO_FINANCIER_REQUIRED',
    });
  });

  it('sin mensaje del API, uno nuestro según el estado', async () => {
    respond(403, { error: '' });
    const res = await loadFinancedWallets(NODE);
    expect(res.ok ? '' : res.message).toMatch(/Sólo quien financia/);
  });

  it('las reservas de la red, validadas, por el proxy de cada vista', async () => {
    const hold = {
      levelId: '60000000-0000-4000-8000-000000000001',
      currency: 'USD',
      exponent: 2,
      amountMinor: 113_400,
      status: 'held',
      originTenantId: NODE,
      originTenantName: 'Agencia Sur',
      orderNumber: 1042,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
    };
    const fetchMock = respond(200, { items: [hold], totals: [] });
    const own = await loadAgencyNetworkHolds();
    expect(own.ok && own.data.items[0]?.originTenantName).toBe('Agencia Sur');
    // La página reciente y, aparte, las retenidas y las en revisión: la página las puede cortar.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/portfolios/network-holds',
      '/api/portfolios/network-holds?status=held',
      '/api/portfolios/network-holds?status=conflict',
    ]);
    // La misma reserva en las tres respuestas se muestra una vez.
    expect(own.ok && own.data.items).toHaveLength(1);
    await loadFinancedNetworkHolds(NODE);
    expect(fetchMock.mock.calls.slice(3).map((c) => c[0])).toEqual([
      `/api/tenants/${NODE}/portfolios/network-holds`,
      `/api/tenants/${NODE}/portfolios/network-holds?status=held`,
      `/api/tenants/${NODE}/portfolios/network-holds?status=conflict`,
    ]);
  });

  it('si no se pueden leer las abiertas de la red, no hay vista que cuente de menos', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('status=conflict')
          ? new Response(JSON.stringify({ error: 'Falló.' }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify({ items: [], totals: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadAgencyNetworkHolds()).toMatchObject({ ok: false, message: 'Falló.' });
  });

  it('una forma rota no se pinta', async () => {
    respond(200, { portfolio: API_WALLET });
    expect(await loadAgencyWallets()).toMatchObject({ ok: false, message: /no pudimos leer/ });
  });

  it('sin conexión, lo dice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fail'))),
    );
    expect(await loadAgencyWallets()).toMatchObject({ ok: false, message: /No pudimos conectar/ });
  });
});

describe('escrituras', () => {
  it('un depósito viaja con su Idempotency-Key y devuelve la cartera y el asiento', async () => {
    const fetchMock = respond(201, { portfolio: API_WALLET, transaction: API_MOVEMENT });
    const res = await recordEntry(
      NODE,
      WALLET,
      'deposit',
      { amountMinor: 50_000, reason: 'Transf' },
      KEY,
    );
    expect(res.ok && res.data.transaction.notes).toBe('Transferencia verificada');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tenants/${NODE}/portfolios/${WALLET}/deposits`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(KEY);
  });

  it('si la conexión se corta no se sabe si llegó: se avisa que se reintente igual', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fail'))),
    );
    const res = await recordEntry(
      NODE,
      WALLET,
      'adjustment',
      { amountMinor: -1, reason: 'x' },
      KEY,
    );
    expect(res).toMatchObject({ ok: false, uncertain: true, message: /no se duplica/ });
  });

  it('una página de error del proxy en una escritura también es incierta', async () => {
    respond(502, '<!DOCTYPE html><html></html>', true);
    const res = await submitDepositReport(
      { currency: 'USD', amountMinor: 1, reference: 'x', depositedOn: null, notes: null },
      KEY,
    );
    expect(res).toMatchObject({ ok: false, uncertain: true });
  });

  it('aprobar devuelve el informe resuelto y la cartera', async () => {
    respond(200, { report: API_REPORT, portfolio: API_WALLET, transaction: API_MOVEMENT });
    const res = await approveDepositReport(NODE, REPORT, { reason: null });
    expect(res.ok && res.data.report.status).toBe('approved');
  });

  it('un 409 con motivo se muestra con el texto del API', async () => {
    respond(409, {
      error: 'El depósito informado ya fue resuelto: se aprueba o se rechaza una sola vez.',
      reason: 'DEPOSIT_REPORT_NOT_PENDING',
    });
    const res = await approveDepositReport(NODE, REPORT, { reason: null });
    expect(res).toMatchObject({ ok: false, status: 409, reason: 'DEPOSIT_REPORT_NOT_PENDING' });
    expect(res.ok ? '' : res.message).toMatch(/una sola vez/);
  });
});

describe('refreshAfterFailure — cuándo releer tras una escritura fallida', () => {
  it('sin saber si llegó, con conflicto o si ya no existe: relee', () => {
    expect(refreshAfterFailure({ ok: false, status: 0, message: 'x', uncertain: true })).toBe(true);
    expect(refreshAfterFailure({ ok: false, status: 502, message: 'x', uncertain: true })).toBe(
      true,
    );
    expect(
      refreshAfterFailure({
        ok: false,
        status: 409,
        message: 'x',
        reason: 'DEPOSIT_REPORT_NOT_PENDING',
      }),
    ).toBe(true);
    expect(refreshAfterFailure({ ok: false, status: 404, message: 'x' })).toBe(true);
  });

  it('un dato inválido o un permiso negado no cambian lo que se ve: no relee', () => {
    expect(refreshAfterFailure({ ok: false, status: 400, message: 'x' })).toBe(false);
    expect(
      refreshAfterFailure({
        ok: false,
        status: 403,
        message: 'x',
        reason: 'PORTFOLIO_FINANCIER_REQUIRED',
      }),
    ).toBe(false);
  });
});

describe('walletErrorMessage', () => {
  it('por estado, sin el texto del API', () => {
    expect(walletErrorMessage(401, 'read')).toMatch(/sesión venció/);
    expect(walletErrorMessage(404, 'write')).toMatch(/No encontramos/);
    expect(walletErrorMessage(500, 'write')).toMatch(/No se pudo guardar/);
    expect(walletErrorMessage(500, 'read')).toMatch(/No se pudieron cargar/);
  });
});
