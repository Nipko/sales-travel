import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_STILL_RUNNING,
  hotelCancellationBlock,
  hotelCancelOutcomeOf,
  parseCancellationEstimate,
  penaltyViewOf,
  type HotelCancellationEstimate,
} from './hotel-cancellation-view';
import type { OrderOperationView } from './cancel-retry-policy';

/**
 * U-17 y RF-25 del lado de la pantalla: la penalidad estimada antes de confirmar, siempre en el
 * precio de VENTA (nunca el neto del proveedor, G3), y la respuesta del pedido leída como la lee el
 * API: un `200` es "aceptada" y el estado final lo dice `settlement` (D-TBO-25 A).
 */

const NETO = { amountMinor: 30000, currency: 'USD' };
const VENTA = { amountMinor: 36000, currency: 'USD' };

function estimada(over: Partial<Extract<HotelCancellationEstimate, { kind: 'estimated' }>> = {}) {
  return {
    kind: 'estimated' as const,
    penalty: { amountMinor: 15000, currency: 'USD' },
    base: NETO,
    basis: 'charged' as const,
    policySource: 'prebook-final',
    conservative: false,
    checkInReached: false,
    ...over,
  };
}

describe('parseCancellationEstimate', () => {
  it('lee la respuesta del API', () => {
    expect(
      parseCancellationEstimate({
        orderId: 'x',
        estimate: {
          kind: 'estimated',
          penalty: { amountMinor: 15000, currency: 'USD' },
          base: NETO,
          basis: 'charged',
          policySource: 'prebook-final',
          clock: 'widest-offset',
          conservative: true,
          checkInReached: false,
        },
      }),
    ).toEqual(estimada({ conservative: true }));
    expect(
      parseCancellationEstimate({ estimate: { kind: 'unavailable', reason: 'no-policy' } }),
    ).toEqual({ kind: 'unavailable', reason: 'no-policy' });
  });

  it('sin la marca, lo que no se sabe se toma del lado que avisa de más', () => {
    const e = parseCancellationEstimate({
      estimate: { kind: 'estimated', penalty: NETO, base: NETO, basis: 'charged' },
    });
    expect(e).toMatchObject({ conservative: true, checkInReached: false });
  });

  it('una forma que no se entiende no es una estimación', () => {
    expect(
      parseCancellationEstimate({ estimate: { kind: 'estimated', basis: 'x' } }),
    ).toBeUndefined();
    expect(parseCancellationEstimate({ estimate: { kind: 'otra' } })).toBeUndefined();
    expect(parseCancellationEstimate(null)).toBeUndefined();
  });
});

describe('penaltyViewOf — en el precio de venta, nunca el neto', () => {
  it('con cargo: la misma proporción del neto aplicada a la venta, con "≈"', () => {
    const view = penaltyViewOf(estimada(), VENTA);
    expect(view.headline).toBe(
      `≈ ${new Intl.NumberFormat('es', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(180)}`,
    );
    expect(view.tone).toBe('charged');
    expect(view.requiresAcknowledgement).toBe(true);
    expect(view.notes[0]).toMatch(/50 % del total/);
    // Ni el neto ni la penalidad neta aparecen en ninguna parte.
    const all = [view.headline, ...view.notes].join(' ');
    expect(all).not.toMatch(/300,00|150,00/);
  });

  it('no reembolsable: el total de la venta', () => {
    const view = penaltyViewOf(estimada({ basis: 'non-refundable', penalty: NETO }), VENTA);
    expect(view.headline).toMatch(/360,00/);
    expect(view.headline).toMatch(/el total/);
    expect(view.requiresAcknowledgement).toBe(true);
  });

  it('sin cargo: no pide aceptar nada', () => {
    const view = penaltyViewOf(
      estimada({ basis: 'free', penalty: { amountMinor: 0, currency: 'USD' } }),
      VENTA,
    );
    expect(view).toMatchObject({
      headline: 'Sin cargo',
      tone: 'free',
      requiresAcknowledgement: false,
    });
  });

  it('conservadora y con políticas no finales: lo dice', () => {
    const view = penaltyViewOf(
      estimada({ conservative: true, policySource: 'search-indicative' }),
      VENTA,
    );
    expect(view.notes.join(' ')).toMatch(/más alto que puede estar vigente/);
    expect(view.notes.join(' ')).toMatch(/no es la que el proveedor confirmó/);
  });

  it('otra moneda: hay cargo, sin inventar el importe', () => {
    const view = penaltyViewOf(estimada({ penalty: { amountMinor: 100, currency: 'EUR' } }), VENTA);
    expect(view.headline).toBe('Con cargo');
  });

  it('desde el día de entrada no se cancela desde acá (PV-22)', () => {
    expect(penaltyViewOf(estimada({ checkInReached: true }), VENTA).blocked).toMatch(/soporte/);
    expect(penaltyViewOf(estimada(), VENTA).blocked).toBeUndefined();
  });

  it('sin estimación: lo dice y pide aceptar el cargo que defina el proveedor', () => {
    const view = penaltyViewOf({ kind: 'unavailable', reason: 'no-snapshot' }, VENTA);
    expect(view).toMatchObject({ tone: 'unknown', requiresAcknowledgement: true });
    expect(view.notes[0]).toMatch(/no guarda la política/);
  });
});

