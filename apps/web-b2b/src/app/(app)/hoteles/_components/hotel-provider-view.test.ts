import { describe, expect, it } from 'vitest';
import type { HotelProviderOutcome, HotelRoompack } from '../actions';
import { degradedProviders, emptyResultsView, rateProviderLabel } from './hotel-provider-view';

/**
 * RF-40 del lado de la pantalla de hoteles: "me tiene que mostrar de dónde es".
 *
 * Todo se prueba en la dirección segura: con el ajuste apagado, o con una respuesta que no dice
 * de dónde es cada tarifa, no se pinta ningún proveedor. Las filas de la tarjeta (CA 4 a 6) se
 * prueban en `hotel-rate-view.test.ts`.
 */

function tarifa(id: string, provider?: string): Pick<HotelRoompack, 'provider'> {
  return provider === undefined ? {} : { provider: { name: provider, offerRef: `${id}-REF` } };
}

describe('rateProviderLabel — la pastilla de cada tarifa', () => {
  it('con el ajuste encendido, el nombre legible de la ficha del proveedor, no su código', () => {
    expect(rateProviderLabel(tarifa('A', 'despegar-hotels'), true)).toBe('Despegar Hotels');
    expect(rateProviderLabel(tarifa('B', 'tbo-hotels'), true)).toBe('TBO Holidays');
  });

  it('un proveedor sin ficha se muestra por su código, como en vuelos', () => {
    expect(rateProviderLabel(tarifa('A', 'proveedor-nuevo-hotels'), true)).toBe(
      'proveedor-nuevo-hotels',
    );
  });

  it('con el ajuste apagado no se pinta nada', () => {
    expect(rateProviderLabel(tarifa('A', 'despegar-hotels'), false)).toBeUndefined();
  });

  it('una tarifa sin proveedor (API anterior) no inventa uno', () => {
    expect(rateProviderLabel(tarifa('A'), true)).toBeUndefined();
  });
});

describe('degradedProviders — el aviso de resultados incompletos', () => {
  const parte: HotelProviderOutcome[] = [
    { code: 'ok-hotels', status: 'ok', count: 3 },
    { code: 'vacio-hotels', status: 'empty', count: 0 },
    { code: 'caido-hotels', status: 'error', count: 0, reason: 'no respondió' },
    {
      code: 'moneda-hotels',
      status: 'skipped',
      count: 0,
      skipReason: 'currency-mismatch',
      reason: 'Cotiza en USD',
    },
    {
      code: 'parcial-hotels',
      status: 'ok',
      count: 1,
      droppedForCurrency: 2,
      reason: '2 tarifas en USD no se muestran',
    },
    {
      code: 'mitad-hotels',
      status: 'ok',
      count: 4,
      partial: true,
      reason: 'Una parte de sus hoteles no respondió.',
    },
    { code: 'apagado-hotels', status: 'skipped', count: 0, skipReason: 'opt-in-disabled' },
    {
      code: 'plataforma-hotels',
      status: 'skipped',
      count: 0,
      skipReason: 'platform-disabled',
      reason: 'Deshabilitado por la plataforma para esta agencia.',
    },
    { code: 'respaldo-hotels', status: 'skipped', count: 0, skipReason: 'fallback-not-needed' },
    { code: 'sin-cuenta-hotels', status: 'unavailable', count: 0 },
  ];

  it('lo que apagó la plataforma para la agencia no es un faltante de esta búsqueda', () => {
    expect(degradedProviders(parte).map((p) => p.code)).not.toContain('plataforma-hotels');
  });

  it('avisa lo que falta por ESTA búsqueda: fallos, omisiones, respuestas parciales y descartes', () => {
    expect(degradedProviders(parte).map((p) => p.code)).toEqual([
      'caido-hotels',
      'moneda-hotels',
      'parcial-hotels',
      'mitad-hotels',
    ]);
  });

  it('una respuesta parcial vacía también se avisa: no es "no hay hoteles"', () => {
    const vacioParcial: HotelProviderOutcome = {
      code: 'x-hotels',
      status: 'empty',
      count: 0,
      partial: true,
    };
    expect(degradedProviders([vacioParcial])).toEqual([vacioParcial]);
  });

  it('sin nada que avisar, no hay aviso', () => {
    expect(degradedProviders([{ code: 'ok-hotels', status: 'ok', count: 3 }])).toEqual([]);
  });
});

