import type { NextResponse } from 'next/server';
import { createProfilePlan, profilesTarget } from '../../../../../lib/governance-proxy';
import { forwardPlan, forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/** Los perfiles de gobierno, con cuántos nodos usa cada uno. */
export async function GET(): Promise<NextResponse> {
  return forwardRead(profilesTarget());
}

/** Crea un perfil. Sólo desde el panel (mismo origen) y con el cuerpo rearmado. */
export async function POST(req: Request): Promise<NextResponse> {
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, createProfilePlan(raw), 'POST');
}
