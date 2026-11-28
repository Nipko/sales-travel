import { HttpStatus } from '@nestjs/common';
import { humanizeCancelNotAllowed } from '../hotels/despegar-hotels-errors.js';

/**
 * Mapa de errores de la API de actividades de Despegar/HotelDO a lo que ve el vendedor y al estado
 * HTTP que responde la plataforma (docs/despegar/03 § Errores). La certificación pide un mapa
 * claro entre el código de HotelDO y el nuestro: este es.
 *
 * `code` es el `code` del cuerpo de Despegar o el `sub_status` de un book en ERROR.
 */
export interface ActivityErrorMapping {
  readonly status: HttpStatus;
  readonly message: string;
}

export const ACTIVITY_ERROR_CODES: Readonly<Record<string, ActivityErrorMapping>> = {
  INVALID_FIELD: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Despegar rechazó un dato de la búsqueda (por ejemplo, una fecha pasada). Revisa la fecha y los participantes.',
  },
  MISSING_REQUIRED_PARAMETER: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Falta un dato obligatorio para Despegar. Revisa la búsqueda.',
  },
  MISSING_REQUEST_BODY_REQUIRED_FIELD: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Falta un dato obligatorio para Despegar. Revisa el formulario.',
  },
  UNAUTHORIZED: {
    status: HttpStatus.BAD_GATEWAY,
    message:
      'La clave de Despegar de tu agencia no es válida. Revísala en Proveedores o pídele a tu consolidador que la revise.',
  },
  PRODUCT_GONE: {
    status: HttpStatus.CONFLICT,
    message:
      'La tarifa de esta actividad venció. Vuelve a consultar la disponibilidad de la fecha.',
  },
  INVALID_ITINERARY_ID_OR_COUNTRY: {
    status: HttpStatus.CONFLICT,
    message:
      'La tarifa de esta actividad venció. Vuelve a consultar la disponibilidad de la fecha.',
  },
  INVALID_PREBOOK_ID: {
    status: HttpStatus.CONFLICT,
    message: 'La pre-reserva venció. Vuelve a consultar la disponibilidad y reserva de nuevo.',
  },
  ALREADY_BOOKED: {
    status: HttpStatus.CONFLICT,
    message: 'Esta tarifa ya se reservó. Revisa la reserva existente antes de intentar de nuevo.',
  },
  DUPLICATED_RESERVATION: {
    status: HttpStatus.CONFLICT,
    message:
      'Despegar detectó una reserva duplicada con los mismos datos. Revisa las reservas antes de volver a intentar.',
  },
  NOT_ENOUGH_BALANCE: {
    status: HttpStatus.PAYMENT_REQUIRED,
    message:
      'La cuenta corriente con Despegar no tiene saldo suficiente para esta reserva. No se reservó nada.',
  },
  INSUFFICIENT_FUNDS: {
    status: HttpStatus.PAYMENT_REQUIRED,
    message:
      'La cuenta corriente con Despegar no tiene saldo suficiente para esta reserva. No se reservó nada.',
  },
  PAYMENT_ERROR: {
    status: HttpStatus.PAYMENT_REQUIRED,
    message:
      'La cuenta corriente con Despegar no permite pagar en este momento. No se reservó nada.',
  },
  PAYMENT_OPTION_NOT_FOUND: {
    status: HttpStatus.PAYMENT_REQUIRED,
    message:
      'La cuenta de Despegar no tiene habilitada la cuenta corriente para actividades. No se reservó nada.',
  },
  PRICE_JUMP: {
    status: HttpStatus.CONFLICT,
    message: 'El precio cambió al confirmar. Vuelve a consultar la disponibilidad.',
  },
  ACTIVITY_PROVIDER_ERROR: {
    status: HttpStatus.NOT_FOUND,
    message:
      'No hay disponibilidad para esa fecha o esos participantes. Prueba otra fecha u otra modalidad.',
  },
};

const UNREACHABLE: ActivityErrorMapping = {
  status: HttpStatus.BAD_GATEWAY,
  message: 'Despegar no responde. Prueba de nuevo en unos minutos.',
};

const FORBIDDEN: ActivityErrorMapping = {
  status: HttpStatus.BAD_GATEWAY,
  message:
    'La cuenta de Despegar no tiene habilitadas las actividades. Hay que pedirle a Despegar que active el permiso.',
};

/**
 * Qué responder a un error HTTP de Despegar. El `code` manda sobre el estado, salvo en el shopping,
 * donde `ACTIVITY_PROVIDER_ERROR` llega como 400 y es una falla del operador, no falta de cupo.
 */
export function mapActivityError(status: number, code: string | undefined): ActivityErrorMapping {
  const known = code === undefined ? undefined : ACTIVITY_ERROR_CODES[code.toUpperCase()];
  if (known && !(code?.toUpperCase() === 'ACTIVITY_PROVIDER_ERROR' && status !== 503)) {
    return known;
  }
  if (status === 401) return ACTIVITY_ERROR_CODES['UNAUTHORIZED']!;
  if (status === 403) return FORBIDDEN;
  if (status === 410) return ACTIVITY_ERROR_CODES['PRODUCT_GONE']!;
  if (status === 400) {
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'Despegar rechazó la solicitud. Revisa los datos e intenta de nuevo.',
    };
  }
  return UNREACHABLE;
}

/** El `sub_status` de un book en ERROR (llega con HTTP 200). */
export function mapActivityBookError(subStatus: string | undefined): ActivityErrorMapping {
  const known = subStatus === undefined ? undefined : ACTIVITY_ERROR_CODES[subStatus.toUpperCase()];
  return (
    known ?? {
      status: HttpStatus.BAD_GATEWAY,
      message: 'Despegar no confirmó la reserva. No se reservó nada; prueba de nuevo.',
    }
  );
}

export function activityCancelNotAllowedMessage(reason: string | undefined): string {
  return humanizeCancelNotAllowed(reason);
}
