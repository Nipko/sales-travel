import { describe, expect, it } from 'vitest';
import {
  createOrderReconciliationView,
  createOrderTransportFailureView,
  isAmbiguousCreateHttpStatus,
  shouldShowBookingForm,
  type BookingOutcomeView,
} from './create-order-reconciliation';

describe('createOrderReconciliationView', () => {
  it('convierte una creación no conciliada en UNCERTAIN y conserva las referencias seguras', () => {
    const view = createOrderReconciliationView({
      reconciliationRequired: true,
      retryForbidden: true,
      orderId: 'order-local-1',
      providerResult: { outcome: 'CONFIRMED', pnr: 'ABC123' },
      error: 'texto libre que no debe llegar a la pantalla',
    });

    expect(view).toEqual({
      outcome: 'UNCERTAIN',
      orderId: 'order-local-1',
      pnr: 'ABC123',
      error:
        'No volver a reservar esta cotización. La creación quedó pendiente de conciliación con el proveedor. Revisa la reserva local order-local-1.',
    });
    expect(view?.error).not.toContain('texto libre');
  });

  it.each([{ reconciliationRequired: true }, { retryForbidden: true }])(
    'falla cerrado si cualquiera de las dos compuertas está activa: %o',
    (body) => {
      expect(createOrderReconciliationView(body)?.outcome).toBe('UNCERTAIN');
    },
  );

  it('no convierte un rechazo ordinario en incierto', () => {
    expect(
      createOrderReconciliationView({
        reconciliationRequired: false,
        retryForbidden: false,
        error: 'petición inválida',
      }),
    ).toBeNull();
  });

  it('un CONFIRMED sólo se muestra como tal si el saga terminó settled/confirmed', () => {
    expect(
      createOrderReconciliationView({
        order: { id: 'order-local-2' },
        providerResult: { outcome: 'CONFIRMED', pnr: 'XYZ789' },
        saga: { kind: 'escalate', status: 'pending', reason: 'verification-unavailable' },
      }),
    ).toMatchObject({
      outcome: 'UNCERTAIN',
      orderId: 'order-local-2',
      pnr: 'XYZ789',
    });

    expect(
      createOrderReconciliationView({
        providerResult: { outcome: 'CONFIRMED', pnr: 'XYZ789' },
        saga: { kind: 'settled', status: 'confirmed' },
      }),
    ).toBeNull();
  });

  it('FAILED sólo habilita otro create si el saga terminó settled/failed', () => {
    expect(createOrderReconciliationView({ providerResult: { outcome: 'FAILED' } })?.outcome).toBe(
      'UNCERTAIN',
    );
    expect(
      createOrderReconciliationView({
        providerResult: { outcome: 'FAILED' },
        saga: { kind: 'settled', status: 'failed' },
      }),
    ).toBeNull();
    expect(
      createOrderReconciliationView({
        providerResult: { outcome: 'PARTIAL' },
        saga: { kind: 'compensate', status: 'pending' },
      }),
    ).toBeNull();
  });
});

describe('fallos de transporte después del POST', () => {
  it('un 504 HTML o un error de red queda UNCERTAIN y no vuelve a abrir el formulario', () => {
    const view = createOrderTransportFailureView();

    expect(isAmbiguousCreateHttpStatus(504)).toBe(true);
    expect(isAmbiguousCreateHttpStatus(502)).toBe(true);
    expect(view.outcome).toBe('UNCERTAIN');
    expect(view.error).toMatch(/No volver a reservar/i);
    expect(shouldShowBookingForm(view)).toBe(false);
  });
});

describe('shouldShowBookingForm', () => {
  const result = (outcome: BookingOutcomeView['outcome']): BookingOutcomeView => ({ outcome });

  it('oculta el formulario ante un desenlace incierto', () => {
    expect(shouldShowBookingForm(result('UNCERTAIN'))).toBe(false);
  });

  it('sólo lo vuelve a ofrecer cuando no hubo intento o el proveedor confirmó FAILED', () => {
    expect(shouldShowBookingForm(null)).toBe(true);
    expect(shouldShowBookingForm(result('FAILED'))).toBe(true);
    expect(shouldShowBookingForm(result('PENDING'))).toBe(false);
    expect(shouldShowBookingForm(result('PARTIAL'))).toBe(false);
    expect(shouldShowBookingForm(result('CONFIRMED'))).toBe(false);
  });
});
