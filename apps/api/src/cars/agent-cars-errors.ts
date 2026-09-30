import { NO_RATES_CODE, INVALID_SEARCH_CODE } from '@sales-travel/agent-cars';

/**
 * Traduce el cuerpo de error crudo de AgentCars a un mensaje claro en español para el usuario.
 * AgentCars responde { "error": "Error Loading data: {\"campo\":[\"mensaje\"]}" }, texto plano o, en
 * los servicios de búsqueda desde el 2026-10-13, { success: false, error, message, code, data }.
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

const URL_HINT =
  'Revisa la URL base en Mi Red → Credenciales → AgentCars (o la variable AGENT_CARS_BASE_URL): pruebas es https://api.dev.agentcars.com/v2/sites y producción https://api.agentcars.com/v2/sites.';

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

/** Los mensajes de un objeto de validación por campo: { "campo": ["mensaje", …] }. */
function fieldMessages(v: unknown): string[] {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.values(v as Record<string, unknown>)
    .flat()
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '');
}

interface ErrorDetail {
  /** El mensaje legible: el de cada campo si los hay, si no el del error. */
  readonly text: string;
  /** Código de aplicación del formato nuevo (13000, 13001), si vino. */
  readonly code?: number;
  /** El texto salió de una validación por campo: son los datos pedidos los que están mal. */
  readonly fromFields?: boolean;
}

/** Lo que dice el cuerpo: el mensaje (desanidando la validación por campo) y el código, si hay. */
function describe(body: string): ErrorDetail {
  const raw = body.trim();
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // body no es JSON: se usa tal cual.
  }
  if (!parsed) return { text: raw };

  const codeValue = Number(parsed['code']);
  const code = Number.isFinite(codeValue) && codeValue > 0 ? codeValue : undefined;
  const withCode = (text: string, fromFields = false): ErrorDetail => ({
    text,
    ...(code ? { code } : {}),
    ...(fromFields ? { fromFields } : {}),
  });

  // Formato nuevo: el detalle por parámetro viene en `data`. Formato anterior de get-matrix: en el
  // propio `error`, como objeto.
  const fields = [...fieldMessages(parsed['data']), ...fieldMessages(parsed['error'])];
  if (fields.length > 0) return withCode(fields.join(' '), true);

  const msg =
    typeof parsed['error'] === 'string' && parsed['error'].trim()
      ? parsed['error']
      : typeof parsed['message'] === 'string'
        ? parsed['message']
        : raw;
  // A veces el error embebe un JSON de validación por campo: 'Error Loading data: {"source":["..."]}'.
  const nested = msg.match(/\{[\s\S]*\}/);
  if (nested) {
    try {
      const embedded = fieldMessages(JSON.parse(nested[0]));
      if (embedded.length > 0) return withCode(embedded.join(' '), true);
    } catch {
      // no era un JSON de campos: se ignora.
    }
  }
  return withCode(msg);
}

/** Un fallo de red (status 0): el host no existe, no contestó o rechazó la conexión. */
function networkMessage(body: string): string {
  const dns = /\b(ENOTFOUND|EAI_AGAIN)\b\s*([^\s)]*)/.exec(body);
  if (dns) {
    const host = dns[2] ? ` «${dns[2]}»` : '';
    return `No encontramos el servidor de AgentCars${host}: la dirección no existe. ${URL_HINT}`;
  }
  if (/no respondió/i.test(body)) {
    return 'AgentCars no respondió a tiempo. Prueba de nuevo en unos segundos.';
  }
  return 'No pudimos conectar con AgentCars. Prueba de nuevo en unos segundos.';
}

/**
 * Mapea un error de AgentCars (status + body) a un mensaje accionable para el agente. `path` es la
 * operación (`/get-matrix`, `/confirmation`…): el mismo "not found" dice cosas distintas en una
 * búsqueda, en una reserva y en una confirmación.
 */
