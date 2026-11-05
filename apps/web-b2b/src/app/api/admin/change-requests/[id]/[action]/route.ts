import type { NextResponse } from 'next/server';
import { decisionPlan } from '../../../../../../lib/platform-admins';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string; action: string }> };

/** Aprobar (aplica el cambio: pide 2FA reciente), rechazar o cancelar una solicitud. */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { id, action } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, decisionPlan(id, action, raw), 'POST');
}
