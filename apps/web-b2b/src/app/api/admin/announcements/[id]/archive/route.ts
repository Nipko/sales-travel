import type { NextResponse } from 'next/server';
import { archiveAnnouncementTarget } from '../../../../../../lib/announcements';
import { forwardAction } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Archivar un anuncio: deja de mostrarse en el acto. Sólo desde el panel (mismo origen). */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  return forwardAction(req, archiveAnnouncementTarget(id));
}