export function humanizeAgentCarsError(status: number, body: string, path?: string): string {
  // Error de red (status 0 = fetch falló) o del proveedor (5xx).
  if (status === 0) return networkMessage(body);
  if (status >= 500) {
    return 'AgentCars tuvo un problema interno. Prueba de nuevo en unos minutos.';
  }

  // Configuración: la URL base no es la raíz de la API y AgentCars no conoce la ruta.
  if (isMissingRoute(status, body)) {
    return `La dirección configurada para AgentCars no existe (404). ${URL_HINT}`;
  }

  const detail = describe(body);
  const m = detail.text.toLowerCase();
  const op = path ?? '';

  // Configuración: país de origen (POS) sin definir.
  if (m.includes('source country') || (m.includes('source') && m.includes('blank'))) {
    return 'Falta el país de origen (POS) en la configuración de AgentCars. Carga "País origen / POS" en Mi Red → Credenciales → AgentCars (o la variable AGENT_CARS_SOURCE).';
  }

  // Credenciales / token. La guía v2.0: "Authentication IP + token", cada token vale sólo desde la IP
  // que AgentCars tiene registrada.
  if (
    status === 401 ||
    m.includes('unauthorized') ||
    m.includes('invalid credentials') ||
    m.includes('access token') ||
    m.includes('access-token') ||
    (m.includes('token') && (m.includes('invalid') || m.includes('blank')))
  ) {
    return 'AgentCars rechazó las credenciales. Cada Access Token vale sólo desde la IP que AgentCars tiene registrada: verifica el token en Mi Red → Credenciales → AgentCars y pídele a AgentCars que registre la IP pública del servidor.';
  }
  if (status === 403) {
    return `AgentCars dice que la cuenta no tiene permiso para esta operación${
      detail.text && !isHtml(detail.text) ? `: ${detail.text.slice(0, 160)}` : ''
    }. Consúltalo con AgentCars.`;
  }

  // Integración: falta un parámetro obligatorio (así lo contesta AgentCars, con ese "2").
  if (m.includes('requested page does not exist')) {
    return 'Al pedido a AgentCars le falta un dato obligatorio. Es un error de la integración, no de la búsqueda: repórtalo al equipo técnico.';
  }

  // Confirmación: incompleta, o sin código (pudo quedar hecha: no reintentar a ciegas).
  if (m.includes('incomplete_request')) {
    return 'AgentCars rechazó la reserva por datos incompletos (INCOMPLETE_REQUEST). Vuelve a buscar y selecciona el auto de nuevo; si se repite, repórtalo al equipo técnico.';
  }
  if (m.includes('sin código de confirmación')) {
    return 'AgentCars no devolvió el código de confirmación y la reserva pudo quedar hecha. Revísala en «Gestionar reserva» o en el reporte diario antes de intentar de nuevo.';
  }

  const notFound = status === 404 || m.includes('not found') || m.includes('no encontr');

  // Reserva existente que no aparece: es el apellido o el código, no una sesión.
  if (RESERVATION_PATHS.has(op) && notFound) {
    return 'No encontramos esa reserva en AgentCars. Revisa el apellido del conductor y el código de confirmación.';
  }

  // Sin tarifas para esos datos (code 13000; antes, un 412 "We don't have rates…").
  if (detail.code === NO_RATES_CODE || /don'?t have rates/i.test(detail.text)) {
    if (op === '/get-selection') {
      return 'Ese auto ya no está disponible con esa tarifa. Vuelve a buscar para ver opciones actualizadas.';
    }
    if (op === '/get-rate-information') {
      return 'La tarifa ya no está disponible. Vuelve a buscar y selecciona el auto de nuevo.';
    }
    return 'AgentCars no devolvió autos para esta búsqueda. Prueba con otras fechas, otro horario u otro lugar de recogida.';
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

  // Parámetros de búsqueda inválidos: 422 / code 13001 desde el 2026-10-13; antes, la validación por
  // campo en el propio `error`.
  if (status === 422 || detail.code === INVALID_SEARCH_CODE || detail.fromFields) {
    const why = detail.text && !isHtml(detail.text) ? `: ${detail.text.slice(0, 200)}` : '';
    return `AgentCars no aceptó los datos de la búsqueda${why}. Revísalos y busca de nuevo.`;
  }

  const empty =
    m.includes('empty response') ||
    m.includes('carservice') ||
    m.includes('respuesta vacía') ||
    detail.text.trim() === '';

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
  if (detail.text && detail.text.length <= 160 && !isHtml(detail.text)) {
    return `AgentCars rechazó la operación: ${detail.text}`;
  }
  return 'AgentCars no pudo procesar la solicitud. Revisa los datos e intenta de nuevo.';
}
