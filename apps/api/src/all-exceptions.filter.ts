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

    // Format uniform standard response
    response.status(status).json(
      exception instanceof HttpException
        ? exception.getResponse()
        : {
            statusCode: status,
            message: exception instanceof Error ? exception.message : 'Internal server error',
            error: 'Internal Server Error',
          },
    );
  }
}
