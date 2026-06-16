import { describe, expect, it } from 'vitest';
import { humanizeAgentCarsError } from './agent-cars-errors.js';

describe('humanizeAgentCarsError', () => {
  it('source country blank (el caso real 412) → mensaje de configuración de POS', () => {
    const body =
      '{"error":"Error Loading data: {\\"source\\":[\\"Source Country cannot be blank.\\"]}"}';
    const msg = humanizeAgentCarsError(412, body);
    expect(msg).toContain('país de origen');
    expect(msg).toContain('AGENT_CARS_SOURCE');
  });

  it('error de red (status 0) → no pudimos conectar', () => {
    expect(humanizeAgentCarsError(0, 'fetch failed')).toContain('conectar');
  });

  it('5xx → problema interno del proveedor', () => {
    expect(humanizeAgentCarsError(503, 'Service Unavailable')).toContain('problema interno');
  });

  it('401/token → credenciales', () => {
    expect(humanizeAgentCarsError(401, '{"error":"unauthorized"}')).toContain('credenciales');
    expect(humanizeAgentCarsError(412, '{"error":"Access token invalid"}')).toContain(
      'credenciales',
    );
  });

  it('uniqid/sesión expirada → volver a buscar', () => {
    expect(humanizeAgentCarsError(412, '{"error":"uniqid expired"}')).toContain('expiró');
  });

  it('tarifa/disponibilidad → ya no disponible', () => {
    expect(humanizeAgentCarsError(412, '{"error":"rate not available"}')).toContain('disponible');
  });

  it('detalle corto desconocido se muestra al agente', () => {
    expect(humanizeAgentCarsError(400, '{"error":"Invalid pickUpDate format"}')).toContain(
      'Invalid pickUpDate format',
    );
  });
});
