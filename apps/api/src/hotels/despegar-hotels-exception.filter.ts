import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DespegarApiError } from '@sales-travel/despegar-hotels';
import type { Response } from 'express';
import { humanizeDespegarError } from './despegar-hotels-errors.js';

/**
 * Convierte un error del proveedor Despegar (HTTP no-2xx / red caída / respuesta inválida) en un 502
 * con un mensaje claro y accionable (humanizeDespegarError), en vez de un 500 genérico. El detalle
 * técnico queda en el log, no en la respuesta al cliente. Espejo de AgentCarsExceptionFilter.
 */
@Catch(DespegarApiError)
export class DespegarHotelsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DespegarHotels');

  catch(err: DespegarApiError, host: ArgumentsHost): void {
    this.logger.warn(`${err.status} ${err.path}: ${err.body.slice(0, 250)}`);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(HttpStatus.BAD_GATEWAY).json({
      statusCode: HttpStatus.BAD_GATEWAY,
      error: 'Bad Gateway',
      message: humanizeDespegarError(err.status, err.body),
    });
  }
}
