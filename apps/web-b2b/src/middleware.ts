import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get('st_session')?.value;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
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
