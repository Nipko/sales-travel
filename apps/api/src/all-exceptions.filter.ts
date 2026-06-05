import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : exception instanceof Error
          ? exception.message
          : 'Internal server error';

    // Log the detailed exception trace with HTTP method and path
    this.logger.error(
      `[${request.method}] ${request.url} - Status: ${status} - Error details: ${
        typeof message === 'object' ? JSON.stringify(message) : message
      }`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // Respuesta al cliente: para HttpException, su propio cuerpo (mensajes de negocio
    // controlados). Para cualquier otro error (500), NUNCA exponer el mensaje crudo
    // (podría filtrar errores de DB/esquema); se devuelve genérico y el detalle queda
    // sólo en los logs del servidor.
    response.status(status).json(
      exception instanceof HttpException
        ? exception.getResponse()
        : {
            statusCode: status,
            message: 'Internal server error',
            error: 'Internal Server Error',
          },
    );
  }
}
