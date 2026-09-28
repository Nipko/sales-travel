import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';
import {
  enablementProxyPlan,
  type EnablementProxyTarget,
} from '../../../../lib/provider-enablement-proxy';

/**
 * Proxy de la habilitación de proveedores (`/admin/providers` del API), compartido por sus rutas.
 *
 * Valida lo que arma la URL del API —el código del proveedor y el tenant— y reconstruye el cuerpo
 * campo por campo antes de reenviar. Quién puede hacerlo (sólo superadmin) lo decide el API: acá no
 * se autoriza nada, sólo se evita que un segmento raro componga otra ruta del API.
 */

export async function readProviders(path: string): Promise<NextResponse> {
  const res = await api<unknown>(path);
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}

export async function writeEnablement(
  req: Request,
  method: 'PUT' | 'DELETE',
  target: EnablementProxyTarget,
): Promise<NextResponse> {
  const body = method === 'PUT' ? await req.json().catch(() => undefined) : undefined;
  const plan = enablementProxyPlan(method, target, body);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const res = await api<unknown>(plan.path, {
    method,
    ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
