import { describe, expect, it } from 'vitest';
import {
  advancesFocus,
  airportSelection,
  airportTyping,
  comboboxKeyAction,
  typedAirportCode,
} from './airport-combobox';
import type { Airport } from '../../lib/airports';

const BOGOTA: Airport = {
  code: 'BOG',
  name: 'El Dorado Intl',
  city: 'Bogotá',
  country: 'Colombia',
  countryCode: 'CO',
  size: 3,
  scheduled: true,
};

/**
 * Reproduce el camino del componente para una tecla: `handleInputChange` llama a
 * `airportTyping` y la página decide con `advancesFocus`. Un paso por letra, que es
 * exactamente donde estaba el fallo: `onChange` dispara en cada una.
 */
function typeInto(text: string): { code: string; focusMoved: boolean }[] {
  return Array.from({ length: text.length }, (_, i) => {
    const change = airportTyping(text.slice(0, i + 1));
    return { code: change.code, focusMoved: advancesFocus(change.reason) };
  });
}

describe('teclear no es elegir', () => {
  it('escribir "BOG" letra por letra no mueve el foco en ninguna tecla', () => {
    const steps = typeInto('BOG');

    expect(steps.map((s) => s.focusMoved)).toEqual([false, false, false]);
  });

  it('escribir el código completo sí deja el valor cargado (el formulario queda enviable)', () => {
    const steps = typeInto('BOG');

    expect(steps.map((s) => s.code)).toEqual(['', '', 'BOG']);
  });

  it('seguir escribiendo después del código tampoco mueve el foco', () => {
    const change = airportTyping('BOGO');

    expect(change.code).toBe('');
    expect(advancesFocus(change.reason)).toBe(false);
  });

  it('minúsculas y espacios sobrantes cuentan igual, y siguen sin ser una elección', () => {
    const change = airportTyping('  bog ');

    expect(change.code).toBe('BOG');
    expect(advancesFocus(change.reason)).toBe(false);
  });
});

describe('elegir de verdad sí mueve el foco', () => {
  it('la elección se anuncia como decisión del usuario y autoriza el avance', () => {
    const selection = airportSelection(BOGOTA);

    expect(selection.code).toBe('BOG');
    expect(advancesFocus(selection.reason)).toBe(true);
  });

  it('la elección deja el texto legible en el campo, no el código pelado', () => {
    expect(airportSelection(BOGOTA).query).toBe('Bogotá (BOG)');
  });
});

describe('comboboxKeyAction: qué tecla elige y qué tecla no', () => {
  const open8 = { open: true, optionCount: 8 };

  it('Enter con una opción resaltada elige', () => {
    expect(comboboxKeyAction('Enter', { ...open8, activeIndex: 0 })).toBe('select');
    expect(comboboxKeyAction('Enter', { ...open8, activeIndex: 7 })).toBe('select');
  });

  it('Enter sin nada resaltado no elige: es el estado de quien acaba de teclear', () => {
    expect(comboboxKeyAction('Enter', { ...open8, activeIndex: -1 })).toBe('none');
  });

  it('Enter con el desplegable cerrado no elige', () => {
    expect(comboboxKeyAction('Enter', { open: false, activeIndex: 0, optionCount: 8 })).toBe(
      'none',
    );
  });

  it('Enter con un resaltado fuera de rango no elige', () => {
    expect(comboboxKeyAction('Enter', { ...open8, activeIndex: 8 })).toBe('none');
  });

  it('las flechas navegan la lista', () => {
    expect(comboboxKeyAction('ArrowDown', { ...open8, activeIndex: -1 })).toBe('next');
    expect(comboboxKeyAction('ArrowUp', { ...open8, activeIndex: 3 })).toBe('prev');
  });

  it('sin opciones, flechas y Enter no hacen nada', () => {
    const empty = { open: true, activeIndex: -1, optionCount: 0 };

    expect(comboboxKeyAction('ArrowDown', empty)).toBe('none');
    expect(comboboxKeyAction('Enter', empty)).toBe('none');
  });

  it('Escape y Tab cierran, incluso con la lista vacía', () => {
    const empty = { open: true, activeIndex: -1, optionCount: 0 };

    expect(comboboxKeyAction('Escape', empty)).toBe('close');
    expect(comboboxKeyAction('Tab', empty)).toBe('close');
  });

  it('escribir una letra no es una acción del desplegable', () => {
    expect(comboboxKeyAction('G', { ...open8, activeIndex: 0 })).toBe('none');
  });
});

describe('typedAirportCode', () => {
  it('acepta un código que el catálogo local todavía no conoce', () => {
    expect(typedAirportCode('zzz')).toBe('ZZZ');
  });

  it('no inventa código con texto que no es un IATA', () => {
    expect(typedAirportCode('')).toBe('');
    expect(typedAirportCode('bo')).toBe('');
    expect(typedAirportCode('Bogotá')).toBe('');
    expect(typedAirportCode('Bogotá (BOG)')).toBe('');
  });
});
