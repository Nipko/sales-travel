import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { OrderCapabilitiesService } from './order-capabilities.service.js';

/**
 * Las capacidades de post-venta de una reserva, fuera de OrdersController: las mismas reglas para
 * Reservas de la agencia y para la consola del superadmin.
 */

const HOTEL: ProviderCapabilities = {
  retrieve: true,
  cancel: true,
  pay: false,
  services: false,
  reshop: false,
};

function service(flight: Partial<ProviderCapabilities> = {}) {
  const registry = new FlightProviderRegistry(
    [new StubProviderFactory({ code: 'stub-air', capabilities: flight })],
    { decisionFor: () => Promise.resolve(undefined) },
  );
  const hotelReads = {
    capabilitiesOf: (provider: string) => (provider === 'tbo-hotels' ? HOTEL : undefined),
    handles: (provider: string) => provider === 'tbo-hotels',
  } as unknown as HotelOrderReadsService;
  return new OrderCapabilitiesService(registry, hotelReads);
}

describe('OrderCapabilitiesService.capabilitiesFor', () => {
  it('cada vertical declara las suyas', () => {
    const s = service({ reshop: false });
    expect(s.capabilitiesFor('tbo-hotels')).toEqual(HOTEL);
    expect(s.capabilitiesFor('stub-air')).toEqual({
      retrieve: true,
      cancel: true,
      pay: true,
      services: true,
      reshop: false,
    });
    expect(s.capabilitiesFor('agent-cars')).toEqual({
      retrieve: false,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
    });
  });

  it('un proveedor que nadie declara no sabe hacer nada', () => {
    expect(service().capabilitiesFor('desconocido')).toEqual({
      retrieve: false,
      cancel: false,
      pay: false,
      services: false,
      reshop: false,
    });
  });
});

describe('OrderCapabilitiesService.capabilitiesForOrder', () => {
  it('una emitida no se cancela; lo demás, como el proveedor', () => {
    const s = service();
    expect(s.capabilitiesForOrder({ provider: 'stub-air', status: 'ticketed' })).toMatchObject({
      retrieve: true,
      cancel: false,
    });
    expect(s.capabilitiesForOrder({ provider: 'stub-air', status: 'confirmed' })).toMatchObject({
      retrieve: true,
      cancel: true,
    });
  });
});

describe('OrderCapabilitiesService.assertSupports', () => {
  it('lo que el proveedor sabe hacer pasa', () => {
    const s = service();
    expect(() =>
      s.assertSupports({ provider: 'tbo-hotels', status: 'confirmed' }, 'cancel'),
    ).not.toThrow();
    expect(() =>
      s.assertSupports({ provider: 'stub-air', status: 'ticketed' }, 'retrieve'),
    ).not.toThrow();
  });

  it('cancelar una emitida es un 400 que lo explica', () => {
    expect(() =>
      service().assertSupports({ provider: 'stub-air', status: 'ticketed' }, 'cancel'),
    ).toThrow(
      new BadRequestException(
        'La reserva está emitida. Esta cancelación no ejecuta VOID ni REFUND de tiquetes.',
      ),
    );
  });

  it('lo que el proveedor no sabe hacer es un 400 con su código', () => {
    const s = service();
    expect(() =>
      s.assertSupports({ provider: 'agent-cars', status: 'confirmed' }, 'retrieve'),
    ).toThrow("La operación no está disponible para reservas de proveedor 'agent-cars'.");
    expect(() => s.assertSupports({ provider: 'tbo-hotels', status: 'confirmed' }, 'pay')).toThrow(
      BadRequestException,
    );
  });
});

describe('OrderCapabilitiesService.isFlightOrder', () => {
  it('es vuelo lo que no es hotel ni auto, aunque el proveedor ya no esté registrado', () => {
    const s = service();
    expect(s.isFlightOrder({ provider: 'stub-air' })).toBe(true);
    expect(s.isFlightOrder({ provider: 'aerolinea-retirada' })).toBe(true);
    expect(s.isFlightOrder({ provider: 'tbo-hotels' })).toBe(false);
    expect(s.isFlightOrder({ provider: 'agent-cars' })).toBe(false);
  });
});
