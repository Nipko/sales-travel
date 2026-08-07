import { NextResponse, type NextRequest } from 'next/server';

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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get('st_session')?.value;

  if (ALWAYS_PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (AUTH_ENTRY_PATHS.some((p) => pathname.startsWith(p))) {
    if (token) return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }

  if (!token) {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/|api/|data/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|webp|gif|ico|txt|json|css|js|woff2?)$).*)',
  ],
};
