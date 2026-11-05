import type { NextResponse } from 'next/server';
import { changeRequestsTarget } from '../../../../lib/platform-admins';
import { forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/** Las solicitudes de cambio de los superadmins supervisados, por estado. */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(changeRequestsTarget(new URL(req.url).searchParams));
}
