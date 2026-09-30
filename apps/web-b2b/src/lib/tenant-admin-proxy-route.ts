import { NextResponse } from 'next/server';
import { isSameOriginRequest } from '../app/api/session/_lib/session-routes';
import { apiWithStatus } from './api';
import {
  currentSessionIdOf,
  markCurrentSession,
  seatsViewTarget,
  tenantAdminProxyReply,
  type TenantAdminProxyPlan,
  type TenantAdminProxyTarget,
} from './tenant-admin-proxy';

/**
 * Lo común de las rutas proxy de puestos y de soporte a miembros: reenviar lo que decidió el plan
 * (lib/tenant-admin-proxy.ts) y devolver `{ error, reason? }` en los errores, con el estado del API.
 * Se usa `apiWithStatus` y no `api` porque el 403 de una acción sobre un miembro trae el motivo
 * que la pantalla tiene que mostrar.
 */

function reply(res: Awaited<ReturnType<typeof apiWithStatus>>): NextResponse {
  const out = tenantAdminProxyReply(res);
  return NextResponse.json(out.body, { status: out.status });
}

/**
 * Estas rutas hacen lo más sensible del panel (restablecer el 2FA de alguien, cerrar sus sesiones,
 * liberar puestos, cambiar el cupo) con la cookie de quien las llama. Los route handlers no tienen
 * el chequeo de origen de los server actions y `SameSite=Lax` no frena a un subdominio hermano, así
 * que una página de otro host del dominio podría dispararlas con la sesión de un admin.
 */
function crossOrigin(req: Request): NextResponse | null {
  return isSameOriginRequest(req.headers)
    ? null
    : NextResponse.json(
        { error: 'No pudimos confirmar que el pedido venga del panel. Recargá la página.' },
        { status: 403 },
      );
}

/** Una acción sin cuerpo (POST) sobre la ruta del plan. */
export async function forwardAction(
  req: Request,
  target: TenantAdminProxyTarget,
): Promise<NextResponse> {
  const rejected = crossOrigin(req);
  if (rejected) return rejected;
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });
  return reply(await apiWithStatus(target.path, { method: 'POST' }));
}

/** Un cambio con cuerpo ya reconstruido campo por campo. */
export async function forwardPlan(
  req: Request,
  plan: TenantAdminProxyPlan,
  method: 'PATCH' | 'POST',
): Promise<NextResponse> {
  const rejected = crossOrigin(req);
  if (rejected) return rejected;
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });
  return reply(await apiWithStatus(plan.path, { method, body: JSON.stringify(plan.body) }));
}

/**
 * La vista de puestos, con la sesión de quien mira marcada como `current`. Las dos lecturas van en
 * paralelo; si la de la sesión falla, la vista sale igual, sin marca (el API rechaza liberarse a
 * uno mismo de todos modos).
 */
export async function forwardSeatsView(tenantId: string): Promise<NextResponse> {
  const target = seatsViewTarget(tenantId);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });
  const [seats, session] = await Promise.all([
    apiWithStatus(target.path),
    apiWithStatus('/auth/session'),
  ]);
  const out = tenantAdminProxyReply(seats);
  const body =
    out.status < 400 ? markCurrentSession(out.body, currentSessionIdOf(session)) : out.body;
  return NextResponse.json(body, { status: out.status });
}
