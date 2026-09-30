import { describe, expect, it } from 'vitest';
import {
  applyBackspace,
  applyDelete,
  applyDigit,
  applyInput,
  applyPaste,
  clampOtpIndex,
  emptyOtp,
  firstEmptyIndex,
  isOtpComplete,
  isOtpNavigationKey,
  navigateOtp,
  onlyDigits,
  otpDigitsFromValue,
  otpValue,
} from './otp-input-state';

/*
 * La lógica del OtpInput sin DOM: qué queda escrito y dónde queda el foco después de cada gesto.
 * Los casos son los que rompen a las casillas de código en el mundo real: el autocompletado de iOS
 * que pone los 6 dígitos en UNA casilla, el pegado en la casilla equivocada, el teclado de Android
 * que no dice qué tecla se apretó y el retroceso que tiene que volver solo.
 */

const d = (value: string) => otpDigitsFromValue(value);

describe('estado vacío y valor', () => {
  it('seis casillas vacías por defecto, o las que se pidan', () => {
    expect(emptyOtp()).toEqual(['', '', '', '', '', '']);
    expect(emptyOtp(4)).toHaveLength(4);
  });

  it('el valor es la concatenación y está completo sólo con todas llenas', () => {
    expect(otpValue(d('123'))).toBe('123');
    expect(isOtpComplete(d('12345'))).toBe(false);
    expect(isOtpComplete(d('123456'))).toBe(true);
    expect(isOtpComplete([])).toBe(false);
  });

  it('otpDigitsFromValue filtra, recorta y completa', () => {
    expect(otpDigitsFromValue('12a3')).toEqual(['1', '2', '3', '', '', '']);
    expect(otpDigitsFromValue('123456789')).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('onlyDigits deja sólo 0-9, también desde dígitos de ancho completo', () => {
    expect(onlyDigits(' 123-456 ')).toBe('123456');
    expect(onlyDigits('１２３４５６')).toBe('123456');
    expect(onlyDigits('abc')).toBe('');
  });

  it('firstEmptyIndex: donde sigue escribiendo el usuario', () => {
    expect(firstEmptyIndex(d(''))).toBe(0);
    expect(firstEmptyIndex(d('12'))).toBe(2);
    expect(firstEmptyIndex(d('123456'))).toBe(5);
  });

  it('clampOtpIndex no sale de las casillas', () => {
    expect(clampOtpIndex(-1, 6)).toBe(0);
    expect(clampOtpIndex(9, 6)).toBe(5);
    expect(clampOtpIndex(3, 6)).toBe(3);
  });
});

describe('autocompletado y pegado', () => {
  it('iOS pone los 6 dígitos en la PRIMERA casilla: se reparten todos', () => {
    expect(applyInput(emptyOtp(), 0, '482913')).toEqual({
      digits: ['4', '8', '2', '9', '1', '3'],
      focus: 5,
    });
  });

  it('un código completo en cualquier casilla reemplaza todo, no se corre', () => {
    expect(applyInput(d('9'), 3, '482913').digits).toEqual(['4', '8', '2', '9', '1', '3']);
    expect(applyPaste(d('111111'), 4, '482913')).toEqual({
      digits: ['4', '8', '2', '9', '1', '3'],
      focus: 5,
    });
  });

  it('el pegado ignora espacios, guiones y texto alrededor', () => {
    expect(otpValue(applyPaste(emptyOtp(), 0, 'Tu código: 482 913').digits)).toBe('482913');
    expect(otpValue(applyPaste(emptyOtp(), 0, '482-913').digits)).toBe('482913');
  });

  it('con más dígitos de la cuenta se queda con los primeros', () => {
    expect(otpValue(applyPaste(emptyOtp(), 0, '12345678').digits)).toBe('123456');
  });

  it('un fragmento corto se escribe desde la casilla actual y el foco sigue', () => {
    expect(applyPaste(d('12'), 2, '34')).toEqual({
      digits: ['1', '2', '3', '4', '', ''],
      focus: 4,
    });
  });

  it('un fragmento que no entra se corta en la última casilla', () => {
    expect(applyPaste(emptyOtp(), 4, '789')).toEqual({
      digits: ['', '', '', '', '7', '8'],
      focus: 5,
    });
  });

  it('pegar algo sin dígitos no cambia nada', () => {
    expect(applyPaste(d('12'), 2, 'hola')).toEqual({ digits: d('12'), focus: 2 });
  });
});

describe('escribir', () => {
  it('un dígito se escribe y el foco avanza', () => {
    expect(applyInput(emptyOtp(), 0, '7')).toEqual({ digits: d('7'), focus: 1 });
    expect(applyDigit(emptyOtp(), 0, '7')).toEqual({ digits: d('7'), focus: 1 });
  });

  it('en la última casilla el foco se queda', () => {
    expect(applyInput(d('12345'), 5, '6')).toEqual({ digits: d('123456'), focus: 5 });
    expect(applyDigit(d('12345'), 5, '6').focus).toBe(5);
  });

  it('una tecla junto al dígito que había (cursor sin selección): gana la nueva, de cualquier lado', () => {
    expect(applyInput(d('123'), 1, '27')).toEqual({ digits: d('173'), focus: 2 });
    expect(applyInput(d('123'), 1, '72')).toEqual({ digits: d('173'), focus: 2 });
    expect(applyInput(d('123'), 1, '22')).toEqual({ digits: d('123'), focus: 2 });
  });

  it('las letras no entran: ni en una casilla vacía ni junto a un dígito', () => {
    expect(applyInput(emptyOtp(), 0, 'a')).toEqual({ digits: emptyOtp(), focus: 0 });
    expect(applyInput(d('1'), 0, '1a')).toEqual({ digits: d('1'), focus: 0 });
    expect(applyInput(d('1'), 0, 'a1')).toEqual({ digits: d('1'), focus: 0 });
    expect(applyDigit(emptyOtp(), 0, 'x')).toEqual({ digits: emptyOtp(), focus: 0 });
  });

  it('el borrado que llega como input vacío (Android) limpia y vuelve una casilla', () => {
    expect(applyInput(d('123'), 2, '')).toEqual({ digits: d('12'), focus: 1 });
    expect(applyInput(d('1'), 0, '')).toEqual({ digits: emptyOtp(), focus: 0 });
  });

  it('nunca muta el estado que recibe', () => {
    const before = d('123');
    const copy = [...before];
    applyInput(before, 1, '9');
    applyPaste(before, 0, '654321');
    applyBackspace(before, 2);
    applyDelete(before, 0);
    expect(before).toEqual(copy);
  });
});

describe('retroceso y suprimir', () => {
  it('sobre una casilla llena la borra y vuelve una', () => {
    expect(applyBackspace(d('123'), 2)).toEqual({ digits: d('12'), focus: 1 });
  });

  it('sobre una vacía borra la anterior y va a ella', () => {
    expect(applyBackspace(d('123'), 3)).toEqual({ digits: d('12'), focus: 2 });
  });

  it('retroceso seguido borra todo de atrás para adelante sin tocar nada más', () => {
    let state = { digits: d('123456') as readonly string[], focus: 5 };
    for (let i = 0; i < 6; i++) state = applyBackspace(state.digits, state.focus);
    expect(state).toEqual({ digits: emptyOtp(), focus: 0 });
  });

  it('en la primera casilla vacía no hace nada', () => {
    expect(applyBackspace(emptyOtp(), 0)).toEqual({ digits: emptyOtp(), focus: 0 });
  });

  it('suprimir borra la casilla actual y el foco se queda', () => {
    expect(applyDelete(d('123'), 1)).toEqual({ digits: ['1', '', '3', '', '', ''], focus: 1 });
  });
});

describe('navegación con teclado', () => {
  it('flechas mueven una casilla, sin dar la vuelta', () => {
    expect(navigateOtp(2, 'ArrowLeft', 6)).toBe(1);
    expect(navigateOtp(2, 'ArrowRight', 6)).toBe(3);
    expect(navigateOtp(0, 'ArrowLeft', 6)).toBe(0);
    expect(navigateOtp(5, 'ArrowRight', 6)).toBe(5);
  });

  it('Inicio y Fin van a los extremos', () => {
    expect(navigateOtp(3, 'Home', 6)).toBe(0);
    expect(navigateOtp(1, 'End', 6)).toBe(5);
  });

  it('sólo esas teclas navegan', () => {
    expect(isOtpNavigationKey('ArrowLeft')).toBe(true);
    expect(isOtpNavigationKey('End')).toBe(true);
    expect(isOtpNavigationKey('ArrowUp')).toBe(false);
    expect(isOtpNavigationKey('Tab')).toBe(false);
  });
});
