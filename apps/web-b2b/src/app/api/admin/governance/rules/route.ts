import type { NextResponse } from 'next/server';
import { globalRulesTarget, setRulePlan } from '../../../../../lib/governance-proxy';
import { forwardPlan, forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/** Las reglas globales: las que valen para toda la plataforma. */
export async function GET(): Promise<NextResponse> {
  return forwardRead(globalRulesTarget());
}

/** Fija o quita una regla a mano, global (`tenantId: null`) o de un nodo. */
export async function PUT(req: Request): Promise<NextResponse> {
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, setRulePlan(raw), 'PUT');
}
