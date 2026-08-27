import { getActiveTenant, getSession } from './session';

const BASE = process.env.INTERNAL_API_URL ?? 'http://api:3000';

/** Lo que se responde cuando el API no se pudo alcanzar siquiera. */
export const SERVICIO_NO_DISPONIBLE = 503;

/**
 * Un estado que `NextResponse.json` acepta.
 *
 * Existe porque `ApiError.status` viaja SIN MIRAR a 48 rutas de `app/api/`, y ahí un valor fuera
 * de 200-599 no da un error legible sino una página HTML de Next que el cliente intenta parsear
 * como JSON. La garantía se da acá, una vez, en lugar de en cada ruta.
 */
export function estadoHttpValido(status: number): number {
  return Number.isInteger(status) && status >= 200 && status <= 599
    ? status
    : SERVICIO_NO_DISPONIBLE;
}

export interface ApiError {
  /** SIEMPRE un estado HTTP válido (200-599). Ver {@link estadoHttpValido}. */
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

  try {
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
      const apiError = { status: estadoHttpValido(res.status), message };
      console.error(`[API FETCH ERROR] PATH: ${path}, STATUS: ${res.status}, MESSAGE: ${message}`);
      return { ok: false, error: apiError };
    }

    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // El detalle técnico queda en el log; al usuario se le muestra un mensaje claro y accionable.
    console.error(`[API FETCH CONNECTION ERROR] PATH: ${path}, ERROR: ${message}`);
    return {
      ok: false,
      error: {
        // 503, NO 0. Un `status: 0` no es un estado HTTP, y las 48 rutas de `app/api/` lo
        // reenvían tal cual a `NextResponse.json(..., { status })`, que exige 200-599: lanzaba
        // `RangeError`, Next devolvía su página HTML de error y el navegador moría con
        // «Unexpected token '<', "<!DOCTYPE "... is not valid JSON» — un mensaje que no se
        // parece en nada a «no se pudo conectar», que es lo que realmente había pasado.
        status: SERVICIO_NO_DISPONIBLE,
        message: 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.',
      },
    };
  }
}
