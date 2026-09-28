import { NextResponse } from 'next/server';
import { tenantProvidersPath } from '../../../../../../lib/provider-enablement-proxy';
import { readProviders } from '../../proxy';

/** Lo que ve un tenant de cada proveedor, y por qué. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  const { tenantId } = await params;
  const path = tenantProvidersPath(tenantId);
  if (path === undefined) {
    return NextResponse.json({ error: 'Tenant inválido.' }, { status: 400 });
  }
  return readProviders(path);
}
