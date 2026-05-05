import { getActiveTenant, getSession } from './session';

const BASE = process.env.INTERNAL_API_URL ?? 'http://api:3000';

export interface ApiError {
  status: number;
  message: string;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const token = await getSession();
  const tenantId = await getActiveTenant();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (tenantId) headers.set('x-tenant-id', tenantId);

  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join(', ');
      else if (body.message) message = body.message;
    } catch {
      // ignore parse error, fall back to statusText
    }
    return { ok: false, error: { status: res.status, message } };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
}
