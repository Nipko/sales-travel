/**
 * Traduce un error LANZADO por el proveedor LATAM NDC (red/timeout, auth/token, config faltante,
 * respuesta no parseable) a un mensaje claro en español. NOTA: los errores de NEGOCIO de LATAM
 * (códigos 933/911, etc.) viajan como result.error en el JSON de respuesta y los humaniza el
 * frontend (humanizeOrderError); este helper cubre los que se lanzan como LatamApiError → 502.
 */
function extractMessage(body: string): string {
  const raw = body.trim();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['message'] === 'string') return parsed['message'];
    if (typeof parsed['error'] === 'string') return parsed['error'];
    if (typeof parsed['error_description'] === 'string') return parsed['error_description'];
  } catch {
    // body no es JSON (XML/texto): se usa tal cual.
  }
  return raw;
}

export function humanizeLatamError(status: number, body: string): string {
  const detail = extractMessage(body);
  const m = detail.toLowerCase();

  if (status === 0) {
    return 'No pudimos conectar con LATAM. Probá de nuevo en unos segundos.';
  }
  if (status >= 500) {
    return 'LATAM tuvo un problema interno. Probá de nuevo en unos minutos.';
  }

  // Credenciales / token (incluye config faltante apiKey/apiSecret/agencyName y oauth 401/403).
  if (
    status === 401 ||
    status === 403 ||
    m.includes('unauthorized') ||
    m.includes('apikey') ||
    m.includes('apisecret') ||
    m.includes('api key') ||
    m.includes('invalid_client') ||
    m.includes('required') ||
    m.includes('token')
  ) {
    return 'Las credenciales de LATAM (API key/secret/agencia) son inválidas o faltan. Verificá en Mi Red → Credenciales → LATAM NDC.';
  }

  // Falta Travel Agent ID (mismo caso que el front maneja para operaciones de orden).
  if (m.includes('missing agent') || m.includes('403111009') || m.includes('travel agent')) {
    return 'Falta el "Travel Agent ID" en tus credenciales de LATAM. Cargalo en Mi Red → Credenciales → LATAM NDC y reintentá.';
  }

  if (detail && detail.length <= 160) {
    return `LATAM rechazó la operación: ${detail}`;
  }
  return 'No pudimos procesar la solicitud con LATAM. Revisá los datos e intentá nuevamente.';
}
