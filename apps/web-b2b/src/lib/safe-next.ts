/**
 * El destino interno al que volver después del login (`/login?next=...`).
 *
 * `next` viene de la URL, así que lo controla cualquiera que mande un link: sin esto,
 * `/login?next=//evil.example` o `/login?next=https://evil.example` es un redirect abierto que
 * sale del panel después de que el usuario puso su contraseña, justo donde un phishing lo quiere.
 *
 * Sólo pasa una ruta del propio panel: empieza con una sola `/`, sin esquema, sin `\` (los
 * navegadores la leen como `/`, así que `/\evil.example` es `//evil.example`) y sin caracteres de
 * control (el navegador descarta tabs y saltos de línea, así que `/\t/evil.example` también lo es).
 * Además no puede volver a `/login` (bucle) ni a `/api/` (un route handler no es una pantalla). Todo
 * lo demás cae al inicio.
 */

export const SAFE_NEXT_FALLBACK = '/';

const MAX_NEXT_LENGTH = 2048;
const INTERNAL_ORIGIN = 'http://panel.invalid';

/** Rutas a las que no se vuelve nunca, comparadas sin distinguir mayúsculas. */
const EXCLUDED_PREFIXES = ['/login', '/api/'] as const;

function isExcluded(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return EXCLUDED_PREFIXES.some((prefix) =>
    prefix.endsWith('/')
      ? lower.startsWith(prefix) || lower === prefix.slice(0, -1)
      : lower === prefix || lower.startsWith(`${prefix}/`),
  );
}

/** ¿Tiene forma de ruta del panel? Sin mirar a dónde resuelve: eso lo decide el parser de URL. */
function looksInternal(value: string): boolean {
  if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- justamente se buscan los caracteres de control
  return !/[\u0000-\u001f\u007f]/.test(value);
}

export function safeNextPath(raw: unknown): string {
  // `searchParams` de Next puede traer el parámetro repetido: se toma el primero.
  const value = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (typeof value !== 'string' || !looksInternal(value)) return SAFE_NEXT_FALLBACK;

  // Segunda línea: que el parser de URL del navegador coincida en que no sale del panel, y usar
  // su forma normalizada (`/a/../login` es `/login`).
  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    return SAFE_NEXT_FALLBACK;
  }
  if (url.origin !== INTERNAL_ORIGIN) return SAFE_NEXT_FALLBACK;
  if (isExcluded(url.pathname)) return SAFE_NEXT_FALLBACK;

  // Lo que se devuelve es la forma normalizada, así que las reglas valen también para ella: los
  // segmentos de punto la cambian después de validar el texto crudo (`/.//evil.example` y
  // `/a/..//evil.example` quedan en `//evil.example`) y quien la usa la resuelve contra el origen
  // del panel, donde `//host` es otro sitio.
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  return looksInternal(normalized) ? normalized : SAFE_NEXT_FALLBACK;
}
