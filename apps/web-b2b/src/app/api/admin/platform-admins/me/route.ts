import type { NextResponse } from 'next/server';
import { forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/** Qué es quien mira: superadmin pleno o supervisado. */
export async function GET(): Promise<NextResponse> {
  return forwardRead({ ok: true, path: '/admin/platform-admins/me' });
}
