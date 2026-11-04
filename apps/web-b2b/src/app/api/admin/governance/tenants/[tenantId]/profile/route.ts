import type { NextResponse } from 'next/server';
import { assignProfilePlan } from '../../../../../../../lib/governance-proxy';
import { forwardPlan } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/** Asigna un perfil al nodo, o lo quita (`profileId: null`) para que vuelva a heredar. */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, assignProfilePlan(tenantId, raw), 'PUT');
}
