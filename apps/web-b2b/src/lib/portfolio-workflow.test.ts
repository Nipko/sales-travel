import { describe, expect, it } from 'vitest';
import {
  PORTFOLIO_ISSUANCE,
  PORTFOLIO_REJECTION,
  PORTFOLIO_RELEASE_RETRY,
  rejectionFailure,
} from './portfolio-workflow';

describe('contrato visible del flujo de cartera', () => {
  it('no ofrece emisión mientras no exista fulfillment real', () => {
    expect(PORTFOLIO_ISSUANCE.enabled).toBe(false);
    expect(PORTFOLIO_ISSUANCE.label).toBe('Emisión no disponible');
    expect(PORTFOLIO_ISSUANCE.description).toContain('operación real del proveedor');
  });

  it('explica que la cancelación del proveedor precede a liberar el saldo', () => {
    expect(PORTFOLIO_REJECTION.description).toContain('Primero');
    expect(PORTFOLIO_REJECTION.description).toContain('sólo se libera');
    expect(PORTFOLIO_REJECTION.success).toContain('confirmada por el proveedor');
  });
});

describe('cuando "Cancelar y liberar" no termina', () => {
  it('el proveedor ya canceló y las carteras están ocupadas: nunca dice "no se canceló"', () => {
    const f = rejectionFailure(
      409,
      'PORTFOLIO_RELEASE_BUSY',
      'Tu red está procesando otras reservas en este momento y todavía no se liberó el saldo retenido de esta reserva.',
    );
    expect(f.kind).toBe('release-pending');
    expect(f.title).toBe(
      'La reserva quedó cancelada con el proveedor; falta liberar el saldo retenido.',
    );
    expect(`${f.title} ${f.description}`).not.toMatch(/no se canceló/i);
    expect(f.description).toContain(PORTFOLIO_RELEASE_RETRY.label);
  });

  it('terminar de liberar no vuelve a llamar al proveedor', () => {
    expect(PORTFOLIO_RELEASE_RETRY.description).toContain('No se vuelve a llamar al proveedor');
  });

  it('una retención que quedó como cargo pide conciliación, con el texto del API', () => {
    const f = rejectionFailure(
      409,
      'PORTFOLIO_HOLD_STATE_CONFLICT',
      'Requiere conciliación manual.',
    );
    expect(f).toEqual({
      kind: 'conflict',
      title: 'El saldo retenido no se liberó: requiere conciliación.',
      description: 'Requiere conciliación manual.',
    });
  });

  it('un 400 es de antes del proveedor: la reserva no se canceló', () => {
    expect(
      rejectionFailure(400, undefined, 'El proveedor no confirmó la cancelación.'),
    ).toMatchObject({ kind: 'not-cancelled', title: 'No se canceló la reserva.' });
  });

  it('cualquier otra cosa: no se sabe, que revise la reserva antes de reintentar', () => {
    const f = rejectionFailure(500, undefined, '');
    expect(f.kind).toBe('unknown');
    expect(f.description).toBe('Revisá la reserva en Mis Reservas antes de reintentar.');
  });
});
