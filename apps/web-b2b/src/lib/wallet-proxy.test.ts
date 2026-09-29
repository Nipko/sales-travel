import { describe, expect, it } from 'vitest';
import {
  agencyWalletPlan,
  planFailureReply,
  walletFinancingPlan,
  walletProxyReply,
  type WalletProxyRequest,
} from './wallet-proxy';

const NODE = '10000000-0000-4000-8000-00000000000A';
const WALLET = '20000000-0000-4000-8000-000000000002';
const REPORT = '30000000-0000-4000-8000-000000000001';
const KEY = '40000000-0000-4000-8000-000000000001';

function req(
  method: string,
  segments: string[] = [],
  body?: unknown,
  opts: { search?: string; key?: string | null } = {},
): WalletProxyRequest {
  return {
    method,
    segments,
    search: new URLSearchParams(opts.search ?? ''),
    body,
    idempotencyKey: opts.key ?? null,
  };
}

const base = `/tenants/${NODE.toLowerCase()}/portfolios`;

describe('walletFinancingPlan — lo que manda quien financia', () => {
  it('lee las carteras, los movimientos (por moneda) y los informes (por estado)', () => {
    expect(walletFinancingPlan(NODE, req('GET'))).toEqual({ ok: true, method: 'GET', path: base });
    expect(
      walletFinancingPlan(
        NODE,
        req('GET', ['transactions'], undefined, { search: 'currency=USD' }),
      ),
    ).toMatchObject({
      ok: true,
      path: `${base}/transactions?currency=USD`,
    });
    expect(
      walletFinancingPlan(
        NODE,
        req('GET', ['deposit-reports'], undefined, { search: 'status=pending' }),
      ),
    ).toMatchObject({ ok: true, path: `${base}/deposit-reports?status=pending` });
  });

  it('un filtro raro no compone otra consulta', () => {
    expect(
      walletFinancingPlan(
        NODE,
        req('GET', ['transactions'], undefined, { search: 'currency=US&x=1' }),
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      walletFinancingPlan(
        NODE,
        req('GET', ['deposit-reports'], undefined, { search: 'status=all' }),
      ),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('habilitar una moneda rearma el cuerpo campo por campo', () => {
    expect(
      walletFinancingPlan(
        NODE,
        req('POST', [], {
          currency: 'USD',
          creditLimitMinor: 0,
          reason: 'Contrato',
          tenantId: 'x',
        }),
      ),
    ).toEqual({
      ok: true,
      method: 'POST',
      path: base,
      body: { currency: 'USD', creditLimitMinor: 0, reason: 'Contrato' },
    });
    expect(
      walletFinancingPlan(NODE, req('POST', [], { currency: 'USD', creditLimitMinor: 1.5 })),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('fijar el cupo o el estado es un PATCH a la cartera', () => {
    expect(
      walletFinancingPlan(NODE, req('PATCH', [WALLET], { status: 'suspended', reason: 'Deuda' })),
    ).toEqual({
      ok: true,
      method: 'PATCH',
      path: `${base}/${WALLET}`,
      body: { status: 'suspended', reason: 'Deuda' },
    });
    expect(walletFinancingPlan(NODE, req('POST', [WALLET], {}))).toMatchObject({ status: 405 });
  });

  it('depósitos y ajustes exigen la Idempotency-Key y la reenvían', () => {
    const body = { amountMinor: -500, reason: 'Cargo acordado' };
    expect(
      walletFinancingPlan(NODE, req('POST', [WALLET, 'adjustments'], body, { key: KEY })),
    ).toEqual({
      ok: true,
      method: 'POST',
      path: `${base}/${WALLET}/adjustments`,
      body,
      idempotencyKey: KEY,
    });
    expect(walletFinancingPlan(NODE, req('POST', [WALLET, 'deposits'], body))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      walletFinancingPlan(NODE, req('POST', [WALLET, 'deposits'], body, { key: 'no-es-uuid' })),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('aprobar admite cuerpo vacío o comentario; rechazar exige el motivo como texto', () => {
    expect(walletFinancingPlan(NODE, req('POST', ['deposit-reports', REPORT, 'approve']))).toEqual({
      ok: true,
      method: 'POST',
      path: `${base}/deposit-reports/${REPORT}/approve`,
      body: {},
    });
    expect(
      walletFinancingPlan(
        NODE,
        req('POST', ['deposit-reports', REPORT, 'approve'], { reason: null }),
      ),
    ).toMatchObject({ ok: true, body: { reason: null } });
    expect(
      walletFinancingPlan(NODE, req('POST', ['deposit-reports', REPORT, 'reject'], { reason: 5 })),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('rutas que no existen o ids rotos: 404, sin llegar al API', () => {
    for (const plan of [
      walletFinancingPlan('../admin', req('GET')),
      walletFinancingPlan(NODE, req('GET', ['..', 'admin'])),
      walletFinancingPlan(NODE, req('POST', ['deposit-reports', REPORT, 'delete'])),
      walletFinancingPlan(NODE, req('POST', [WALLET, 'withdraw'], {}, { key: KEY })),
      walletFinancingPlan(NODE, req('GET', [WALLET, 'deposits', 'x'])),
    ]) {
      expect(plan).toMatchObject({ ok: false, status: 404 });
    }
  });
});

describe('agencyWalletPlan — lo que manda la agencia', () => {
  it('lee sus carteras, movimientos e informes', () => {
    expect(agencyWalletPlan(req('GET'))).toEqual({ ok: true, method: 'GET', path: '/portfolios' });
    expect(
      agencyWalletPlan(req('GET', ['transactions'], undefined, { search: 'currency=COP' })),
    ).toMatchObject({
      path: '/portfolios/transactions?currency=COP',
    });
    expect(agencyWalletPlan(req('GET', ['deposit-reports']))).toMatchObject({
      path: '/portfolios/deposit-reports',
    });
  });

  it('informa un depósito con su Idempotency-Key', () => {
    const body = {
      currency: 'USD',
      amountMinor: 50_000,
      reference: '54223',
      depositedOn: null,
      notes: null,
    };
    expect(agencyWalletPlan(req('POST', ['deposit-reports'], body, { key: KEY }))).toEqual({
      ok: true,
      method: 'POST',
      path: '/portfolios/deposit-reports',
      body,
      idempotencyKey: KEY,
    });
    expect(agencyWalletPlan(req('POST', ['deposit-reports'], body))).toMatchObject({ status: 400 });
  });

  it('no deja pasar las escrituras viejas de la agencia sobre su saldo o su cupo', () => {
    expect(agencyWalletPlan(req('PATCH'))).toMatchObject({ ok: false, status: 405 });
    expect(agencyWalletPlan(req('POST'))).toMatchObject({ ok: false, status: 405 });
    expect(agencyWalletPlan(req('POST', ['deposit'], { amountMinor: 1 }))).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(agencyWalletPlan(req('POST', ['withdraw'], { amountMinor: 1 }))).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('walletProxyReply — lo que vuelve al navegador', () => {
  it('en éxito, el cuerpo del API tal cual', () => {
    expect(walletProxyReply({ kind: 'json', status: 201, body: { portfolio: { id: 1 } } })).toEqual(
      {
        status: 201,
        body: { portfolio: { id: 1 } },
      },
    );
  });

  it('en error, sólo el mensaje y el motivo máquina', () => {
    expect(
      walletProxyReply({
        kind: 'json',
        status: 403,
        body: {
          statusCode: 403,
          message: 'Sólo quien financia a este nodo gestiona sus carteras.',
          reason: 'PORTFOLIO_FINANCIER_REQUIRED',
          stack: 'no debería salir',
        },
      }),
    ).toEqual({
      status: 403,
      body: {
        error: 'Sólo quien financia a este nodo gestiona sus carteras.',
        reason: 'PORTFOLIO_FINANCIER_REQUIRED',
      },
    });
    expect(
      walletProxyReply({ kind: 'json', status: 400, body: { message: ['a', 'b'], reason: 'x y' } }),
    ).toEqual({ status: 400, body: { error: 'a. b' } });
  });

  it('sin JSON del API, el estado y un mensaje nuestro', () => {
    expect(walletProxyReply({ kind: 'unreachable', status: 503, message: 'Sin conexión' })).toEqual(
      {
        status: 503,
        body: { error: 'Sin conexión' },
      },
    );
    expect(planFailureReply({ ok: false, status: 404, error: 'Ruta' })).toEqual({
      status: 404,
      body: { error: 'Ruta' },
    });
  });
});
