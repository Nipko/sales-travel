import type { NextResponse } from 'next/server';
import { tenantGovernanceTarget } from '../../../../../../lib/governance-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/** El gobierno de un nodo: su perfil, sus reglas a mano y la matriz efectiva con su origen. */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardRead(tenantGovernanceTarget(tenantId));
}
