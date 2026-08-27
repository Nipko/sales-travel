import { describe, expect, it } from 'vitest';
import {
  birthdateIssue,
  formatBirthdateInput,
  formatBirthdateValue,
  parseBirthdate,
} from './birthdate';

const HOY = '2026-08-27';

describe('formatBirthdateInput: los separadores los pone el campo, no el usuario', () => {
  it('se teclea de corrido y salen las barras solas', () => {
    expect(formatBirthdateInput('0')).toBe('0');
    expect(formatBirthdateInput('09')).toBe('09');
    expect(formatBirthdateInput('0907')).toBe('09/07');
    expect(formatBirthdateInput('09071978')).toBe('09/07/1978');
  });

  it('pegar una fecha ya formateada no la duplica', () => {
    expect(formatBirthdateInput('09/07/1978')).toBe('09/07/1978');
    expect(formatBirthdateInput('9-7-1978')).toBe('97/19/78');
  });

  it('lo que sobra se corta: no se aceptan nueve dígitos', () => {
    expect(formatBirthdateInput('090719789')).toBe('09/07/1978');
  });

  it('borrar hacia atrás no deja una barra colgando', () => {
    // Es la razón de reconstruir desde los dígitos: conservar el `/` tecleado dejaba `12/` y el
    // siguiente dígito producía `12/3` en vez de `12/03`.
    expect(formatBirthdateInput('12/')).toBe('12');
    expect(formatBirthdateInput('12/0')).toBe('12/0');
  });
});

describe('parseBirthdate: sólo emite fechas que se pueden reservar', () => {
  it('una fecha completa sale en ISO', () => {
    expect(parseBirthdate('09/07/1978', HOY)).toBe('1978-07-09');
    expect(parseBirthdate('01011990', HOY)).toBe('1990-01-01');
  });

  it('a medio escribir no emite nada, y eso no es un error', () => {
    expect(parseBirthdate('', HOY)).toBeNull();
    expect(parseBirthdate('09/07', HOY)).toBeNull();
    expect(parseBirthdate('09/07/197', HOY)).toBeNull();
  });

  it('un día que no existe en ese mes se rechaza', () => {
    expect(parseBirthdate('31/02/1990', HOY)).toBeNull();
    expect(parseBirthdate('31/04/1990', HOY)).toBeNull();
    expect(parseBirthdate('00/01/1990', HOY)).toBeNull();
    expect(parseBirthdate('01/13/1990', HOY)).toBeNull();
  });

  it('los bisiestos se respetan: 29/02 vale en 2000 y no en 1900', () => {
    // 2000 es bisiesto (divisible por 400); 1900 no lo es (divisible por 100 y no por 400). Una
    // tabla de meses a mano se equivoca justo aquí.
    expect(parseBirthdate('29/02/2000', HOY)).toBe('2000-02-29');
    expect(parseBirthdate('29/02/1900', HOY)).toBeNull();
    expect(parseBirthdate('29/02/2024', HOY)).toBe('2024-02-29');
  });

  it('una fecha futura no es una fecha de nacimiento', () => {
    expect(parseBirthdate('28/08/2026', HOY)).toBeNull();
    // Hoy mismo sí: un infante nacido hoy es un pasajero válido.
    expect(parseBirthdate('27/08/2026', HOY)).toBe('2026-08-27');
  });

  it('un año imposible se rechaza en vez de crear un pasajero de 1.900 años', () => {
    expect(parseBirthdate('01/01/0007', HOY)).toBeNull();
    expect(parseBirthdate('01/01/1899', HOY)).toBeNull();
    expect(parseBirthdate('01/01/1900', HOY)).toBe('1900-01-01');
  });
});

describe('formatBirthdateValue: y de vuelta, para rellenar el campo', () => {
  it('el ISO guardado vuelve a verse como se tecleó', () => {
    expect(formatBirthdateValue('1978-07-09')).toBe('09/07/1978');
  });

  it('ida y vuelta sin pérdida', () => {
    const iso = parseBirthdate('29/02/2024', HOY);
    expect(parseBirthdate(formatBirthdateValue(iso!), HOY)).toBe(iso);
  });

  it('lo que no es ISO no inventa nada', () => {
    expect(formatBirthdateValue('')).toBe('');
    expect(formatBirthdateValue('09/07/1978')).toBe('');
  });
});

describe('birthdateIssue: no regaña a nadie por ir a mitad de camino', () => {
  it('mientras se escribe, calla', () => {
    expect(birthdateIssue('', HOY)).toBeNull();
    expect(birthdateIssue('09', HOY)).toBeNull();
    expect(birthdateIssue('09/07/19', HOY)).toBeNull();
  });

  it('cuando está completa y mal, dice por qué', () => {
    expect(birthdateIssue('31/02/1990', HOY)).toBe('Esa fecha no existe.');
    expect(birthdateIssue('01/01/1800', HOY)).toBe('Revisá el año.');
    expect(birthdateIssue('28/08/2026', HOY)).toBe('La fecha de nacimiento no puede ser futura.');
  });

  it('una fecha buena no dice nada', () => {
    expect(birthdateIssue('09/07/1978', HOY)).toBeNull();
  });
});
