import { NextResponse } from 'next/server';
import { apiWithStatus } from './api';
import {
  planFailureReply,
  walletProxyReply,
  type WalletProxyPlan,
  type WalletProxyRequest,
} from './wallet-proxy';

/**
 * Lo común de las rutas proxy de carteras: leer el pedido del navegador y reenviar lo que decidió
 * el plan (lib/wallet-proxy.ts). Los cuerpos nunca se registran: llevan montos y referencias
 * bancarias.
 */

export async function walletProxyRequest(
  req: Request,
  segments: readonly string[] = [],
): Promise<WalletProxyRequest> {
  const url = new URL(req.url);
  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.json().catch(() => undefined);
  }
  return {
    method: req.method,
    segments,
    search: url.searchParams,
    body,
    idempotencyKey: req.headers.get('idempotency-key'),
  };
}

export async function forwardWalletPlan(plan: WalletProxyPlan): Promise<NextResponse> {
  if (!plan.ok) {
    const reply = planFailureReply(plan);
    return NextResponse.json(reply.body, { status: reply.status });
  }
  const res = await apiWithStatus(plan.path, {
    method: plan.method,
    ...(plan.idempotencyKey === undefined
      ? {}
      : { headers: { 'Idempotency-Key': plan.idempotencyKey } }),
    ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
  });
  const reply = walletProxyReply(res);
  return NextResponse.json(reply.body, { status: reply.status });
}
