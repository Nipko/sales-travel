import type { NextResponse } from 'next/server';
import { killSwitchClearPlan } from '../../../../../../../lib/provider-enablement-proxy';
import { forwardPlan } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ code: string }> };

/**
 * Levanta el apagado de emergencia puesto desde el panel. El de la variable PROVIDERS_DISABLED no se
 * levanta desde aquí: el API responde 409 `KILL_SWITCH_FROM_ENV` y el panel lo muestra tal cual.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { code } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, killSwitchClearPlan(code, raw), 'POST');
}
