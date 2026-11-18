import { describe, expect, it } from 'vitest';
import {
  DESPEGAR_CODE_MESSAGES,
  humanizeCancelNotAllowed,
  humanizeDespegarCode,
  humanizeDespegarError,
} from './despegar-hotels-errors.js';

describe('humanizeDespegarError', () => {
  it('error de red (status 0) → no pudimos conectar', () => {
    expect(humanizeDespegarError(0, 'fetch failed')).toContain('conectar');
  });

  it('timeout (status 0) → no pudimos conectar', () => {
    expect(humanizeDespegarError(0, 'timeout')).toContain('conectar');
  });

  it('5xx → problema interno del proveedor', () => {
    expect(humanizeDespegarError(503, 'Service Unavailable')).toContain('problema interno');
  });

  it('401/403/apikey → credenciales', () => {
    expect(humanizeDespegarError(401, '{"message":"unauthorized"}')).toContain('credenciales');
    expect(humanizeDespegarError(403, '{"message":"invalid apikey"}')).toContain('API key');
  });

  it('410/vencimiento → vuelve a buscar', () => {
    expect(humanizeDespegarError(410, '{"message":"product expired"}')).toContain('venció');
    expect(humanizeDespegarError(409, '{"message":"room sold out"}')).toContain('venció');
  });

  it('detalle corto desconocido se muestra al agente', () => {
    expect(humanizeDespegarError(400, '{"message":"Invalid checkinDate"}')).toContain(
      'Invalid checkinDate',
    );
  });

  it('body no-JSON largo → mensaje genérico', () => {
    expect(humanizeDespegarError(400, '<html>'.repeat(60))).toContain('No pudimos procesar');
  });
});

describe('códigos de HotelDO (certificación, punto 11)', () => {
  it.each(Object.keys(DESPEGAR_CODE_MESSAGES))('%s tiene su mensaje', (code) => {
    expect(humanizeDespegarCode(code)).toBe(DESPEGAR_CODE_MESSAGES[code]);
    expect(humanizeDespegarCode(code.toLowerCase())).toBe(DESPEGAR_CODE_MESSAGES[code]);
  });

  it('sin código o con uno desconocido no inventa', () => {
    expect(humanizeDespegarCode(undefined)).toBeUndefined();
    expect(humanizeDespegarCode('ALGO_NUEVO')).toBeUndefined();
  });

  it('el código manda sobre el texto, y `error_code` también cuenta', () => {
    expect(humanizeDespegarError(400, '{"code":"NOT_ENOUGH_BALANCE","message":"x"}')).toContain(
      'saldo',
    );
    expect(humanizeDespegarError(400, '{"error_code":"PRODUCT_GONE"}')).toContain('ya no está');
    expect(humanizeDespegarError(400, '{"code":42,"message":"Hotel cerrado"}')).toContain(
      'Hotel cerrado',
    );
  });

  it('un 429 es el cupo de la cuenta', () => {
    expect(humanizeDespegarError(429, '')).toContain('limitando');
  });
});

describe('cancelación no permitida', () => {
  it.each([
    ['ALREADY_CANCELLED', 'ya está cancelada'],
    ['cancel_in_process', 'en curso'],
    ['CHANGE_IN_PROGRESS', 'cambio en curso'],
    ['INVALID_MINIMUM_HOURS', 'plazo mínimo'],
    ['AFTERSALE_NOT_ALLOWED', 'no permite cancelar esta reserva por la API'],
  ])('%s → %s', (reason, pista) => {
    expect(humanizeCancelNotAllowed(reason)).toContain(pista);
  });

  it('sin motivo o con uno desconocido, el genérico que sugiere esperar', () => {
    expect(humanizeCancelNotAllowed(undefined)).toContain('espera un minuto');
    expect(humanizeCancelNotAllowed('OTRO')).toContain('espera un minuto');
  });
});
