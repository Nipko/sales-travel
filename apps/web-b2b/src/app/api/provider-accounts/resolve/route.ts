import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

interface ResolvedAccount {
  id: string;
  ownerTenantId: string;
  providerCode: string;
  label: string;
  inherited: boolean;
}

/**
 * Diagnóstico de herencia BYOC: de dónde saca este tenant las credenciales de un proveedor.
 * El API no devuelve el secreto, sólo el dueño y si vino heredada.
 *
 * El 404 del API significa una cosa muy concreta —"no resuelve NINGUNA cuenta activa para este
 * proveedor"— y es una respuesta legítima, no un fallo: se traduce a `{ resolved: null }` para
 * que el panel lo pinte como "sin credenciales" en vez de como un error de conexión. Cualquier
 * otro estado (403, 500, red caída) sí se propaga: confundirlo con "no hay cuenta" le diría al
 * operador que cargue credenciales que quizá ya tiene.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenantId') ?? '';
  const providerCode = url.searchParams.get('providerCode') ?? '';

  if (!tenantId || !providerCode) {
    return NextResponse.json({ error: 'tenantId y providerCode son requeridos' }, { status: 400 });
  }

  const res = await api<ResolvedAccount>(
    `/provider-accounts/resolve?tenantId=${encodeURIComponent(tenantId)}&providerCode=${encodeURIComponent(providerCode)}`,
  );

  if (!res.ok) {
    if (res.error.status === 404) return NextResponse.json({ resolved: null });
    return NextResponse.json({ error: res.error.message }, { status: res.error.status || 502 });
  }

  return NextResponse.json({ resolved: res.data });
}
