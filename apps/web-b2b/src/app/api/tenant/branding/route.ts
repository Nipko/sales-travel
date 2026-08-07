import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';

const EMPTY = {
  logoUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
  commercialName: null,
  supportEmail: null,
  supportPhone: null,
  websiteUrl: null,
};

/**
 * Branding PROPIO del tenant, sin heredar.
 *
 * Esta ruta alimenta el formulario de configuración, así que tiene que devolver lo que
 * el tenant configuró él mismo. Si devolviera el branding efectivo (con los valores
 * heredados del consolidador ya resueltos), al guardar el formulario los persistiría
 * como propios y la agencia dejaría de heredar sin haberlo pedido.
 *
 * El branding EFECTIVO —el que se pinta— lo pide el layout con /tenants/:id/branding.
 */
export async function GET() {
  const tenantId = await getActiveTenant();
  if (!tenantId) return NextResponse.json(EMPTY);

  const res = await api<unknown>(`/tenants/${tenantId}/branding/own`);
  if (!res.ok) {
    return NextResponse.json(EMPTY, { status: res.error.status });
  }

  return NextResponse.json(res.data);
}

export async function PATCH(req: Request) {
  const tenantId = await getActiveTenant();
  if (!tenantId) {
    return NextResponse.json({ error: 'No tenant' }, { status: 400 });
  }

  const body = await req.text();
  const res = await api<unknown>(`/tenants/${tenantId}/branding`, {
    method: 'PATCH',
    body,
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }

  return NextResponse.json(res.data);
}
