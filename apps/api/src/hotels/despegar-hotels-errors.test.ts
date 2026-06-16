import { describe, expect, it } from 'vitest';
import { humanizeDespegarError } from './despegar-hotels-errors.js';

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

  it('410/vencimiento → volvé a buscar', () => {
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
