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

function extractCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
    const code = parsed['code'] ?? parsed['error_code'];
    return typeof code === 'string' ? code.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Códigos de error y `sub_status` de HotelDO con el mensaje que ve el vendedor (certificación,
 * punto 11: cada código de HotelDO mapeado a uno nuestro). Lo que no está aquí cae al texto de
 * Despegar o a un genérico.
 */
export const DESPEGAR_CODE_MESSAGES: Readonly<Record<string, string>> = {
  PRODUCT_GONE:
    'La tarifa ya no está disponible en Despegar. Vuelve a buscar para ver opciones actualizadas.',
  INVALID_ITINERARY_ID_OR_COUNTRY:
    'La tarifa ya no está disponible en Despegar. Vuelve a buscar para ver opciones actualizadas.',
  INVALID_PREBOOK_ID:
    'La pre-reserva venció (dura 15 minutos). Vuelve a abrir la tarifa para revalidarla y reserva de nuevo.',
  INVALID_FIELD:
    'Despegar rechazó un dato de la reserva o la pre-reserva ya venció. Revisa los datos y vuelve a revalidar la tarifa.',
  ALREADY_BOOKED: 'Esta pre-reserva ya se usó para una reserva. Consulta la reserva existente.',
  DUPLICATED_RESERVATION:
    'Despegar detectó una reserva duplicada con los mismos datos. Consulta las reservas antes de volver a intentar.',
  NOT_ENOUGH_BALANCE:
    'La cuenta corriente con Despegar no tiene saldo o crédito suficiente para esta reserva. Contacta al titular de la cuenta.',
  INSUFFICIENT_FUNDS:
    'La cuenta corriente con Despegar no tiene saldo o crédito suficiente para esta reserva. Contacta al titular de la cuenta.',
  PAYMENT_ERROR: 'Despegar no pudo procesar el pago de la reserva. No se reservó nada.',
  PAYMENT_OPTION_NOT_FOUND:
    'La forma de pago elegida no está habilitada para esta cuenta de Despegar. Revisa la configuración de la cuenta.',
  CHANNEL_REJECTED: 'Despegar rechazó la reserva por política del canal. No se reservó nada.',
  PRICE_JUMP:
    'El precio subió al confirmar. Revisa el nuevo precio y acéptalo o recházalo antes de que venza.',
  MISSING_REQUIRED_PARAMETER: 'Falta un dato obligatorio para Despegar. Revisa el formulario.',
  MISSING_REQUEST_BODY_REQUIRED_FIELD:
    'Falta un dato obligatorio para Despegar. Revisa el formulario.',
  MESSAGE_NOT_READABLE: 'Despegar no pudo leer la solicitud. Revisa los datos e intenta de nuevo.',
  TOO_MANY_REQUESTS:
    'Despegar está limitando las consultas de esta cuenta. Espera unos segundos y vuelve a intentar.',
};

const CANCEL_DISALLOWED_MESSAGES: Readonly<Record<string, string>> = {
  ALREADY_CANCELLED: 'La reserva ya está cancelada en Despegar.',
  CANCEL_IN_PROCESS: 'Ya hay una cancelación en curso para esta reserva.',
  CHANGE_IN_PROGRESS:
    'La reserva tiene un cambio en curso: no se puede cancelar hasta que termine.',
  INVALID_MINIMUM_HOURS:
    'Ya no se puede cancelar por la API: pasó el plazo mínimo antes del check-in. Contacta a Despegar.',
  AFTERSALE_NOT_ALLOWED: 'Despegar no permite cancelar esta reserva por la API.',
};

/** Por qué Despegar no deja cancelar (paso 1 de la cancelación). */
export function humanizeCancelNotAllowed(reason: string | undefined): string {
  return (
    (reason === undefined ? undefined : CANCEL_DISALLOWED_MESSAGES[reason.toUpperCase()]) ??
    'Despegar no permite cancelar esta reserva en este momento. Si recién se confirmó, espera un minuto y vuelve a intentar.'
  );
}

/** El mensaje de un código o `sub_status` de HotelDO, si lo conocemos. */
export function humanizeDespegarCode(code: string | undefined): string | undefined {
  return code === undefined ? undefined : DESPEGAR_CODE_MESSAGES[code.toUpperCase()];
}

/** Mapea un error de Despegar (status + body) a un mensaje accionable para el agente. */
export function humanizeDespegarError(status: number, body: string): string {
  const detail = extractMessage(body);
  const m = detail.toLowerCase();

  if (status === 0) {
    return 'No pudimos conectar con el proveedor de hoteles. Prueba de nuevo en unos segundos.';
  }
  if (status === 429) return DESPEGAR_CODE_MESSAGES['TOO_MANY_REQUESTS']!;
  const byCode = humanizeDespegarCode(extractCode(body));
  if (byCode !== undefined) return byCode;
  if (status >= 500) {
    return 'El proveedor de hoteles tuvo un problema interno. Prueba de nuevo en unos minutos.';
  }

  if (
    status === 401 ||
    status === 403 ||
    m.includes('unauthorized') ||
    m.includes('apikey') ||
    m.includes('api key') ||
    m.includes('forbidden')
  ) {
    return 'Las credenciales de Despegar Hoteles son inválidas o faltan. Verifica la API key en Mi Red → Credenciales → Despegar Hoteles.';
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
    return 'La tarifa o disponibilidad seleccionada ya venció. Vuelve a buscar para ver opciones actualizadas y reintenta la reserva.';
  }

  if (detail && detail.length <= 160) {
    return `Despegar Hoteles rechazó la operación: ${detail}`;
  }
  return 'No pudimos procesar la solicitud con Despegar Hoteles. Revisa los datos e intenta nuevamente.';
}
