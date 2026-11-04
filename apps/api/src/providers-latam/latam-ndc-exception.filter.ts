import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { LATAM_BUSINESS_ERROR_STATUS, LatamApiError } from '@sales-travel/latam-ndc';
import type { Response } from 'express';
import { humanizeLatamError } from './latam-ndc-errors.js';

/**
 * Convierte un error LANZADO por LATAM NDC (red/timeout/auth/token/config/no-parseable) en un 502
 * con mensaje claro en español, en vez de un 500 genérico. El detalle (sin PII) queda en el log.
 * Espejo de AgentCarsExceptionFilter / DespegarHotelsExceptionFilter.
 */
@Catch(LatamApiError)
export class LatamNdcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('LatamNdc');

  catch(err: LatamApiError, host: ArgumentsHost): void {
    this.logger.warn(`${err.status} ${err.path}`);
    const res = host.switchToHttp().getResponse<Response>();
    // LATAM respondió y dijo que no (`LatamBusinessError`): es un 422 con su motivo, no un 502. Un
    // 502 se lee —y Cloudflare lo trata— como «el servidor está caído», y el vendedor veía «el
    // servidor no está respondiendo» en vez de «LATAM rechazó: IATA Validation Failed».
    const business = err.status === LATAM_BUSINESS_ERROR_STATUS;
    const status = business ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.BAD_GATEWAY;
    res.status(status).json({
      statusCode: status,
      error: business ? 'Unprocessable Entity' : 'Bad Gateway',
      message: humanizeLatamError(err.status, err.body),
    });
  }
}
