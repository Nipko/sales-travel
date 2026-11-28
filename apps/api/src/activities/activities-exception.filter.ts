import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DespegarActivitiesInputError } from '@sales-travel/despegar-activities';
import { DespegarApiError, DespegarCancelNotAllowedError } from '@sales-travel/despegar-hotels';
import type { Response } from 'express';
import { DespegarActivitiesNotConfiguredError } from '../providers-despegar/despegar-activities.factory.js';
import { activityCancelNotAllowedMessage, mapActivityError } from './activities-errors.js';

/**
 * Errores de Despegar en las rutas de actividades → respuesta con un mensaje para el vendedor.
 * Al log va el estado, la ruta y el `code` de Despegar; NUNCA el cuerpo: el book y `/reservations`
 * traen nombres, correos y documentos (el intercambio completo queda en la bóveda cifrada).
 */
@Catch(
  DespegarApiError,
  DespegarCancelNotAllowedError,
  DespegarActivitiesInputError,
  DespegarActivitiesNotConfiguredError,
)
export class DespegarActivitiesExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DespegarActivities');

  catch(err: Error, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DespegarApiError) {
      this.logger.warn(
        `${err.status} ${err.path}${err.providerCode ? ` (${err.providerCode})` : ''}`,
      );
      const mapped = mapActivityError(err.status, err.providerCode);
      res.status(mapped.status).json({
        statusCode: mapped.status,
        message: mapped.message,
        ...(err.providerCode ? { providerCode: err.providerCode } : {}),
      });
      return;
    }
    if (err instanceof DespegarCancelNotAllowedError) {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        message: activityCancelNotAllowedMessage(err.allowance.disallowedReason),
      });
      return;
    }
    if (err instanceof DespegarActivitiesNotConfiguredError) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message:
          'Tu agencia no tiene una cuenta de Despegar cargada. Cárgala en Proveedores o pídesela a tu consolidador.',
      });
      return;
    }
    res
      .status(HttpStatus.BAD_REQUEST)
      .json({ statusCode: HttpStatus.BAD_REQUEST, message: err.message });
  }
}
