import type { NextResponse } from 'next/server';
import { updateProfilePlan } from '../../../../../../lib/governance-proxy';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Edita un perfil enlazado: el cambio alcanza a todos los nodos que lo usan. */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, updateProfilePlan(id, raw), 'PUT');
}
