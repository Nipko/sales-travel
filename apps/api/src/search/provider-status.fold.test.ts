import { describe, expect, it } from 'vitest';
import { foldProviderStatus, type ProviderStatusRow } from './provider-status.fold.js';

const row = (over: Partial<ProviderStatusRow>): ProviderStatusRow => ({
  provider_code: 'tbo-hotels',
  vertical: 'hotels',
  recent_searches: 10,
  recent_with_results: 8,
  provider_errors: 0,
  internal_errors: 0,
  last_result_at: '2026-11-12T22:00:00Z',
  ...over,
});

describe('el estado de los proveedores para la agencia', () => {
  it('respondiendo con normalidad', () => {
    expect(foldProviderStatus(row({}), undefined).status).toBe('ok');
  });

  it('sin un solo resultado es falla del PROVEEDOR, y lo dice', () => {
    const s = foldProviderStatus(row({ recent_with_results: 0 }), undefined);
    expect(s.status).toBe('provider');
    expect(s.message).toMatch(/No depende de nosotros/);
  });

  it('muchos errores internos es falla NUESTRA', () => {
    const s = foldProviderStatus(row({ internal_errors: 5 }), undefined);
    expect(s.status).toBe('internal');
    expect(s.message).toMatch(/nuestra plataforma/);
  });

  it('pausado por la plataforma manda sobre todo lo demás', () => {
    expect(foldProviderStatus(row({ recent_with_results: 0 }), {}).status).toBe('paused');
  });

  it('sin búsquedas recientes no se acusa a nadie', () => {
    expect(
      foldProviderStatus(row({ recent_searches: 0, recent_with_results: 0 }), undefined).status,
    ).toBe('idle');
  });
});
