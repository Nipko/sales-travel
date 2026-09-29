import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { tenantHierarchyHttpError } from './database/tenant-hierarchy-errors.js';
import { portfolioHttpError } from './portfolios/portfolio-errors.js';

/**
 * Forma de un motivo máquina (`OFFER_NOT_IN_SEARCH`, `SEARCH_CONTEXT_EXPIRED`): mayúsculas,
 * dígitos y guiones bajos. Lo que no la cumple no sale: un `reason` con texto libre podría citar
 * al proveedor o a un dato del pedido.
 */
const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * El motivo máquina de una excepción, para que la web decida "Volver a buscar" o "Reintentar" sin
 * interpretar el mensaje. Lo puede traer el cuerpo de la excepción o la propia instancia (como los
 * errores del contexto de búsqueda de hoteles, que lo declaran como campo y no en el cuerpo).
 */
function machineReason(
  exception: HttpException,
  body: Record<string, unknown>,
): string | undefined {
  const candidates: unknown[] = [
    body['reason'],
    (exception as unknown as Record<string, unknown>)['reason'],
  ];
  return candidates.find((c): c is string => typeof c === 'string' && MACHINE_REASON.test(c));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Las marcas que dicen si se puede repetir una reserva. Sólo `true`: su ausencia es "no". */
const RECONCILIATION_FLAGS = ['duplicateRequest', 'retryForbidden', 'reconciliationRequired'];

/**
 * Lo que la web necesita de un 409 de creación para NO repetir una reserva que puede existir: la
 * orden y las marcas (docs/tbo/08 RF-22). Sin ellas, un doble envío o un Book pendiente de
 * conciliación se veían en el navegador como un error cualquiera, con el botón de reintentar.
 */
function reconciliationFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const orderId = body['orderId'];
  if (typeof orderId === 'string' && UUID.test(orderId)) out['orderId'] = orderId;
  for (const flag of RECONCILIATION_FLAGS) {
    if (body[flag] === true) out[flag] = true;
  }
  return out;
}

/**
 * Datos que la PROPIA excepción declara publicables en `publicDetails` (p. ej. el precio nuevo de
 * una tarifa revalidada). Es opt-in por clase: quien lo declara responde de que ahí sólo haya
 * vocabulario cerrado, importes y referencias nuestras, nunca texto del proveedor ni PII.
 */
function publicDetails(exception: HttpException): Record<string, unknown> | undefined {
  const details = (exception as unknown as { publicDetails?: unknown }).publicDetails;
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

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
    // Las reglas de la jerarquía de tenants (0050, 0051) y las de las carteras (0052) las valida la
    // base con SQLSTATE propio: un nodo en un lugar que la matriz no admite, o una cartera que toca
    // quien no la financia, es un 409 o un 403 con motivo, no un 500.
    if (!(exception instanceof HttpException)) {
      const translated = tenantHierarchyHttpError(exception) ?? portfolioHttpError(exception);
      if (translated !== undefined) {
        this.catch(translated, host);
        return;
      }
    }

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

    // Log exception: 5xx as error with stack trace, 4xx as warn without cluttering stack trace
    const logDetails = `[${request.method}] ${request.url} - Status: ${status} - Details: ${
      typeof message === 'object' ? JSON.stringify(message) : message
    }`;
    if (status >= 500) {
      this.logger.error(logDetails, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logDetails);
    }

    // Respuesta al cliente, normalizada a { statusCode, error, message[, reason][, fields] }, más
    // las marcas de conciliación y los `details` que la excepción declare publicables.
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
      const reason = machineReason(exception, obj);
      const details = publicDetails(exception);
      response.status(status).json({
        statusCode: status,
        error: typeof obj['error'] === 'string' ? obj['error'] : 'Error',
        message: this.humanize(status, text),
        ...(reason === undefined ? {} : { reason }),
        ...fields,
        ...reconciliationFields(obj),
        ...(details === undefined ? {} : { details }),
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
