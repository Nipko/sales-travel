/**
 * Cómo se ve un error de AgentCars cuando NO viene con un código HTTP de error.
 *
 * Según la guía v2.0 (changelog del 2026-09-28, despliegue desde el 2026-10-13), los servicios de
 * búsqueda —getMatrix, getSelection, rateInformation— responden los errores controlados con
 * `{ success: false, error, message, code, data }`: "sin tarifas" con HTTP 200 y code 13000, y
 * parámetros inválidos con HTTP 422 y code 13001. Hasta entonces, getMatrix contesta con HTTP 200
 * `{"error": {"campo": ["mensaje"]}}` o `{"error": "Invalid Country"}`, y "sin tarifas" es un 412. Los
 * demás servicios siguen con `{"error": "..."}`. Un 2xx con esa forma tiene que tratarse como error:
 * leído como datos, la matriz inventaba un auto vacío y la cancelación se daba por hecha.
 */

/** "Sin tarifas disponibles": un resultado de negocio, no un fallo. */
export const NO_RATES_CODE = 13000;
/** Parámetros de búsqueda inválidos o faltantes. */
export const INVALID_SEARCH_CODE = 13001;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** ¿El cuerpo ya parseado es un error, venga con el código HTTP que venga? */
export function isErrorBody(parsed: unknown): boolean {
  const body = asRecord(parsed);
  if (!body) return false;
  if (body['success'] === false) return true;
  const error = body['error'];
  if (typeof error === 'string') return error.trim() !== '';
  const nested = asRecord(error);
  return nested !== undefined && Object.keys(nested).length > 0;
}

/**
 * ¿Es "no hay tarifas para esa búsqueda"? Con el formato nuevo lo dice el `code` (13000, HTTP 200);
 * con el anterior, el texto de un 412 ("We don't have rates avaliable for the selected location…",
 * con esa errata).
 */
export function isNoRates(status: number, text: string): boolean {
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(text));
  } catch {
    return false;
  }
  if (!body) return false;
  if (Number(body['code']) === NO_RATES_CODE) return true;
  const message = [body['error'], body['message']].filter((v) => typeof v === 'string').join(' ');
  return (status === 412 || status === 200) && /don'?t have rates/i.test(message);
}
