/**
 * Traduce el cuerpo de error crudo de AgentCars a un mensaje claro en español para el usuario.
 * AgentCars suele responder { "error": "Error Loading data: {\"campo\":[\"mensaje\"]}" } o texto plano.
 */

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

/** Mapea un error de AgentCars (status + body) a un mensaje accionable para el agente. */
export function humanizeAgentCarsError(status: number, body: string): string {
  const detail = extractMessage(body);
  const m = detail.toLowerCase();

  // Error de red / proveedor caído (status 0 = fetch falló; 5xx = error del proveedor).
  if (status === 0) {
    return 'No pudimos conectar con AgentCars. Probá de nuevo en unos segundos.';
  }
  if (status >= 500) {
    return 'AgentCars tuvo un problema interno. Probá de nuevo en unos minutos.';
  }

  // Configuración: país de origen (POS) sin definir.
  if (m.includes('source country') || (m.includes('source') && m.includes('blank'))) {
    return 'Falta el país de origen (POS) en la configuración de AgentCars. Cargá "País origen / POS" en Mi Red → Credenciales → AgentCars (o la variable AGENT_CARS_SOURCE).';
  }

  // Credenciales / token.
  if (
    status === 401 ||
    status === 403 ||
    m.includes('unauthorized') ||
    m.includes('access token') ||
    m.includes('access-token') ||
    (m.includes('token') && (m.includes('invalid') || m.includes('blank')))
  ) {
    return 'Las credenciales de AgentCars son inválidas o faltan. Verificá el Access Token en Mi Red → Credenciales → AgentCars.';
  }

  // Sesión expirada (uniqid tiene TTL de 15 min).
  if (
    m.includes('uniqid') ||
    m.includes('session') ||
    m.includes('expir') ||
    m.includes('vencid') ||
    m.includes('not found') ||
    status === 410
  ) {
    return 'La sesión de la búsqueda expiró (es válida 15 minutos). Volvé a buscar y seleccioná el auto de nuevo.';
  }

  // Respuesta vacía del servicio de autos del proveedor: el rental no devolvió datos. Suele pasar
  // cuando la tarifa/sesión (uniqid, TTL 15 min) venció entre la selección y la confirmación, o el
  // auto dejó de estar disponible.
  if (
    m.includes('empty response') ||
    m.includes('carservice') ||
    m.includes('respuesta vacía') ||
    detail.trim() === ''
  ) {
    return 'AgentCars no devolvió disponibilidad para esta operación. La tarifa pudo expirar (válida 15 min): volvé a buscar y seleccioná el auto de nuevo.';
  }

  // Tarifa / disponibilidad ya no vigente.
  if (
    m.includes('rate') ||
    m.includes('tarifa') ||
    m.includes('availab') ||
    m.includes('disponib')
  ) {
    return 'La tarifa o el auto seleccionado ya no está disponible. Volvé a buscar para ver opciones actualizadas.';
  }

  // Fallback: mostramos el detalle del proveedor si es corto y legible, si no, genérico.
  if (detail && detail.length <= 160) {
    return `AgentCars rechazó la operación: ${detail}`;
  }
  return 'AgentCars no pudo procesar la solicitud. Revisá los datos e intentá nuevamente.';
}
