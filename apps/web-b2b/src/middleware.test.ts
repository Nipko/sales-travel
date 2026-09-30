import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from './middleware';

const ORIGIN = 'https://panel.planetour.cloud';

function jwtExpiringIn(seconds: number): string {
  const b64url = (value: string) =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ sub: 'u', exp }))}.firma`;
}

function request(path: string, session?: string, extra: Record<string, string> = {}): NextRequest {
  const headers = new Headers(extra);
  if (session !== undefined) headers.set('cookie', `st_session=${session}; st_tenant=t-1`);
  return new NextRequest(new URL(path, ORIGIN), { headers });
}

/** El header que el middleware agrega al request que sigue hacia la página (`NextResponse.next`). */
function forwardedPath(res: Response): string | null {
  return res.headers.get('x-middleware-request-x-st-path');
}

function location(res: Response): URL | null {
  const value = res.headers.get('location');
  return value ? new URL(value) : null;
}

/** Los Set-Cookie que borran una cookie (Max-Age=0 o Expires en el pasado). */
function deletedCookies(res: Response): string[] {
  const all = res.headers.get('set-cookie') ?? '';
  return all
    .split(/,(?=\s*st_)/)
    .filter((c) => /max-age=0|expires=thu, 01 jan 1970/i.test(c))
    .map((c) => c.trim().split('=')[0] ?? '');
}

describe('middleware: sin sesión', () => {
  it('manda al login guardando a dónde iba', () => {
    const res = middleware(request('/reservas/123?tab=pagos'));
    const to = location(res);
    expect(to?.pathname).toBe('/login');
    expect(to?.searchParams.get('next')).toBe('/reservas/123?tab=pagos');
    expect(to?.searchParams.has('motivo')).toBe(false);
  });

  it('desde el inicio, sin next', () => {
    expect(location(middleware(request('/')))?.search).toBe('');
  });

  it('el login y las públicas se muestran', () => {
    for (const path of [
      '/login',
      '/login?next=/hoteles',
      '/olvide-password',
      '/verificar?token=x',
    ]) {
      expect(location(middleware(request(path)))).toBeNull();
    }
  });

  it('/login-algo no es el login: sigue protegida', () => {
    expect(location(middleware(request('/login-ayuda')))?.pathname).toBe('/login');
  });
});

describe('middleware: con sesión', () => {
  const live = jwtExpiringIn(3600);

  it('deja pasar al panel', () => {
    expect(location(middleware(request('/reservas', live)))).toBeNull();
  });

  it('desde el login, al destino que traía el link', () => {
    expect(location(middleware(request('/login?next=%2Fcotizaciones%2F9', live)))?.pathname).toBe(
      '/cotizaciones/9',
    );
  });

  it('un next externo cae al inicio', () => {
    const to = location(middleware(request('/login?next=%2F%2Fevil.example', live)));
    expect(to?.origin).toBe(ORIGIN);
    expect(to?.pathname).toBe('/');
  });

  // El phishing de "tu sesión venció, ingresá de nuevo": con los puntos, el texto crudo pasaba por
  // ruta interna y la forma normalizada (`//evil.example`) mandaba a otro sitio.
  it.each(['/.//evil.example', '/%2e//evil.example', '/a/..//evil.example'])(
    'un next que al normalizarse sale del panel cae al inicio: %s',
    (next) => {
      const res = middleware(request(`/login?next=${encodeURIComponent(next)}`, live));
      const to = location(res);
      expect(to?.origin).toBe(ORIGIN);
      expect(to?.pathname).toBe('/');
    },
  );

  it('un token opaco (no JWT) se da por vivo: decide la API', () => {
    expect(location(middleware(request('/reservas', 'opaco')))).toBeNull();
  });

  // La cookie puede seguir viva con la sesión ya cerrada en la API (inactividad, otro dispositivo):
  // el que se entera es el layout, y necesita saber a qué pantalla volver después del login.
  it('le pasa al layout la pantalla pedida, sin el _rsc de Next', () => {
    const res = middleware(request('/reservas/123?tab=pagos&_rsc=abc', live));
    expect(location(res)).toBeNull();
    expect(forwardedPath(res)).toBe('/reservas/123?tab=pagos');
  });

  it('pisa el header si lo manda el navegador', () => {
    const res = middleware(request('/hoteles', live, { 'x-st-path': '//evil.example' }));
    expect(forwardedPath(res)).toBe('/hoteles');
  });
});

describe('middleware: token vencido', () => {
  const expired = jwtExpiringIn(-60);

  it('en el panel: al login con motivo, destino y cookies borradas', () => {
    const res = middleware(request('/hoteles?q=1', expired));
    const to = location(res);
    expect(to?.pathname).toBe('/login');
    expect(to?.searchParams.get('motivo')).toBe('expirada');
    expect(to?.searchParams.get('next')).toBe('/hoteles?q=1');
    expect(deletedCookies(res).sort()).toEqual(['st_session', 'st_tenant']);
  });

  it('en el login: se muestra (antes devolvía al panel vacío) y limpia las cookies', () => {
    const res = middleware(request('/login', expired));
    expect(location(res)).toBeNull();
    expect(deletedCookies(res).sort()).toEqual(['st_session', 'st_tenant']);
  });
});
