import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AgentCarsApiError } from '@sales-travel/agent-cars';
import type { Response } from 'express';

/**
 * Convierte un error del proveedor AgentCars (HTTP no-2xx / respuesta inválida) en un 502 Bad
 * Gateway con el mensaje real del proveedor, en vez de un 500 genérico. Facilita diagnóstico
 * (el cliente ve "AgentCars: API 400 on /get-selection: ...") y no expone un stack interno.
 */
@Catch(AgentCarsApiError)
export class AgentCarsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('AgentCars');

  catch(err: AgentCarsApiError, host: ArgumentsHost): void {
    this.logger.warn(err.message);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(HttpStatus.BAD_GATEWAY).json({
      statusCode: HttpStatus.BAD_GATEWAY,
      error: 'Bad Gateway',
      message: `AgentCars: ${err.message}`,
    });
  }
}
