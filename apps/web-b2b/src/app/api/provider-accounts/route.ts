import { NextResponse } from 'next/server';
import { api, apiWithStatus } from '../../../lib/api';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenantId') ?? '';
  const res = await api<unknown>(`/provider-accounts?tenantId=${encodeURIComponent(tenantId)}`);
  if (!res.ok) {
    return NextResponse.json({ accounts: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}

const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(body: Record<string, unknown>): string | undefined {
  const m = body['message'];
  if (typeof m === 'string' && m.length > 0) return m;
  if (Array.isArray(m)) {
    const joined = m.filter((x): x is string => typeof x === 'string').join(', ');
    return joined || undefined;
  }
  return undefined;
}

/**
 * El error como lo lee el panel (`{ error }`), más el motivo máquina y el conteo de reservas
 * activas del 409 `PROVIDER_ACCOUNT_IN_USE` (RF-29 CA 2): sin ellos, "la cuenta tiene reservas
 * vivas" llegaba como un error cualquiera. Sólo esos dos campos: el resto del cuerpo no se reenvía.
 */
function errorBody(body: unknown, fallback: string): Record<string, unknown> {
  const b = isRecord(body) ? body : {};
  const reason =
    typeof b['reason'] === 'string' && MACHINE_REASON.test(b['reason']) ? b['reason'] : undefined;
  const details = isRecord(b['details']) ? b['details'] : undefined;
  const active = details?.['activeOrders'];
  return {
    error: messageOf(b) ?? fallback,
    ...(reason === undefined ? {} : { reason }),
    ...(typeof active === 'number' || active === null ? { details: { activeOrders: active } } : {}),
  };
}

export async function POST(req: Request) {
  const body = (await req.json()) as unknown;
  const res = await apiWithStatus('/provider-accounts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.kind !== 'json') {
    return NextResponse.json({ error: res.message }, { status: res.status });
  }
  if (res.status < 200 || res.status >= 300) {
    return NextResponse.json(errorBody(res.body, 'Error al guardar credenciales'), {
      status: res.status,
    });
  }
  return NextResponse.json(res.body);
}
