import { ProviderEnvironmentSchema, type Offer } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { PROVIDER_PAYLOAD_ENVIRONMENTS } from '../database/database.types.js';
import {
  DEFAULT_PROVIDER_ENVIRONMENT,
  isTestOffer,
  isTestSelectedOffer,
  stampProviderEnvironment,
} from './provider-environment.js';

/**
 * La marca de las tarifas y reservas de una cuenta de pruebas: cómo se escribe y cómo se lee.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function offer(provider: Offer['provider'] = { name: 'alfa-air', offerRef: 'A-1' }): Offer {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    products: ['flight'],
    provider,
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
  };
}

describe('vocabulario', () => {
  it('es el mismo que el del cifrado de payloads de proveedor: test | live', () => {
    expect(ProviderEnvironmentSchema.options).toEqual([...PROVIDER_PAYLOAD_ENVIRONMENTS]);
  });

  it('sin dato, una cuenta es real', () => {
    expect(DEFAULT_PROVIDER_ENVIRONMENT).toBe('live');
  });
});

describe('stampProviderEnvironment', () => {
  it('una cuenta de pruebas marca la oferta `test`', () => {
    expect(stampProviderEnvironment(offer(), 'test').provider).toEqual({
      name: 'alfa-air',
      offerRef: 'A-1',
      environment: 'test',
    });
  });

  it('una cuenta real deja la oferta sin marca, aunque viniera marcada', () => {
    const marcada = offer({ name: 'alfa-air', offerRef: 'A-1', environment: 'test' });

    expect(stampProviderEnvironment(marcada, 'live').provider).toEqual({
      name: 'alfa-air',
      offerRef: 'A-1',
    });
  });

  it('una cuenta de pruebas pisa un `live` de entrada', () => {
    const desmarcada = offer({ name: 'alfa-air', offerRef: 'A-1', environment: 'live' });

    expect(stampProviderEnvironment(desmarcada, 'test').provider.environment).toBe('test');
  });

  it('conserva el resto de la oferta y del proveedor, y no muta la entrada', () => {
    const entrada = offer({
      name: 'alfa-air',
      offerRef: 'A-1',
      source: 'NDC',
      raw: { offerId: 'X' },
      environment: 'live',
    });

    const salida = stampProviderEnvironment(entrada, 'test');

    expect(salida).toEqual({
      ...entrada,
      provider: {
        name: 'alfa-air',
        offerRef: 'A-1',
        source: 'NDC',
        raw: { offerId: 'X' },
        environment: 'test',
      },
    });
    expect(entrada.provider.environment).toBe('live');
  });
});

describe('isTestOffer', () => {
  it('sólo `test` es de pruebas', () => {
    expect(isTestOffer(offer({ name: 'a', offerRef: 'r', environment: 'test' }))).toBe(true);
    expect(isTestOffer(offer({ name: 'a', offerRef: 'r', environment: 'live' }))).toBe(false);
    expect(isTestOffer(offer())).toBe(false);
  });
});

describe('isTestSelectedOffer — la oferta guardada en una orden', () => {
  it('`test` explícito es de pruebas', () => {
    expect(isTestSelectedOffer({ provider: { name: 'a', environment: 'test' } })).toBe(true);
  });

  it.each([
    ['sin marca', { provider: { name: 'a' } }],
    ['live', { provider: { name: 'a', environment: 'live' } }],
    ['un valor que no se reconoce', { provider: { name: 'a', environment: 'cert' } }],
    ['sin proveedor (otra vertical)', { roompack: {} }],
    ['vacía', {}],
    ['null', null],
    ['un texto', 'test'],
  ])('%s se lee como real', (_caso, selectedOffer) => {
    expect(isTestSelectedOffer(selectedOffer)).toBe(false);
  });
});
