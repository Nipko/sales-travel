import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';
import { DISCLOSURE_HIDDEN } from '../../../../lib/provider-disclosure';

/**
 * Proxy del ajuste "mostrar de qué proveedor es cada oferta" para el panel de proveedores.
 *
 * El `tenantId` viaja explícito, como en `/api/provider-accounts`: el panel administra
 * cualquier nodo de la red, no sólo el tenant activo de la sesión. Quién puede tocar qué
 * nodo lo decide el API contra la jerarquía; acá no se autoriza nada.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const tenantId = new URL(req.url).searchParams.get('tenantId') ?? '';
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId es requerido' }, { status: 400 });
  }

  const res = await api<unknown>(`/provider-disclosure?tenantId=${encodeURIComponent(tenantId)}`);

  if (!res.ok) {
    // Se responde 200 con el ajuste OCULTO y `error` al lado: el panel tiene que poder
    // pintarse igual, y la dirección segura por defecto es no mostrar el proveedor. El
    // error va en el cuerpo para que la pantalla pueda decir que no pudo leerlo, en vez de
    // afirmar que está oculto por decisión de alguien.
    return NextResponse.json({ ...DISCLOSURE_HIDDEN, error: res.error.message }, { status: 200 });
  }

  return NextResponse.json(res.data);
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const body = await req.text();
  const res = await api<unknown>('/provider-disclosure', { method: 'PATCH', body });

  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status || 502 });
  }

  return NextResponse.json(res.data);
}
