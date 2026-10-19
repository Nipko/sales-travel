import type { NextResponse } from 'next/server';
import {
  foreignCurrencyFaresPlan,
  foreignCurrencyFaresTarget,
} from '../../../../../../lib/foreign-currency-fares';
import { forwardPlan, forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/** Tarifas en otra moneda del nodo (0087). Sólo superadmin: lo decide el API. */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardRead(foreignCurrencyFaresTarget(tenantId));
}

export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardPlan(
    req,
    foreignCurrencyFaresPlan(tenantId, await req.json().catch(() => undefined)),
    'PATCH',
  );
}
