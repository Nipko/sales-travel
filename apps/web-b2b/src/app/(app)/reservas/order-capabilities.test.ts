import { describe, expect, it } from 'vitest';
import {
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
