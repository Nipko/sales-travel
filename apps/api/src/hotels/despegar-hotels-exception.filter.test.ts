import { HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import { FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants';
import {
  DespegarApiError,
  DespegarCancelNotAllowedError,
  DespegarReservationNotFoundError,
} from '@sales-travel/despegar-hotels';
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
  it('sólo atrapa los errores de Despegar', () => {
    // El 503 del catálogo vacío o del breaker y el 403 de la cuota NO pasan por aquí: salen por
    // el filtro global (`AllExceptionsFilter`, registrado en `main.ts`).
    const atrapa: unknown = Reflect.getMetadata(
      FILTER_CATCH_EXCEPTIONS,
      DespegarHotelsExceptionFilter,
    );
    expect(atrapa).toEqual([
      DespegarApiError,
      DespegarCancelNotAllowedError,
      DespegarReservationNotFoundError,
    ]);
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

  it('al log van el status, el path y el `code` de Despegar: NUNCA el cuerpo', () => {
    // Cambio deliberado (2026-11-18): el Book y `/reservations` devuelven nombres, email y
    // documentos, y el cuerpo recortado los llevaba al log.
    const r = respuesta();
    const cuerpo = `{"code":"INVALID_FIELD","message":"Ana Prueba ${'A'.repeat(300)}"}`;
    new DespegarHotelsExceptionFilter().catch(new DespegarApiError(400, cuerpo, '/book'), r.host);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('400 /book INVALID_FIELD');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Ana Prueba');
  });

  it('un código de HotelDO conocido sale con su mensaje (certificación, punto 11)', () => {
    const r = respuesta();
    new DespegarHotelsExceptionFilter().catch(
      new DespegarApiError(400, '{"code":"INVALID_PREBOOK_ID","message":"x"}', '/book'),
      r.host,
    );
    expect(JSON.stringify(cuerpoEnviado(r))).toContain('pre-reserva venció');
  });

  it('cancelación no permitida por Despegar → 409 con el motivo', () => {
    const r = respuesta();
    new DespegarHotelsExceptionFilter().catch(
      new DespegarCancelNotAllowedError({
        productId: 'P-1',
        allowance: 'DISALLOWED',
        disallowedReason: 'ALREADY_CANCELLED',
      }),
      r.host,
    );
    expect(r.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(JSON.stringify(cuerpoEnviado(r))).toContain('ya está cancelada');
  });

  it('reserva que todavía no aparece en post-venta → 404', () => {
    const r = respuesta();
    new DespegarHotelsExceptionFilter().catch(new DespegarReservationNotFoundError(), r.host);
    expect(r.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });
});

describe('DespegarHotelsExceptionFilter — cancelación sin motivo', () => {
  it('sin `disallowed_reason` loguea sólo la habilitación', () => {
    const r = respuesta();
    new DespegarHotelsExceptionFilter().catch(
      new DespegarCancelNotAllowedError({ productId: 'P-1', allowance: 'UNKNOWN' }),
      r.host,
    );
    expect(warn).toHaveBeenCalledWith('cancelación no permitida: UNKNOWN');
    expect(r.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });
});

describe('DespegarHotelsExceptionFilter — reserva inexistente (QA-H-30)', () => {
  it('«Booking does not exist» es un 404 del pedido, no un 502 del proveedor', () => {
    const r = respuesta();
    const body = JSON.stringify({ message: 'Booking does not exist or wrong reservation id' });
    new DespegarHotelsExceptionFilter().catch(
      new DespegarApiError(400, body, '/reservations/999999999'),
      r.host,
    );
    expect(r.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(JSON.stringify(cuerpoEnviado(r))).not.toContain('wrong reservation id');
  });

  it('un 404 de Despegar también sale como 404', () => {
    const r = respuesta();
    new DespegarHotelsExceptionFilter().catch(
      new DespegarApiError(404, '', '/reservations/1'),
      r.host,
    );
    expect(r.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });
});
