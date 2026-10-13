import { describe, expect, it } from 'vitest';
import { humanizeLatamError } from './latam-ndc-errors.js';

describe('humanizeLatamError', () => {
  it('error de red/timeout (status 0) → no pudimos conectar', () => {
    expect(humanizeLatamError(0, 'timeout')).toContain('conectar');
    expect(humanizeLatamError(0, 'fetch failed')).toContain('conectar');
  });

  it('5xx → problema interno', () => {
    expect(humanizeLatamError(502, 'Bad Gateway')).toContain('problema interno');
  });

  it('401/credenciales/config faltante → credenciales LATAM', () => {
    expect(humanizeLatamError(401, 'apiKey and apiSecret required')).toContain('credenciales');
    expect(humanizeLatamError(403, '{"error":"unauthorized"}')).toContain('credenciales');
    expect(humanizeLatamError(400, '{"error":"invalid_client"}')).toContain('credenciales');
  });

  it('missing agent / 403111009 → Travel Agent ID', () => {
    expect(humanizeLatamError(400, 'missing agent info')).toContain('Travel Agent ID');
    expect(humanizeLatamError(400, 'error 403111009')).toContain('Travel Agent ID');
  });

  it('los textos van en tú, sin voseo', () => {
    expect(humanizeLatamError(0, 'timeout')).toBe(
      'No pudimos conectar con LATAM. Prueba de nuevo en unos segundos.',
    );
    expect(humanizeLatamError(502, 'Bad Gateway')).toBe(
      'LATAM tuvo un problema interno. Prueba de nuevo en unos minutos.',
    );
    expect(humanizeLatamError(401, 'unauthorized')).toContain(
      'Verifícalas en Mi Red → Credenciales → LATAM NDC.',
    );
    expect(humanizeLatamError(400, 'missing agent info')).toContain(
      'Cárgalo en Mi Red → Credenciales → LATAM NDC y reintenta.',
    );
    expect(humanizeLatamError(400, 'x'.repeat(200))).toBe(
      'No pudimos procesar la solicitud con LATAM. Revisa los datos e inténtalo nuevamente.',
    );
  });

  it('detalle corto desconocido se muestra al agente', () => {
    expect(humanizeLatamError(400, '{"message":"Invalid segment"}')).toContain('Invalid segment');
  });
});
