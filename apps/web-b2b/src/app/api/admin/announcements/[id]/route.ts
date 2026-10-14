import type { NextResponse } from 'next/server';
import { updateAnnouncementPlan } from '../../../../../lib/announcements';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Corregir un anuncio: sólo desde el panel (mismo origen), con lo que cambió y nada más. */
export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, updateAnnouncementPlan(id, raw), 'PATCH');
}
