/**
 * Quién mira el panel, para decidir qué se le ofrece. Sin I/O.
 *
 * El superadmin cuadra la red pero no vende (modelo Planetour, 2026-09-28): Planetour vende por
 * sus sucursales, con usuarios de esas sucursales. La API lo impone en cada ruta de venta (403
 * `PLATFORM_ROLE_CANNOT_SELL`); la web no le muestra lo que no va a poder usar. Como en la API, el
 * superadmin es una identidad del USUARIO: basta una membership activa de plataforma en cualquier
 * nodo, aunque el tenant activo sea una sucursal donde además es vendedor.
 */

export interface MembershipLike {
  readonly role: string;
  readonly status: string;
}

/** Espejo de PLATFORM_ROLES del API (apps/api/src/auth/roles.ts). */
export const PLATFORM_ROLES: readonly string[] = ['superadmin', 'platform_admin'];

/** El texto del API para el 403 de venta, el mismo en la web. */
export const SUPERADMIN_CANNOT_SELL =
  'El superadministrador no vende: usá un usuario de una sucursal';

export interface Viewer {
  /** Tiene un rol de plataforma en algún nodo: no vende. */
  readonly platformUser: boolean;
  /** Es superadmin en algún nodo: arma la red (consolidadores y sucursales incluidos). */
  readonly superadmin: boolean;
}

export const ANONYMOUS_VIEWER: Viewer = { platformUser: false, superadmin: false };

function hasActive(memberships: readonly MembershipLike[], roles: readonly string[]): boolean {
  return memberships.some((m) => m.status === 'active' && roles.includes(m.role));
}

export function viewerOf(memberships: readonly MembershipLike[]): Viewer {
  return {
    platformUser: hasActive(memberships, PLATFORM_ROLES),
    superadmin: hasActive(memberships, ['superadmin']),
  };
}

export function canSell(viewer: Viewer): boolean {
  return !viewer.platformUser;
}

export type SalesArea = 'flights' | 'hotels' | 'cars' | 'packages';

/**
 * Las pantallas de venta, por prefijo de ruta. Buscar/Cotizar (con las cotizaciones guardadas y
 * su checkout), Hoteles (búsqueda, ficha con tarifas y checkout), Autos (búsqueda, reserva y el
 * buscador de oficinas, que sólo sirve para vender) y Paquetes.
 *
 * No son venta, y quedan: Mis Reservas (consultar y cancelar lo vendido; sus acciones de venta se
 * ocultan aparte) y Reporte autos (post-venta de lectura, como en la API).
 */
const SALES_ROUTES: readonly (readonly [prefix: string, area: SalesArea])[] = [
  ['/cotizaciones', 'flights'],
  ['/hoteles', 'hotels'],
  ['/autos/oficinas', 'cars'],
  ['/paquetes', 'packages'],
];

/** Rutas que son venta sólo en su forma exacta: debajo cuelgan pantallas que no lo son. */
const EXACT_SALES_ROUTES: readonly (readonly [path: string, area: SalesArea])[] = [
  ['/autos', 'cars'],
];

function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** El área de venta de una ruta, o `undefined` si no es una pantalla de venta. */
export function salesAreaOf(pathname: string): SalesArea | undefined {
  const path = normalize(pathname);
  const exact = EXACT_SALES_ROUTES.find(([p]) => p === path);
  if (exact !== undefined) return exact[1];
  const prefixed = SALES_ROUTES.find(([p]) => path === p || path.startsWith(`${p}/`));
  return prefixed?.[1];
}

export function isSalesPath(pathname: string): boolean {
  return salesAreaOf(pathname) !== undefined;
}

/** Los ítems de navegación que ve este usuario: sin las pantallas de venta si no vende. */
export function navForViewer<T extends { readonly href: string }>(
  items: readonly T[],
  viewer: Viewer,
): T[] {
  return canSell(viewer) ? [...items] : items.filter((item) => !isSalesPath(item.href));
}
