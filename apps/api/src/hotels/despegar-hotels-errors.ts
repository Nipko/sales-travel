/**
 * Traduce el cuerpo de error crudo de Despegar Hoteles a un mensaje claro en español para el agente.
 * Mismo enfoque que apps/api/src/cars/agent-cars-errors.ts (mensaje canónico, testeado, accionable).
 */

/** Extrae el mensaje legible del body (desanida el JSON de error/validación si existe). */
function extractMessage(body: string): string {
  const raw = body.trim();
  let msg = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['message'] === 'string') msg = parsed['message'];
    else if (typeof parsed['error'] === 'string') msg = parsed['error'];
    else if (typeof parsed['description'] === 'string') msg = parsed['description'];
  } catch {
    // body no es JSON: se usa tal cual.
  }
  return msg;
}

/** Mapea un error de Despegar (status + body) a un mensaje accionable para el agente. */
export function humanizeDespegarError(status: number, body: string): string {
  const detail = extractMessage(body);
  const m = detail.toLowerCase();

  if (status === 0) {
    return 'No pudimos conectar con el proveedor de hoteles. Probá de nuevo en unos segundos.';
  }
  if (status >= 500) {
    return 'El proveedor de hoteles tuvo un problema interno. Probá de nuevo en unos minutos.';
  }

  if (
    status === 401 ||
    status === 403 ||
    m.includes('unauthorized') ||
    m.includes('apikey') ||
    m.includes('api key') ||
    m.includes('forbidden')
  ) {
    return 'Las credenciales de Despegar Hoteles son inválidas o faltan. Verificá la API key en Mi Red → Credenciales → Despegar Hoteles.';
  }

  if (
    status === 410 ||
    m.includes('expir') ||
    m.includes('vencid') ||
    m.includes('not available') ||
    m.includes('sold out') ||
    m.includes('no availability') ||
    m.includes('unavailable')
  ) {
    return 'La tarifa o disponibilidad seleccionada ya venció. Volvé a buscar para ver opciones actualizadas y reintentá la reserva.';
  }

  if (detail && detail.length <= 160) {
    return `Despegar Hoteles rechazó la operación: ${detail}`;
  }
  return 'No pudimos procesar la solicitud con Despegar Hoteles. Revisá los datos e intentá nuevamente.';
}
