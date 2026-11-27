import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  DespegarApiError,
  DespegarCancelNotAllowedError,
  DespegarReservationNotFoundError,
} from '@sales-travel/despegar-hotels';
import type { Response } from 'express';
import { humanizeCancelNotAllowed, humanizeDespegarError } from './despegar-hotels-errors.js';

type DespegarFailure =
  | DespegarApiError
  | DespegarCancelNotAllowedError
  | DespegarReservationNotFoundError;

/**
 * Convierte un error del proveedor Despegar en una respuesta clara y accionable en vez de un 500
 * genérico:
 *
 * - `DespegarApiError` (HTTP no-2xx, red caída, respuesta inválida) → 502 con el mensaje humano.
 * - `DespegarCancelNotAllowedError` (paso 1 de la cancelación dijo que no) → 409.
 * - `DespegarReservationNotFoundError` (`/reservations` no trae el producto) → 404.
 *
 * En el log van el estado, la ruta y el `code` de Despegar, NUNCA el cuerpo: el Book y
 * `/reservations` devuelven nombres, email y documentos.
 */
@Catch(DespegarApiError, DespegarCancelNotAllowedError, DespegarReservationNotFoundError)
export class DespegarHotelsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DespegarHotels');

  catch(err: DespegarFailure, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DespegarCancelNotAllowedError) {
      this.logger.warn(
        `cancelación no permitida: ${err.allowance.allowance} ${err.allowance.disallowedReason ?? ''}`.trim(),
      );
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: humanizeCancelNotAllowed(err.allowance.disallowedReason),
      });
      return;
    }
    if (err instanceof DespegarReservationNotFoundError) {
      this.logger.warn('reserva sin producto en /reservations');
      res.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        message:
          'Despegar todavía no muestra esta reserva en post-venta. Si recién se confirmó, espera un minuto y vuelve a intentar.',
      });
      return;
    }
    this.logger.warn(`${err.status} ${err.path}${err.providerCode ? ` ${err.providerCode}` : ''}`);
    // «Booking does not exist»: el id no corresponde a ninguna reserva de la cuenta. Es un 404 del
    // pedido, no una caída del proveedor (docs/qa/01 QA-H-30); antes salía 502.
    if (err.status === 404 || /does not exist|not found/i.test(err.body)) {
      res.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        message: 'Despegar no tiene una reserva con ese número.',
      });
      return;
    }
    res.status(HttpStatus.BAD_GATEWAY).json({
      statusCode: HttpStatus.BAD_GATEWAY,
      error: 'Bad Gateway',
      message: humanizeDespegarError(err.status, err.body),
    });
  }
}
