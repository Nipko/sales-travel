import type { NextResponse } from 'next/server';
import { archiveProfileTarget } from '../../../../../../../lib/governance-proxy';
import { forwardAction } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Archiva un perfil. El API responde 409 si algún nodo todavía lo usa. */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  return forwardAction(req, archiveProfileTarget(id));
}
