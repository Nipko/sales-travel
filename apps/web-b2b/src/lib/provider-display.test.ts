import { describe, expect, it } from 'vitest';
import { PROVIDER_METADATA, providerMetaFor } from './provider-display';
import { PROVIDERS } from './provider-forms';

describe('fichas de proveedor', () => {
  it('TBO Holidays tiene nombre legible y vertical propia (TP-56)', () => {
    // La pastilla de cada tarifa de hotel pinta este nombre (RF-40 CA 4): sin ficha saldría el
    // código crudo `tbo-hotels`.
    const meta = providerMetaFor('tbo-hotels');
    expect(meta.name).toBe('TBO Holidays');
    expect(meta.vertical).toBe('Hotelería');
  });

  it('su pastilla se distingue de la de Despegar: conviven en la misma tarjeta agrupada', () => {
    expect(PROVIDER_METADATA['tbo-hotels']?.badgeClass).not.toBe(
      PROVIDER_METADATA['despegar-hotels']?.badgeClass,
    );
  });

  it('todo proveedor con formulario de credenciales tiene ficha, no el relleno genérico', () => {
    // Si no, el panel diría "TBO Holidays" en el formulario y la tarjeta mostraría otro nombre.
    for (const code of Object.keys(PROVIDERS)) {
      expect(PROVIDER_METADATA[code], code).toBeDefined();
    }
  });
});
