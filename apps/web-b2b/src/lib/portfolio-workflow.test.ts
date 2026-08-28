import { describe, expect, it } from 'vitest';
import { PORTFOLIO_ISSUANCE, PORTFOLIO_REJECTION } from './portfolio-workflow';

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
