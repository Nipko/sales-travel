import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { LatamApiError } from '@sales-travel/latam-ndc';
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
    res.status(HttpStatus.BAD_GATEWAY).json({
      statusCode: HttpStatus.BAD_GATEWAY,
      error: 'Bad Gateway',
      message: humanizeLatamError(err.status, err.body),
    });
  }
}
