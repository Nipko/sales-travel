import { HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import { FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants';
import {
  TBO_ERROR_CLASSES,
  TBO_OPERATIONS,
  TboApiError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboError,
  TboRequestBuildError,
} from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanizeTboError } from './tbo-hotels-errors.js';
import { TboHotelsExceptionFilter } from './tbo-hotels-exception.filter.js';

/**
 * Qué ve el vendedor cuando TBO falla fuera de la búsqueda combinada (detalle de un hotel hoy;
 * PreBook, Book y post-venta cuando existan): estado según el efecto, mensaje sin eco del
 * proveedor, `reason` para la web y en el log sólo la lista blanca de cada clase.
 */

interface Respuesta {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function respuesta(): Respuesta {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TboHotelsExceptionFilter', () => {
  it('atrapa la clase madre: toda clase que el ACL lance, también una que sume mañana', () => {
    const atrapa: unknown = Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, TboHotelsExceptionFilter);
    expect(atrapa).toEqual([TboError]);
    for (const clase of TBO_ERROR_CLASSES) {
      expect(clase.prototype).toBeInstanceOf(TboError);
    }
  });

  it('un `207` es 409 con el mensaje humanizado y `reason` para "Volver a buscar"', () => {
    const err = new TboApiError({
      status: 200,
      tboCode: 207,
      path: TBO_OPERATIONS.prebook.path,
      kind: 'RATE_UNAVAILABLE',
      requestId: 'req-207',
    });
    const r = respuesta();

    new TboHotelsExceptionFilter().catch(err, r.host);

    expect(r.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(r.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: humanizeTboError(err),
      reason: 'RATE_UNAVAILABLE',
    });
  });

  it.each([
    [
      new TboApiError({
        status: 200,
        tboCode: 429,
        path: TBO_OPERATIONS.search.path,
        kind: 'THROTTLED',
        requestId: 'r',
      }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'Service Unavailable',
    ],
    [
      new TboRequestBuildError(TBO_OPERATIONS.search.path, 'NOT_ELIGIBLE'),
      HttpStatus.BAD_REQUEST,
      'Bad Request',
    ],
    [new TboCredentialsMissingError(['password']), HttpStatus.BAD_GATEWAY, 'Bad Gateway'],
    [
      new TboDispatchRejectedError(TBO_OPERATIONS.search.path, 'QUEUE_TIMEOUT', 3_000),
      HttpStatus.SERVICE_UNAVAILABLE,
      'Service Unavailable',
    ],
  ])('%s → %i %s', (err, status, etiqueta) => {
    const r = respuesta();

    new TboHotelsExceptionFilter().catch(err, r.host);

    expect(r.status).toHaveBeenCalledWith(status);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: status, error: etiqueta }),
    );
  });

  it('el log es `toLogMeta()` y nada más: ni el `message` ni un cuerpo', () => {
    const err = new TboApiError({
      status: 401,
      path: TBO_OPERATIONS.search.path,
      kind: 'CREDENTIALS_INVALID',
      requestId: 'req-401',
    });

    new TboHotelsExceptionFilter().catch(err, respuesta().host);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(JSON.stringify(err.toLogMeta()));
  });
});
