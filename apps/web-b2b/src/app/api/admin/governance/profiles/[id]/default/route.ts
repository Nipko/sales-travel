import type { NextResponse } from 'next/server';
import { setDefaultProfilePlan } from '../../../../../../../lib/governance-proxy';
import { forwardPlan } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Marca o desmarca el perfil predeterminado para nodos nuevos. */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, setDefaultProfilePlan(id, raw), 'PUT');
}