describe('hotelCancelOutcomeOf — un 200 es "aceptada", no "cancelada" (RF-25)', () => {
  it('final: cancelada; con el reembolso del proveedor pendiente, lo dice', () => {
    expect(
      hotelCancelOutcomeOf(200, { success: true, settlement: 'final', warnings: [] }).kind,
    ).toBe('cancelled');
    expect(
      hotelCancelOutcomeOf(200, { success: true, warnings: [], refundAwaited: true }).message,
    ).toMatch(/reembolso/);
  });

  it('aceptada sin terminar, o el presupuesto de la petición agotado: "Cancelación en curso"', () => {
    expect(
      hotelCancelOutcomeOf(200, { success: true, settlement: 'in-progress', warnings: [] }),
    ).toMatchObject({ kind: 'in-progress', title: 'Cancelación en curso' });
    expect(
      hotelCancelOutcomeOf(200, {
        success: true,
        settlement: 'in-progress',
        warnings: [CANCELLATION_STILL_RUNNING],
      }).message,
    ).toMatch(/tardando/);
  });

  it('rechazada por el proveedor: la reserva sigue vigente', () => {
    expect(hotelCancelOutcomeOf(200, { success: false, warnings: [] })).toMatchObject({
      kind: 'rejected',
    });
  });

  it('sin respuesta: no sabemos, y nunca se ofrece repetirla', () => {
    for (const status of [0, 408, 500, 502, 504, 524]) {
      const outcome = hotelCancelOutcomeOf(status, {});
      expect(outcome.kind).toBe('unknown');
      expect(outcome.message).toMatch(/No la vuelvas a cancelar/);
    }
    expect(hotelCancelOutcomeOf(200, { algo: true }).kind).toBe('unknown');
  });

  it('un error del servidor con su mensaje, sin afirmar que no salió', () => {
    const outcome = hotelCancelOutcomeOf(409, {
      error:
        'El proveedor no confirmó si la cancelación se aplicó. No la reintentes: primero hay que consultar y conciliar la reserva.',
    });
    expect(outcome).toMatchObject({ kind: 'error', title: 'La cancelación no se completó' });
    expect(outcome.message).toMatch(/no confirmó si la cancelación se aplicó/);
  });
});

describe('hotelCancellationBlock — el reintento pasa por la penalidad y el bloqueo (RF-25)', () => {
  function cancelacion(over: Partial<OrderOperationView> = {}): OrderOperationView {
    return {
      id: 'op-1',
      type: 'cancel',
      status: 'failed',
      attempts: 1,
      last_error: null,
      created_at: '2026-10-01T15:00:00.000Z',
      retryable: true,
      outcome: 'FAILED',
      reconciliationRequired: false,
      ...over,
    };
  }

  it('una cancelación nueva se bloquea igual que antes: el fallo previo se reintenta', () => {
    expect(hotelCancellationBlock([])).toBeNull();
    expect(hotelCancellationBlock([cancelacion()])).toMatch(/Reintentar/);
  });

  it('el reintento del último intento reintentable no tiene bloqueo', () => {
    expect(hotelCancellationBlock([cancelacion()], 'op-1')).toBeNull();
  });

  it('un intento que ya no es el último, o que dejó de ser reintentable, no se reintenta', () => {
    expect(hotelCancellationBlock([cancelacion({ id: 'op-2' }), cancelacion()], 'op-1')).toMatch(
      /ya no se puede reintentar/,
    );
    expect(hotelCancellationBlock([], 'op-1')).toMatch(/ya no se puede reintentar/);
    expect(
      hotelCancellationBlock(
        [cancelacion({ outcome: 'UNVERIFIED', retryable: false, reconciliationRequired: true })],
        'op-1',
      ),
    ).toMatch(/no confirmó/);
    expect(
      hotelCancellationBlock([cancelacion({ status: 'success', outcome: 'SUCCEEDED' })], 'op-1'),
    ).toMatch(/ya no se puede reintentar/);
  });
});
