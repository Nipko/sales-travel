import { describe, expect, it } from 'vitest';
import type { HotelOffer } from '../actions';
import { resultHotelsOf } from './hotel-results-filters';
import { extendedGeneration, initialPhotoGeneration } from './use-hotel-photos';

/*
 * Las fotos de los resultados cuando la misma búsqueda suma un tramo (docs/tbo/02 §4.4): lo que ya
 * llegó se conserva y sólo empiezan de cero los hoteles nuevos; otra búsqueda empieza de cero.
 */

const oferta = (id: string): HotelOffer => ({ hotelId: id, name: `Hotel ${id}`, roompacks: [] });

describe('extendedGeneration', () => {
  const primero = [oferta('1'), oferta('2')];
  const hoteles = resultHotelsOf(primero, false, 0);
  const lista = initialPhotoGeneration(hoteles, 4);
  const conFoto = {
    ...lista,
    states: new Map(lista.states).set(hoteles[0]!.key, {
      status: 'ready',
      image: { url: '/api/hotels/images/abc' },
    } as never),
  };

  it('un tramo más: conserva las fotos de los que ya estaban y suma los nuevos', () => {
    const ampliada = resultHotelsOf([...primero, oferta('3')], false, 0);
    const sig = extendedGeneration(conFoto, ampliada);

    expect(sig?.id).toBe(4);
    expect(sig?.states.get(hoteles[0]!.key)).toEqual({
      status: 'ready',
      image: { url: '/api/hotels/images/abc' },
    });
    expect(sig?.states.has(ampliada[2]!.key)).toBe(true);
  });

  it('otra búsqueda (otros hoteles al principio, o menos): no es un tramo', () => {
    expect(extendedGeneration(conFoto, resultHotelsOf([oferta('9')], false, 0))).toBeUndefined();
    expect(
      extendedGeneration(conFoto, resultHotelsOf([oferta('1'), oferta('7')], false, 0)),
    ).toBeUndefined();
  });
});
