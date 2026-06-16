import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AgentCarsApiError } from '@sales-travel/agent-cars';
import type { Response } from 'express';
import { humanizeAgentCarsError } from './agent-cars-errors.js';

/**
 * Convierte un error del proveedor AgentCars (HTTP no-2xx / red caída) en un 502 Bad Gateway con un
 * mensaje claro y accionable para el agente (vía humanizeAgentCarsError), en vez de un 500 genérico
 * o el texto crudo del proveedor. El detalle técnico queda en el log, no en la respuesta al cliente.
 */
@Catch(AgentCarsApiError)
export class AgentCarsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('AgentCars');

  catch(err: AgentCarsApiError, host: ArgumentsHost): void {
    this.logger.warn(`${err.status} ${err.path}: ${err.body.slice(0, 250)}`);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(HttpStatus.BAD_GATEWAY).json({
      statusCode: HttpStatus.BAD_GATEWAY,
      error: 'Bad Gateway',
      message: humanizeAgentCarsError(err.status, err.body),
    });
  }
}
