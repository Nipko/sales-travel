import { describe, expect, it } from 'vitest';
import { pendingOrderReconciliationMessage } from './pending-order-reconciliation';

describe('pendingOrderReconciliationMessage', () => {
  it('expone el marker de una creación pending sin referencia del proveedor', () => {
    expect(
      pendingOrderReconciliationMessage({
        status: 'pending',
        pnr: null,
        errorMessage: '  Creación pendiente de conciliación. No reenviar.  ',
      }),
    ).toBe('Creación pendiente de conciliación. No reenviar.');
  });

  it.each([
    { status: 'confirmed', pnr: null, errorMessage: 'marker' },
    { status: 'pending', pnr: 'ABC123', errorMessage: 'marker' },
    { status: 'pending', pnr: null, errorMessage: null },
    { status: 'pending', pnr: null, errorMessage: '   ' },
  ])('no muestra falsos positivos: %o', (order) => {
    expect(pendingOrderReconciliationMessage(order)).toBeNull();
  });
});
