import type { NextResponse } from 'next/server';
import { revokePlan } from '../../../../../../lib/platform-admins';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ userId: string }> };

/** Le quita el acceso de superadmin. */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { userId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, revokePlan(userId, raw), 'POST');
}
