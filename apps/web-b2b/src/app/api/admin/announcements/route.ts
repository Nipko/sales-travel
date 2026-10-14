import type { NextResponse } from 'next/server';
import { createAnnouncementPlan } from '../../../../lib/announcements';
import { forwardPlan, forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/**
 * Plataforma → Sistema › Anuncios: la lista (los últimos 50) y publicar uno nuevo. Publicar sólo
 * desde el panel (mismo origen) y con el cuerpo rearmado campo por campo. Quién puede lo decide el
 * API (sólo el superadmin).
 */
export async function GET(): Promise<NextResponse> {
  return forwardRead({ ok: true, path: '/admin/announcements' });
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, createAnnouncementPlan(raw), 'POST');
}
