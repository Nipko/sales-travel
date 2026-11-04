import type { NextResponse } from 'next/server';
import { duplicateProfilePlan } from '../../../../../../../lib/governance-proxy';
import { forwardPlan } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Duplica un perfil con otro nombre. */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, duplicateProfilePlan(id, raw), 'POST');
}
