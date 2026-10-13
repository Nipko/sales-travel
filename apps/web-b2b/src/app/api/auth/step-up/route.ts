import type { NextResponse } from 'next/server';
import { stepUpPlan } from '../../../../lib/step-up';
import { forwardPlan } from '../../../../lib/tenant-admin-proxy-route';

/**
 * Reconfirma el 2FA de la sesión antes de una acción de alto impacto (USR-13). Con chequeo de mismo
 * origen y el cuerpo reconstruido: sólo `{ code }` de 6 dígitos. Los errores vuelven con el estado y
 * el `reason` del API (400 código incorrecto, 429 demasiados intentos, 401 sesión cerrada).
 */
export async function POST(req: Request): Promise<NextResponse> {
  return forwardPlan(req, stepUpPlan(await req.json().catch(() => undefined)), 'POST');
}
