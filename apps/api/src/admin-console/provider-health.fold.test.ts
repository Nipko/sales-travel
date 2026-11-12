import { describe, expect, it } from 'vitest';
import {
  foldProviderHealth,
  sortProviderHealth,
  type ProviderSearchHealthRow,
} from './provider-health.fold.js';

const NOW = new Date('2026-11-12T17:00:00Z');

function row(over: Partial<ProviderSearchHealthRow>): ProviderSearchHealthRow {
  return {
    provider_code: 'tbo-hotels',
    vertical: 'hotels',
    searches: '28',
    with_results: '0',
    empty_searches: '28',
    error_searches: '0',
    recent_searches: '28',
    recent_with_results: '0',
    avg_duration_ms: '9500',
    p95_duration_ms: '10600',
    last_search_at: '2026-11-12T16:59:46Z',
    last_result_at: '2026-10-23T01:00:29Z',
    last_error_code: null,
    ...over,
  };
}

describe('Plataforma → Salud de proveedores', () => {
  it('TBO del 12 nov: muchas búsquedas sin resultados es CAÍDO, con cuándo trajo algo por última vez', () => {
    const h = foldProviderHealth(row({}), 24, NOW);
    expect(h.status).toBe('down');
    expect(h.reason).toMatch(/28 búsquedas/);
    expect(h.reason).toMatch(/hace 20 días/);
    expect(h.hitRate).toBe(0);
  });

  it('muchos errores es degradado y nombra el último código', () => {
    const h = foldProviderHealth(
      row({
        provider_code: 'sabre',
        vertical: 'flights',
        searches: 10,
        with_results: 6,
        error_searches: 4,
        recent_with_results: 6,
        last_error_code: 'ProviderCallError',
      }),
      24,
      NOW,
    );
    expect(h.status).toBe('degraded');
    expect(h.reason).toMatch(/40%.*ProviderCallError/);
  });

  it('sin búsquedas recientes no es caído: es sin uso', () => {
    expect(foldProviderHealth(row({ recent_searches: 0 }), 24, NOW).status).toBe('idle');
  });

  it('un proveedor que trae resultados está bien, y lo caído va primero', () => {
    const ok = foldProviderHealth(
      row({
        provider_code: 'sabre',
        vertical: 'flights',
        searches: 20,
        with_results: 19,
        empty_searches: 1,
        recent_with_results: 10,
      }),
      24,
      NOW,
    );
    expect(ok.status).toBe('ok');
    const down = foldProviderHealth(row({}), 24, NOW);
    expect(sortProviderHealth([ok, down]).map((p) => p.status)).toEqual(['down', 'ok']);
  });
});
