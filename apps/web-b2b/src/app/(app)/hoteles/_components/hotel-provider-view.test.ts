import { describe, expect, it } from 'vitest';
import type { HotelProviderOutcome, HotelRoompack } from '../actions';
import { cheapestRoompack, degradedProviders, rateProviderLabel } from './hotel-provider-view';

/**
 * RF-40 del lado de la pantalla de hoteles: "me tiene que mostrar de dónde es".
 *
 * Todo se prueba en la dirección segura: con el ajuste apagado, o con una respuesta que no dice
 * de dónde es cada tarifa, no se pinta ningún proveedor.
 */

function tarifa(id: string, amountMinor: number, provider?: string): HotelRoompack {
  return {
    id,
    ...(provider === undefined ? {} : { provider: { name: provider, offerRef: `${id}-REF` } }),
    board: 'RO',
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor, currency: 'USD' }, taxesDetail: [] },
  };
}

/** Las etiquetas que pinta una tarjeta: la del "desde" y la de cada tarifa. */
function etiquetasDeLaTarjeta(packs: HotelRoompack[], show: boolean) {
  const desde = cheapestRoompack(packs);
  return {
    desde: desde === undefined ? undefined : rateProviderLabel(desde, show),
    tarifas: packs.map((p) => rateProviderLabel(p, show)),
  };
}

describe('rateProviderLabel — la pastilla de cada tarifa', () => {
  it('con el ajuste encendido, el nombre legible de la ficha del proveedor, no su código', () => {
    expect(rateProviderLabel(tarifa('A', 100, 'despegar-hotels'), true)).toBe('Despegar Hotels');
  });

  it('un proveedor sin ficha se muestra por su código, como en vuelos', () => {
    expect(rateProviderLabel(tarifa('A', 100, 'proveedor-nuevo-hotels'), true)).toBe(
      'proveedor-nuevo-hotels',
    );
  });

  it('con el ajuste apagado no se pinta nada', () => {
    expect(rateProviderLabel(tarifa('A', 100, 'despegar-hotels'), false)).toBeUndefined();
  });

  it('una tarifa sin proveedor (API anterior) no inventa uno', () => {
    expect(rateProviderLabel(tarifa('A', 100), true)).toBeUndefined();
  });
});

describe('RF-40 CA 4 a 6 — la tarjeta de hotel', () => {
  // Un hotel con una tarifa de cada proveedor, como la tarjeta agrupada por hotel canónico.
  const agrupada = [tarifa('A', 120_000, 'despegar-hotels'), tarifa('B', 90_000, 'otro-hotels')];

  it('CA 4/5: encendido → cada tarifa con SU pastilla, y el "desde" con la de la más barata', () => {
    expect(etiquetasDeLaTarjeta(agrupada, true)).toEqual({
      desde: 'otro-hotels',
      tarifas: ['Despegar Hotels', 'otro-hotels'],
    });
  });

  it('CA 5: dos tarifas de dos proveedores → dos pastillas distintas', () => {
    const { tarifas } = etiquetasDeLaTarjeta(agrupada, true);
    expect(new Set(tarifas).size).toBe(2);
  });

  it('CA 6: apagado → ninguna pastilla, ni en el "desde" ni en las tarifas', () => {
    expect(etiquetasDeLaTarjeta(agrupada, false)).toEqual({
      desde: undefined,
      tarifas: [undefined, undefined],
    });
  });
});

describe('cheapestRoompack', () => {
  it('la tarifa de menor precio; ante un empate, la primera', () => {
    const packs = [tarifa('A', 200), tarifa('B', 100), tarifa('C', 100)];
    expect(cheapestRoompack(packs)?.id).toBe('B');
  });

  it('un hotel sin tarifas no tiene "desde"', () => {
    expect(cheapestRoompack([])).toBeUndefined();
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
    { code: 'apagado-hotels', status: 'skipped', count: 0, skipReason: 'opt-in-disabled' },
    { code: 'respaldo-hotels', status: 'skipped', count: 0, skipReason: 'fallback-not-needed' },
    { code: 'sin-cuenta-hotels', status: 'unavailable', count: 0 },
  ];

  it('avisa lo que falta por ESTA búsqueda: fallos, omisiones con motivo y descartes de moneda', () => {
    expect(degradedProviders(parte).map((p) => p.code)).toEqual([
      'caido-hotels',
      'moneda-hotels',
      'parcial-hotels',
    ]);
  });

  it('sin nada que avisar, no hay aviso', () => {
    expect(degradedProviders([{ code: 'ok-hotels', status: 'ok', count: 3 }])).toEqual([]);
  });
});
