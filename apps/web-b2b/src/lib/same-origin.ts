/**
 * Chequeo de origen de las acciones del panel, sin dependencias: lo usan el middleware (edge) y los
 * route handlers. Ver `middleware.ts` (QA-H-03 de docs/qa/01).
 */

/** Lo que se lee de las cabeceras del request (`Headers` alcanza). */
export interface OriginHeaders {
  get(name: string): string | null;
}

/**
 * ¿El POST viene de una página del propio panel?
 *
 * Los route handlers no tienen el chequeo de origen que Next les pone a los server actions, y la
 * cookie `SameSite=Lax` no frena a un subdominio hermano (same-site). `Sec-Fetch-Site` lo mandan
 * todos los navegadores actuales y el sitio no lo puede falsificar; si falta (navegador viejo), se
 * compara `Origin` con el host. Sin ninguno de los dos no es un navegador, y sin navegador no hay
 * cookie de la víctima que aprovechar.
 */
export function isSameOriginRequest(headers: OriginHeaders): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';

  const origin = headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [headers.get('x-forwarded-host'), headers.get('host')].filter(
    (h): h is string => typeof h === 'string' && h.length > 0,
  );
  return hosts.some((h) => h.split(',')[0]?.trim().toLowerCase() === originHost.toLowerCase());
}
