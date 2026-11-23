import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { DespegarActivitiesInputError } from '@sales-travel/despegar-activities';
import { DespegarApiError, DespegarCancelNotAllowedError } from '@sales-travel/despegar-hotels';
import { describe, expect, it, vi } from 'vitest';
import { DespegarActivitiesNotConfiguredError } from '../providers-despegar/despegar-activities.factory.js';
import { DespegarActivitiesExceptionFilter } from './activities-exception.filter.js';
import {
  ACTIVITY_ERROR_CODES,
  mapActivityBookError,
  mapActivityError,
} from './activities-errors.js';

describe('mapa de errores de actividades', () => {
  it.each([
    [400, 'INVALID_FIELD', HttpStatus.BAD_REQUEST],
    [400, 'MISSING_REQUIRED_PARAMETER', HttpStatus.BAD_REQUEST],
    [410, 'PRODUCT_GONE', HttpStatus.CONFLICT],
    [400, 'NOT_ENOUGH_BALANCE', HttpStatus.PAYMENT_REQUIRED],
    [400, 'PAYMENT_ERROR', HttpStatus.PAYMENT_REQUIRED],
    [400, 'ALREADY_BOOKED', HttpStatus.CONFLICT],
    [503, 'ACTIVITY_PROVIDER_ERROR', HttpStatus.NOT_FOUND],
    [401, 'UNAUTHORIZED', HttpStatus.BAD_GATEWAY],
  ])('%i %s → %i', (status, code, expected) => {
    expect(mapActivityError(status, code).status).toBe(expected);
  });

  it('ACTIVITY_PROVIDER_ERROR fuera de un 503 (shopping lo manda como 400) no es "sin cupo"', () => {
    const m = mapActivityError(400, 'ACTIVITY_PROVIDER_ERROR');
    expect(m.status).toBe(HttpStatus.BAD_REQUEST);
    expect(m.message).not.toContain('disponibilidad');
  });

  it('el 403 de hoy explica que falta el permiso de actividades', () => {
    expect(mapActivityError(403, undefined).message).toContain('habilitadas las actividades');
  });

  it('sin respuesta (red) o 5xx desconocido: Despegar no responde', () => {
    expect(mapActivityError(0, undefined)).toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    expect(mapActivityError(500, 'INTERNAL_ERROR').message).toContain('no responde');
  });

  it('book en ERROR por sub_status', () => {
    expect(mapActivityBookError('INSUFFICIENT_FUNDS').status).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(mapActivityBookError('DUPLICATED_RESERVATION').status).toBe(HttpStatus.CONFLICT);
    expect(mapActivityBookError(undefined).status).toBe(HttpStatus.BAD_GATEWAY);
  });

  it('todos los mensajes tutean (sin voseo)', () => {
    for (const { message } of Object.values(ACTIVITY_ERROR_CODES)) {
      expect(message).not.toMatch(/\b(probá|revisá|volvé|intentá|pedí)\b/i);
    }
  });
});

describe('DespegarActivitiesExceptionFilter', () => {
  function run(err: Error) {
    const json = vi.fn();
    const status = vi.fn((_code: number) => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    new DespegarActivitiesExceptionFilter().catch(err, host);
    return {
      status: status.mock.calls[0]?.[0] as number,
      body: json.mock.calls[0]?.[0] as Record<string, unknown>,
    };
  }

  it('un error de Despegar sale con el mensaje y el code, nunca con el cuerpo', () => {
    const body = JSON.stringify({
      code: 'NOT_ENOUGH_BALANCE',
      message: 'balance of maria@example.com',
    });
    const out = run(new DespegarApiError(400, body, '/book'));
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ providerCode: 'NOT_ENOUGH_BALANCE' });
    expect(JSON.stringify(out.body)).not.toContain('maria@example.com');
  });

  it('cancelación no permitida → 409 con el motivo legible', () => {
    const out = run(
      new DespegarCancelNotAllowedError({
        productId: '1',
        allowance: 'DISALLOWED',
        disallowedReason: 'ALREADY_CANCELLED',
      }),
    );
    expect(out.status).toBe(409);
    expect(typeof out.body['message']).toBe('string');
  });

  it('sin cuenta de Despegar → 503; parque inválido → 400', () => {
    expect(run(new DespegarActivitiesNotConfiguredError()).status).toBe(503);
    expect(run(new DespegarActivitiesInputError('XX no es un parque')).status).toBe(400);
  });
});
