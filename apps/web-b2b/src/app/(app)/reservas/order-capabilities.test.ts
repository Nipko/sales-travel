import { describe, expect, it } from 'vitest';
import {
  cancellationInProgress,
  supportsOrderCancellation,
  supportsOrderCapability,
  type OrderCapabilities,
} from './order-capabilities';

describe('supportsOrderCapability', () => {
  it('falla cerrada cuando el API no entregó capabilities', () => {
    expect(supportsOrderCapability(undefined, 'pay')).toBe(false);
  });

  it('respeta el perfil Sabre: retrieve/cancel sí; emisión, servicios y reshop no', () => {
    const sabre: OrderCapabilities = {
      retrieve: true,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
    };

    expect(supportsOrderCapability(sabre, 'retrieve')).toBe(true);
    expect(supportsOrderCapability(sabre, 'cancel')).toBe(true);
    expect(supportsOrderCapability(sabre, 'pay')).toBe(false);
    expect(supportsOrderCapability(sabre, 'services')).toBe(false);
    expect(supportsOrderCapability(sabre, 'reshop')).toBe(false);
    expect(supportsOrderCancellation(sabre, 'confirmed')).toBe(true);
    expect(supportsOrderCancellation(sabre, 'ticketed')).toBe(false);
  });
});

describe('cancelación de hotel en curso (D-TBO-25 A)', () => {
  const hotel: OrderCapabilities = {
    retrieve: true,
    cancel: true,
    pay: false,
    services: false,
    reshop: false,
  };

  it('el claim tomado o el desenlace sin verificar bloquean otra cancelación', () => {
    for (const subStatus of ['cancel-requested', 'cancel-unverified']) {
      expect(cancellationInProgress({ subStatus })).toBe(true);
      expect(supportsOrderCancellation(hotel, 'pending', { subStatus })).toBe(false);
    }
  });

  it('también el estado del proveedor de una cancelación que aceptó y todavía procesa', () => {
    for (const providerStatus of [
      'CancellationInProgress',
      'CancelPending',
      'CxlRequestSentToHotel',
    ]) {
      expect(supportsOrderCancellation(hotel, 'pending', { subStatus: null, providerStatus })).toBe(
        false,
      );
    }
  });

  it('una reserva vigente, con o sin seguimiento, se puede cancelar', () => {
    expect(supportsOrderCancellation(hotel, 'confirmed', null)).toBe(true);
    expect(
      supportsOrderCancellation(hotel, 'confirmed', {
        subStatus: null,
        providerStatus: 'Confirmed',
      }),
    ).toBe(true);
    expect(cancellationInProgress(undefined)).toBe(false);
  });
});