describe('emptyResultsView — U-08, sin disponibilidad', () => {
  it('todos respondieron sin hoteles: no hay disponibilidad, y se dice qué probar', () => {
    const view = emptyResultsView([
      { code: 'despegar-hotels', status: 'empty', count: 0 },
      { code: 'tbo-hotels', status: 'empty', count: 0 },
    ]);
    expect(view.title).toBe('No hay disponibilidad para ese destino y esas fechas.');
    expect(view.hint).toMatch(/otras fechas/);
  });

  it('faltó un proveedor: no se afirma que no hay lugar', () => {
    const view = emptyResultsView([
      { code: 'despegar-hotels', status: 'empty', count: 0 },
      { code: 'tbo-hotels', status: 'error', count: 0, reason: 'no respondió' },
    ]);
    expect(view.title).toBe('Los proveedores que respondieron no tienen tarifas para mostrar.');
    expect(view.hint).toMatch(/^Un proveedor no aportó todas sus tarifas/);
  });

  it('con varios faltantes dice cuántos', () => {
    const view = emptyResultsView([
      { code: 'despegar-hotels', status: 'empty', count: 0 },
      { code: 'a-hotels', status: 'error', count: 0 },
      { code: 'b-hotels', status: 'skipped', count: 0, skipReason: 'catalog-empty' },
    ]);
    expect(view.hint).toMatch(/^2 proveedores no aportaron todas sus tarifas/);
  });

  it('no contestó ninguno: no se habla de disponibilidad, se manda al aviso', () => {
    const view = emptyResultsView([
      { code: 'despegar-hotels', status: 'error', count: 0, reason: 'no respondió' },
      { code: 'tbo-hotels', status: 'skipped', count: 0, skipReason: 'occupancy-limits' },
    ]);
    expect(view.title).toBe('Ningún proveedor pudo buscar esta vez.');
    expect(view.hint).toMatch(/aviso de arriba/);
  });

  it('sin ningún proveedor activo para la agencia, lo dice en lugar de "no hay disponibilidad"', () => {
    for (const providers of [
      [],
      [
        {
          code: 'tbo-hotels',
          status: 'unavailable',
          count: 0,
          unavailableReason: 'no-credentials',
        },
        { code: 'despegar-hotels', status: 'skipped', count: 0, skipReason: 'opt-in-disabled' },
      ] satisfies HotelProviderOutcome[],
    ]) {
      expect(emptyResultsView(providers).title).toBe(
        'Tu agencia no tiene proveedores de hoteles activos.',
      );
    }
  });

  it('si los apagó la plataforma, no manda a buscar un interruptor en Proveedores (GDS)', () => {
    const view = emptyResultsView([
      { code: 'tbo-hotels', status: 'skipped', count: 0, skipReason: 'platform-disabled' },
      { code: 'despegar-hotels', status: 'skipped', count: 0, skipReason: 'platform-disabled' },
    ]);
    expect(view.title).toBe('Tu agencia no tiene proveedores de hoteles activos.');
    expect(view.hint).toMatch(/La plataforma los deshabilitó/);
    expect(view.hint).not.toMatch(/Proveedores \(GDS\)/);
  });

  it('con apagados por la plataforma y sin cuenta a la vez, dice qué resuelve cada quien', () => {
    const view = emptyResultsView([
      { code: 'tbo-hotels', status: 'skipped', count: 0, skipReason: 'platform-disabled' },
      {
        code: 'despegar-hotels',
        status: 'unavailable',
        count: 0,
        unavailableReason: 'no-credentials',
      },
    ]);
    expect(view.hint).toMatch(/Proveedores \(GDS\)/);
    expect(view.hint).toMatch(/sólo los reactiva la plataforma/);
  });
});
