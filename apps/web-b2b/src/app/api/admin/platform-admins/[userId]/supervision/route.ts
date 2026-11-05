import type { NextResponse } from 'next/server';
import { supervisionPlan } from '../../../../../../lib/platform-admins';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ userId: string }> };

/** Pleno ↔ supervisado. */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { userId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, supervisionPlan(userId, raw), 'PUT');
}
