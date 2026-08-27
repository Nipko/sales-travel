import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { SabreApiError, redactText } from '@sales-travel/sabre';
import type { Response } from 'express';
import { SABRE_THROWN_CLASSES, humanizeSabreError, sabreErrorStatus } from './sabre-errors.js';

/**
 * Convierte un error LANZADO por el ACL de Sabre en una respuesta con mensaje en español, en vez
 * de un 500 genérico. Espejo de `LatamNdcExceptionFilter`.
 *
 * Captura TODAS las clases que el paquete lanza hacia arriba, no sólo `SabreApiError`. La lista
 * vive en `SABRE_THROWN_CLASSES` y no aquí, y el motivo es concreto: desde que Sabre reserva —y
 * no sólo busca— el ACL lanza doce clases más (price, create, get, cancel), y una clase que
 * faltara en el decorador no da un error de compilación, da un 500 «Ocurrió un error inesperado»
 * delante del cliente. Con una sola lista, añadir una clase al ACL y olvidarse de este fichero
 * deja de ser posible.
 *
 * El estado no siempre es 502: lo decide `sabreErrorStatus`. Un rechazo por política de tarjeta
 * (D1) es 403 y una oferta que ya no se puede vender es 409 — decir 502 en esos casos invita a
 * reintentar algo que nunca va a salir bien.
 *
 * Nota de alcance: este filtro sólo actúa sobre errores que llegan al controlador. En el
 * fan-out de búsqueda los fallos de un proveedor NO se propagan —se degradan a
 * `providers[].reason`— y ese texto lo produce el mismo `humanizeSabreError` a través de
 * `FlightProviderRegistry.humanizeError`.
 */
/** Etiqueta `error` del cuerpo, por estado. Es lo que ya devolvían el resto de filtros. */
const ERROR_LABEL: Readonly<Record<number, string>> = {
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
};

@Catch(...SABRE_THROWN_CLASSES)
export class SabreExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Sabre');

  catch(err: Error, host: ArgumentsHost): void {
    // `toLogMeta()` ya viene redactado por el propio ACL (nunca body ni texto libre).
    //
    // Para las otras clases se loguea el nombre MÁS el mensaje pasado por `redactText`. Antes se
    // tiraba el mensaje entero y sólo quedaba el nombre, con este razonamiento: sus mensajes son
    // rutas y códigos de Zod, pero el log no es el sitio donde apostar a que eso no cambie.
    //
    // La apuesta era correcta; la conclusión no. Un `SabreCreateBookingError` es un fallo NUESTRO
    // —el body no pasó nuestra propia validación y la reserva ni salió al cable—, así que su
    // mensaje nombra el campo que falló y es literalmente lo único con lo que se arregla. Sin él,
    // en producción sólo quedaba «SabreCreateBookingError en el ACL de Sabre», que no dice nada y
    // deja al vendedor sin poder reservar y a nosotros sin saber por qué.
    //
    // No hace falta elegir entre diagnosticar y no filtrar: `redactText` es la misma puerta por la
    // que ya pasa todo lo que el ACL escribe. Se redacta y se loguea, en vez de confiar y tirar.
    if (err instanceof SabreApiError) {
      this.logger.warn(JSON.stringify(err.toLogMeta()));
    } else {
      this.logger.warn(`${err.name} en el ACL de Sabre: ${redactText(err.message)}`);
    }

    const status = sabreErrorStatus(err);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(status).json({
      statusCode: status,
      error: ERROR_LABEL[status] ?? 'Bad Gateway',
      message: humanizeSabreError(err),
    });
  }
}
