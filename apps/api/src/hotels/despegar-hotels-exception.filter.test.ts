import { HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import { FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants';
import { DespegarApiError } from '@sales-travel/despegar-hotels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanizeDespegarError } from './despegar-hotels-errors.js';
import { DespegarHotelsExceptionFilter } from './despegar-hotels-exception.filter.js';

/**
 * Qué ve el vendedor cuando Despegar falla (PR-0.1).
 *
 * El filtro es la última frontera entre el error crudo del proveedor y la pantalla: el status,
 * el path y el cuerpo de Despegar se quedan en el log; al cliente sólo le llega un 502 con un
 * mensaje accionable.
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

function cuerpoEnviado(r: Respuesta): unknown {
  return r.json.mock.calls[0]?.[0];
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DespegarHotelsExceptionFilter', () => {
  it('sólo atrapa `DespegarApiError`', () => {
    // El 503 del catálogo vacío o del breaker y el 403 de la cuota NO pasan por aquí: salen por
    // el filtro global (`AllExceptionsFilter`, registrado en `main.ts`).
    const atrapa: unknown = Reflect.getMetadata(
      FILTER_CATCH_EXCEPTIONS,
      DespegarHotelsExceptionFilter,
    );
    expect(atrapa).toEqual([DespegarApiError]);
  });

  it.each([
    [0, 'fetch failed', 'conectar'],
    [503, 'Service Unavailable', 'problema interno'],
    [401, '{"message":"unauthorized"}', 'credenciales'],
    [410, '{"message":"product expired"}', 'venció'],
    [400, '{"message":"Invalid checkinDate"}', 'Invalid checkinDate'],
    [400, '{"error":"invalid_distribution"}', 'invalid_distribution'],
    [400, '{"description":"Hotel en remodelación"}', 'Hotel en remodelación'],
  ])(
    'Despegar %i → 502 con el mensaje humanizado (%s)',
    (status: number, body: string, pista: string) => {
      const r = respuesta();
      new DespegarHotelsExceptionFilter().catch(
        new DespegarApiError(status, body, '/hotels-api/availability'),
        r.host,
      );

      expect(r.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
      expect(cuerpoEnviado(r)).toEqual({
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'Bad Gateway',
        message: humanizeDespegarError(status, body),
      });
      expect(JSON.stringify(cuerpoEnviado(r))).toContain(pista);
    },
  );

  it('al cliente no le llegan ni el status, ni el path, ni el cuerpo crudo de Despegar', () => {
    const r = respuesta();
    const crudo = `{"trace":"traza-interna-7781","detail":"${'x'.repeat(300)}"}`;
    new DespegarHotelsExceptionFilter().catch(new DespegarApiError(422, crudo, '/book'), r.host);

    const enviado = JSON.stringify(cuerpoEnviado(r));
    expect(enviado).not.toContain('traza-interna-7781');
    expect(enviado).not.toContain('/book');
    expect(enviado).not.toContain('422');
    expect(Object.keys(cuerpoEnviado(r) as object).sort()).toEqual([
      'error',
      'message',
      'statusCode',
    ]);
  });

  it('el detalle técnico va al log: status, path y como mucho 250 caracteres del cuerpo', () => {
    // Fijado tal cual. El cuerpo de Despegar puede traer datos del huésped; recortarlo o
    // quitarlo del log tiene que ser un cambio deliberado de este test.
    const r = respuesta();
    const cuerpo = 'A'.repeat(400);
    new DespegarHotelsExceptionFilter().catch(
      new DespegarApiError(500, cuerpo, '/prebook'),
      r.host,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`500 /prebook: ${'A'.repeat(250)}`);
  });
});
