import { NextResponse, type NextRequest } from 'next/server';
import {
  isTokenExpired,
  loginUrlFor,
  requestedPathOf,
  tokenTenantId,
} from './app/login/login-redirect';
import { SAFE_NEXT_FALLBACK, safeNextPath } from './lib/safe-next';
import {
  COOKIES_CLEARED_ON_LOGOUT,
  REQUESTED_PATH_HEADER,
  SESSION_COOKIE,
  TENANT_COOKIE,
  tenantCookieOptions,
} from './lib/session-cookies';

/**
 * Puertas de entrada: si ya hay sesión no tiene sentido mostrarlas, se manda al panel.
 */
const AUTH_ENTRY_PATHS = ['/login', '/register'];

/**
 * Públicas SIEMPRE, incluso con sesión abierta.
 *
 * La diferencia con las de arriba importa: quien llega con un enlace de restablecer, de
 * invitación o de verificación tiene que poder usarlo aunque ya esté logueado en otra
 * cuenta o en la misma. Antes `/verificar` no estaba acá y el enlace del correo mandaba a
 * /login a cualquiera sin sesión, dejando la verificación de email inalcanzable.
 */
const ALWAYS_PUBLIC_PATHS = ['/olvide-password', '/restablecer', '/invitacion', '/verificar'];

/** `/login` y `/login/...`, pero no `/login-ayuda`. */
function isUnder(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function clearSessionCookies(res: NextResponse): NextResponse {
  for (const name of COOKIES_CLEARED_ON_LOGOUT) res.cookies.delete(name);
  return res;
}

/**
 * El destino de `?next=` ya resuelto contra el panel. `safeNextPath` sólo devuelve rutas internas;
 * esto es la segunda llave por si alguna vez deja pasar una que el navegador resuelve a otro sitio
 * (`//host`): un redirect abierto acá lo ve alguien que ya tiene sesión, el blanco ideal.
 */
function nextTarget(req: NextRequest): URL {
  const base = new URL(req.url);
  const target = new URL(safeNextPath(req.nextUrl.searchParams.get('next')), base);
  return target.origin === base.origin ? target : new URL(SAFE_NEXT_FALLBACK, base);
}

/**
 * `st_tenant` sigue al `tid` de la sesión: es lo que viaja como `x-tenant-id`, y el cupo de puestos y
 * el rol se cuentan por la sesión. Si se despegan, el panel muestra una agencia y la API opera con
 * otra (descarta un `x-tenant-id` de otro cupo y usa el `tid`, ver SessionService.validate). Pasaba con una
 * cookie vieja o sin cookie, cuando el layout elegía por su cuenta la primera membership.
 *
 * Devuelve el `tid` si la cookie hay que corregirla, o `null`.
 */
function staleTenantCookie(req: NextRequest, token: string): string | null {
  const tid = tokenTenantId(token);
  return tid && req.cookies.get(TENANT_COOKIE)?.value !== tid ? tid : null;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value || null;
  // Un token vencido es lo mismo que no tener sesión. Pasa con las cookies de antes de alinear su
  // duración con la del token (duraban 7 días con un token de 12 h) y con un reloj algo corrido:
  // sin esto el panel se abría vacío y /login devolvía al panel, sin salida.
  const expired = token !== null && isTokenExpired(token, Date.now());
  const hasSession = token !== null && !expired;

  if (isUnder(pathname, ALWAYS_PUBLIC_PATHS)) {
    return NextResponse.next();
  }

  if (isUnder(pathname, AUTH_ENTRY_PATHS)) {
    // Con sesión, al destino que traía el link (validado: `next` lo arma cualquiera).
    if (hasSession) return NextResponse.redirect(nextTarget(req));
    const res = NextResponse.next();
    return expired ? clearSessionCookies(res) : res;
  }

  if (!hasSession) {
    const res = NextResponse.redirect(
      loginUrlFor(new URL(req.url), { motivo: expired ? 'expirada' : null }),
    );
    return expired ? clearSessionCookies(res) : res;
  }

  // La cookie de tenant se corrige en el pedido (antes de copiar sus cabeceras, así la ve el render
  // de este mismo pedido) y en la respuesta.
  const tid = staleTenantCookie(req, token);
  if (tid) req.cookies.set(TENANT_COOKIE, tid);

  // Siempre se pisa: un valor que mande el navegador no llega al layout.
  const headers = new Headers(req.headers);
  headers.set(REQUESTED_PATH_HEADER, requestedPathOf(req.nextUrl));
  const res = NextResponse.next({ request: { headers } });
  if (tid) {
    res.cookies.set(TENANT_COOKIE, tid, tenantCookieOptions(process.env.NODE_ENV === 'production'));
  }
  return res;
}

export const config = {
  matcher: [
    '/((?!_next/|api/|data/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|webp|gif|ico|txt|json|css|js|woff2?)$).*)',
  ],
};
