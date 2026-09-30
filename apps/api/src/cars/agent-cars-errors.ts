/**
 * Traduce el cuerpo de error crudo de AgentCars a un mensaje claro en español para el usuario.
 * AgentCars suele responder { "error": "Error Loading data: {\"campo\":[\"mensaje\"]}" } o texto plano.
 */

/**
 * Operaciones que viven de la sesión que abre la selección (`uniqid`, TTL 15 min). Sólo en ellas
 * "no encontrado" o "vencido" quiere decir que la sesión expiró: en la búsqueda todavía no existe.
 */
const SESSION_PATHS: ReadonlySet<string> = new Set(['/get-rate-information', '/confirmation']);

/** Operaciones sobre una reserva ya hecha, que se buscan por apellido + código. */
const RESERVATION_PATHS: ReadonlySet<string> = new Set([
  '/my-reservation',
  '/cancel',
  '/release-reservation',
]);

/** Operaciones de búsqueda: "vacío" o "no encontrado" acá es falta de disponibilidad. */
const SEARCH_PATHS: ReadonlySet<string> = new Set(['/get-matrix', '/get-selection']);

function isHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html)/i.test(body);
}

/** El texto de un elemento de la página de error HTML (Yii pone el título en <title> y el motivo en <h2>). */
function htmlText(body: string, tag: 'title' | 'h1' | 'h2'): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  return (match?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * La ruta pedida no existe en AgentCars: contesta su página HTML de 404 ("Page not found."), no un
 * JSON. Pasa cuando la URL base de la cuenta no es la raíz de la API (`…/v2/sites`). Un 404 del
 * propio API (una reserva que no está, por ejemplo) viene en JSON y no entra acá.
 */
export function isMissingRoute(status: number, body: string): boolean {
  return status === 404 && (isHtml(body) || /page not found/i.test(body));
}

/**
 * Resumen del cuerpo para el log: de una página HTML, su título y su motivo; de lo demás, las
 * primeras líneas en una sola. Sin esto cada error dejaba 250 caracteres de estilos CSS en el log
 * y el motivo real quedaba afuera.
 */
export function summarizeAgentCarsBody(body: string, max = 250): string {
  if (isHtml(body)) {
    const title = htmlText(body, 'title') || htmlText(body, 'h1');
    const reason = htmlText(body, 'h2');
    return `HTML «${title || 'sin título'}»${reason ? ` ${reason}` : ''}`.slice(0, max);
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Extrae el mensaje legible del body (desanida el JSON de validación si existe). */
function extractMessage(body: string): string {
  const raw = body.trim();
  let msg = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['error'] === 'string') msg = parsed['error'];
    else if (typeof parsed['message'] === 'string') msg = parsed['message'];
  } catch {
    // body no es JSON: se usa tal cual.
  }
  // El error a veces embebe un JSON de validación por campo: 'Error Loading data: {"source":["..."]}'.
  const nested = msg.match(/\{[\s\S]*\}/);
  if (nested) {
    try {
      const fields = JSON.parse(nested[0]) as Record<string, unknown>;
      const messages = Object.values(fields)
        .flat()
        .filter((v): v is string => typeof v === 'string');
      if (messages.length > 0) return messages.join(' ');
    } catch {
      // no era un JSON de campos: se ignora.
    }
  }
  return msg;
}

/**
 * Mapea un error de AgentCars (status + body) a un mensaje accionable para el agente. `path` es la
 * operación (`/get-matrix`, `/confirmation`…): el mismo "not found" dice cosas distintas en una
 * búsqueda, en una reserva y en una confirmación.
 */
export function humanizeAgentCarsError(status: number, body: string, path?: string): string {
  // Error de red / proveedor caído (status 0 = fetch falló; 5xx = error del proveedor).
  if (status === 0) {
    return 'No pudimos conectar con AgentCars. Prueba de nuevo en unos segundos.';
  }
  if (status >= 500) {
    return 'AgentCars tuvo un problema interno. Prueba de nuevo en unos minutos.';
  }

  // Configuración: la URL base no es la raíz de la API y AgentCars no conoce la ruta.
  if (isMissingRoute(status, body)) {
    return 'La dirección configurada para AgentCars no existe (404). Revisa la URL base en Mi Red → Credenciales → AgentCars (o la variable AGENT_CARS_BASE_URL): déjala vacía o usa la raíz de la API, que termina en /v2/sites.';
  }

  const detail = extractMessage(body);
  const m = detail.toLowerCase();
  const op = path ?? '';

  // Configuración: país de origen (POS) sin definir.
  if (m.includes('source country') || (m.includes('source') && m.includes('blank'))) {
    return 'Falta el país de origen (POS) en la configuración de AgentCars. Carga "País origen / POS" en Mi Red → Credenciales → AgentCars (o la variable AGENT_CARS_SOURCE).';
  }

  // Credenciales / token.
  if (
    status === 401 ||
    status === 403 ||
    m.includes('unauthorized') ||
    m.includes('invalid credentials') ||
    m.includes('access token') ||
    m.includes('access-token') ||
    (m.includes('token') && (m.includes('invalid') || m.includes('blank')))
  ) {
    return 'Las credenciales de AgentCars son inválidas o faltan. Verifica el Access Token en Mi Red → Credenciales → AgentCars.';
  }

  const notFound = status === 404 || m.includes('not found') || m.includes('no encontr');

  // Reserva existente que no aparece: es el apellido o el código, no una sesión.
  if (RESERVATION_PATHS.has(op) && notFound) {
    return 'No encontramos esa reserva en AgentCars. Revisa el apellido del conductor y el código de confirmación.';
  }

  // Sesión expirada (uniqid tiene TTL de 15 min).
  if (
    m.includes('uniqid') ||
    m.includes('session') ||
    m.includes('expir') ||
    m.includes('vencid') ||
    status === 410 ||
    (SESSION_PATHS.has(op) && notFound)
  ) {
    return 'La sesión de la tarifa expiró (es válida 15 minutos). Vuelve a buscar y selecciona el auto de nuevo.';
  }

  const empty =
    m.includes('empty response') ||
    m.includes('carservice') ||
    m.includes('respuesta vacía') ||
    detail.trim() === '';

  // En la búsqueda, vacío o "no encontrado" es que no hay autos para esos datos.
  if (SEARCH_PATHS.has(op) && (empty || notFound)) {
    return op === '/get-matrix'
      ? 'AgentCars no devolvió autos para esta búsqueda. Prueba con otras fechas, otro horario u otro lugar de recogida.'
      : 'Ese auto ya no está disponible con esa tarifa. Vuelve a buscar para ver opciones actualizadas.';
  }

  // Respuesta vacía del servicio de autos del proveedor: el rental no devolvió datos. Suele pasar
  // cuando la tarifa/sesión (uniqid, TTL 15 min) venció entre la selección y la confirmación, o el
  // auto dejó de estar disponible.
  if (empty) {
    return 'AgentCars no devolvió disponibilidad para esta operación. La tarifa pudo expirar (válida 15 min): vuelve a buscar y selecciona el auto de nuevo.';
  }

  // Tarifa / disponibilidad ya no vigente.
  if (
    m.includes('rate') ||
    m.includes('tarifa') ||
    m.includes('availab') ||
    m.includes('disponib')
  ) {
    return 'La tarifa o el auto seleccionado ya no está disponible. Vuelve a buscar para ver opciones actualizadas.';
  }

  // Fallback: mostramos el detalle del proveedor si es corto y legible, si no, genérico.
  if (detail && detail.length <= 160 && !isHtml(detail)) {
    return `AgentCars rechazó la operación: ${detail}`;
  }
  return 'AgentCars no pudo procesar la solicitud. Revisa los datos e intenta de nuevo.';
}
