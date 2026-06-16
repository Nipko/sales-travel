import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** Convierte el `message` de un HttpException (string | string[] | unknown) a texto, sin "[object Object]". */
function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').join('; ');
  return '';
}

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

    // Respuesta al cliente, normalizada a { statusCode, error, message[, fields] }.
    // Para HttpException: se traduce el mensaje (auth/genéricos a español; los que ya vienen
    // en español o son de negocio se respetan). Para 500: NUNCA exponer el crudo (podría filtrar
    // errores de DB/esquema) — genérico en español y el detalle queda sólo en los logs.
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const obj =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const rawMessage = typeof body === 'string' ? body : (obj['message'] ?? exception.message);
      const text = toText(rawMessage);
      const fields = 'fields' in obj ? { fields: obj['fields'] } : {};
      response.status(status).json({
        statusCode: status,
        error: typeof obj['error'] === 'string' ? obj['error'] : 'Error',
        message: this.humanize(status, text),
        ...fields,
      });
      return;
    }

    response.status(status).json({
      statusCode: status,
      error: 'Internal Server Error',
      message: 'Ocurrió un error inesperado. Intentá de nuevo en unos minutos.',
    });
  }

  /** Traduce mensajes técnicos/de auth comunes (en inglés) a español; respeta los demás. */
  private humanize(status: number, raw: string): string {
    const m = raw.toLowerCase().trim();
    if (m.includes('invalid credentials')) return 'Email o contraseña incorrectos.';
    if (m.includes('verification token'))
      return 'El enlace de verificación es inválido o expiró. Pedí uno nuevo.';
    if (m.includes('no active membership'))
      return 'No tenés una membresía activa para acceder. Pedí acceso al administrador de tu agencia.';
    if (m === 'unauthorized') return 'Tu sesión expiró o no iniciaste sesión. Volvé a ingresar.';
    if (m === 'forbidden') return 'No tenés permiso para realizar esta acción.';
    if (m === 'too many requests')
      return 'Demasiados intentos. Esperá un momento e intentá de nuevo.';
    // Mensaje ya en español o específico del negocio: se respeta.
    return raw || 'No pudimos procesar la solicitud.';
  }
}
