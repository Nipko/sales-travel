import { describe, expect, it } from 'vitest';
import { scrollEdges } from './scroll-fade';

/*
 * Cuándo se ve cada degradado del área con scroll: arriba si hay contenido por encima, abajo si
 * queda más por bajar, y ninguno si todo entra.
 */

const area = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('scrollEdges', () => {
  it('todo entra: sin degradados', () => {
    expect(scrollEdges(area(0, 400, 400))).toEqual({ above: false, below: false });
    expect(scrollEdges(area(0, 300, 400))).toEqual({ above: false, below: false });
  });

  it('un píxel de más por redondeo no cuenta como scroll', () => {
    expect(scrollEdges(area(0, 401, 400))).toEqual({ above: false, below: false });
  });

  it('arriba de todo: sólo el de abajo', () => {
    expect(scrollEdges(area(0, 1065, 956))).toEqual({ above: false, below: true });
  });

  it('en el medio: los dos', () => {
    expect(scrollEdges(area(50, 1065, 956))).toEqual({ above: true, below: true });
  });

  it('al final: sólo el de arriba', () => {
    expect(scrollEdges(area(109, 1065, 956))).toEqual({ above: true, below: false });
  });

  it('con zoom el final llega con decimales y sigue siendo el final', () => {
    expect(scrollEdges(area(108.4, 1065, 956))).toEqual({ above: true, below: false });
  });
});
