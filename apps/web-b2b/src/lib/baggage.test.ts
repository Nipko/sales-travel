import { describe, expect, it } from 'vitest';
import { baggageState, describeBaggage, hasAnyBaggageInfo } from './baggage';

describe('baggageState: «no lo sabemos» no es «no lo incluye»', () => {
  it('ausente es DESCONOCIDO, nunca cero', () => {
    // Es la razón de existir del módulo. Antes, un proveedor que no informaba la franquicia de
    // mano obligaba a elegir entre inventar un cero o descartar todo el equipaje.
    expect(baggageState(undefined)).toEqual({ kind: 'unknown' });
  });

  it('cero es NO INCLUYE, que es un dato real', () => {
    expect(baggageState({ qty: 0 })).toEqual({ kind: 'none' });
  });

  it('con piezas, la cantidad y el peso cuando se sabe', () => {
    expect(baggageState({ qty: 2 })).toEqual({ kind: 'included', qty: 2 });
    expect(baggageState({ qty: 1, weightKg: 23 })).toEqual({
      kind: 'included',
      qty: 1,
      weightKg: 23,
    });
  });
});

describe('describeBaggage: lo que acaba impreso en el PDF del cliente', () => {
  it('lo desconocido NO se lee como excluido', () => {
    // El fallo que evita: «No incluye» sobre algo que no sabemos es una promesa por escrito, a
    // un cliente final, que la agencia no puede sostener.
    expect(describeBaggage(undefined)).toBe('No informado');
    expect(describeBaggage(undefined)).not.toBe(describeBaggage({ qty: 0 }));
  });

  it('lo excluido se dice claro', () => {
    expect(describeBaggage({ qty: 0 })).toBe('No incluye');
  });

  it('el plural y el peso salen bien', () => {
    expect(describeBaggage({ qty: 1 })).toBe('1 pieza');
    expect(describeBaggage({ qty: 2 })).toBe('2 piezas');
    expect(describeBaggage({ qty: 1, weightKg: 23 })).toBe('1 pieza (23 kg)');
  });
});

describe('hasAnyBaggageInfo: si no se sabe nada, no se pinta el bloque', () => {
  it('sin equipaje o con las tres piezas ausentes, no hay nada que contar', () => {
    expect(hasAnyBaggageInfo(undefined)).toBe(false);
    expect(hasAnyBaggageInfo({})).toBe(false);
  });

  it('con UNA sola pieza conocida ya hay algo que decir', () => {
    // El caso de Sabre ATPCO: sólo franquicia facturada. Antes eso se descartaba entero.
    expect(hasAnyBaggageInfo({ checked: { qty: 0 } })).toBe(true);
    expect(hasAnyBaggageInfo({ carryOn: { qty: 1 } })).toBe(true);
    expect(hasAnyBaggageInfo({ personalItem: 1 })).toBe(true);
  });
});
