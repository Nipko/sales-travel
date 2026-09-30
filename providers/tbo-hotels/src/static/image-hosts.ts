/**
 * De qué hosts sirve TBO las fotos de sus hoteles (docs/tbo/05 §4 y §10).
 *
 * HotelDetails devuelve `Images` como URLs absolutas de `imageresource.aspx` en el host de su API
 * (`https://api.tbotechnology.in/imageresource.aspx?img=…`, observado en producción). El contrato no
 * documenta host, licencia ni caducidad (Q-67), así que se admiten los dominios de TBO y sus
 * subdominios, no un host exacto: un cambio de CDN dentro de TBO no deja los resultados sin fotos, y
 * uno fuera de TBO sí se nota (la foto no sale y el log del proxy lo dice).
 *
 * Lo usa quien sirve las fotos por un proxy propio: sólo sale a buscar URLs de estos dominios, por
 * `https`, sin usuario ni puerto propio. Nunca se le manda la credencial de TBO: la foto es un
 * recurso público y el proxy no la firma.
 */
export const TBO_IMAGE_HOST_SUFFIXES = Object.freeze(['tbotechnology.in', 'tboholidays.com']);

/** Tope de largo de una URL de foto: las de TBO rondan los 150 caracteres. */
export const TBO_IMAGE_URL_MAX_LENGTH = 1_024;

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TBO_IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * La URL de una foto de TBO, normalizada por `URL`, o `undefined` si no es una: `https`, en un
 * dominio de TBO, sin credenciales embebidas ni puerto propio, y de un largo razonable.
 */
export function tboImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > TBO_IMAGE_URL_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  if (!hostAllowed(url.hostname)) return undefined;
  return url.href;
}

export function isTboImageUrl(value: unknown): boolean {
  return tboImageUrl(value) !== undefined;
}
