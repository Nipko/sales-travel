/**
 * Leer una respuesta que DEBERÍA ser JSON, sin reventar cuando no lo es.
 *
 * `await res.json()` sobre una respuesta que no es JSON lanza
 * `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. Ese error sube tal cual
 * hasta el `catch` de la pantalla y es lo que el vendedor acaba leyendo mientras intenta reservar:
 * un mensaje sobre el parser de JavaScript, que no dice qué pasó, ni si puede reintentar, ni si la
 * reserva se creó o no.
 *
 * Y no es un caso raro. Una respuesta no-JSON es lo NORMAL cuando el fallo ocurre antes de llegar
 * a la aplicación: la página de error de un proxy, un 502 del balanceador, un 504 de Cloudflare
 * cuando la llamada al proveedor tarda más que su límite. Justo los casos en los que el vendedor
 * más necesita entender qué hacer.
 */

export type JsonRead<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** ¿Esto es una página HTML y no datos? Basta el arranque; no hace falta parsear nada. */
function pareceHtml(body: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(body);
}

/**
 * Qué decirle al vendedor cuando lo que llegó no era JSON.
 *
 * El estado HTTP es lo único fiable que queda —el cuerpo ya demostró no ser nuestro— y cada
 * familia significa una acción distinta. Un mensaje único («error inesperado») los aplana todos y
 * deja al vendedor sin saber si reintentar o llamar por teléfono.
 */
export function describeNonJson(status: number, body: string): string {
  const html = pareceHtml(body);

  if (status === 504 || status === 524 || status === 408) {
    return 'La operación tardó más de lo permitido y se cortó antes de terminar. NO la repitas sin verificar antes en Mis Reservas: puede haberse creado igual.';
  }
  if (status === 502 || status === 503) {
    return 'El servidor no está respondiendo en este momento. Esperá unos segundos y probá de nuevo.';
  }
  if (status === 401 || status === 403) {
    return 'Tu sesión no es válida para esta operación. Volvé a iniciar sesión e intentá otra vez.';
  }
  if (status >= 500) {
    return `El servidor respondió con un error (${status}) y sin detalle. Ya quedó registrado; probá de nuevo en unos minutos.`;
  }
  if (html) {
    return `La respuesta del servidor no eran datos sino una página (${status}). Ya quedó registrado; probá de nuevo.`;
  }
  return `El servidor respondió de una forma que no pudimos interpretar (${status}).`;
}

/**
 * Lee el cuerpo UNA vez y decide.
 *
 * `res.text()` y no `res.json()` a propósito: el cuerpo de una respuesta sólo se puede consumir
 * una vez, así que si `json()` falla ya no queda nada que mirar para explicar por qué.
 */
export async function readJson<T>(res: Response): Promise<JsonRead<T>> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    return { ok: false, status: res.status, message: describeNonJson(res.status, '') };
  }

  try {
    return { ok: true, data: JSON.parse(body) as T };
  } catch {
    return { ok: false, status: res.status, message: describeNonJson(res.status, body) };
  }
}
