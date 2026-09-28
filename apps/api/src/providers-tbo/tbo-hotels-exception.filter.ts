import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { TboError } from '@sales-travel/tbo-hotels';
import type { Response } from 'express';
import { humanizeTboError, tboErrorReason, tboErrorStatus } from './tbo-hotels-errors.js';

/** Etiqueta `error` del cuerpo, por estado. La misma que usan los demás filtros. */
const ERROR_LABEL: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
};

/**
 * Convierte cualquier error LANZADO por el ACL de TBO en una respuesta con mensaje en español y un
 * campo máquina `reason`, en vez del 500 genérico del filtro global (docs/tbo/01 §9.4).
 *
 * Captura la clase madre `TboError` y no una lista: Nest compara con `instanceof`, así que una
 * clase que el ACL sume mañana cae aquí igual. Es la lección de `SABRE_THROWN_CLASSES` llevada un
 * paso más allá: con una lista, la clase que falta no rompe la compilación, sale como 500.
 *
 * El log es `toLogMeta()` y nada más: la lista blanca que cada clase del ACL declara (path, códigos,
 * `kind`, `requestId`, `ruta:código`). Nunca el `message`, nunca un cuerpo.
 *
 * Nota de alcance: en la búsqueda combinada los fallos de TBO no llegan aquí, se degradan a
 * `providers[].reason` con el mismo `humanizeTboError`, y allí sí se sabe si la cuenta es propia o
 * heredada. Aquí no: el mensaje de cuenta habla de "la cuenta con la que opera tu agencia".
 */
@Catch(TboError)
export class TboHotelsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('TboHotels');

  catch(err: TboError, host: ArgumentsHost): void {
    this.logger.warn(JSON.stringify(err.toLogMeta()));

    const status = tboErrorStatus(err);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(status).json({
      statusCode: status,
      error: ERROR_LABEL[status] ?? 'Bad Gateway',
      message: humanizeTboError(err),
      reason: tboErrorReason(err),
    });
  }
}
