import { describe, expect, it } from 'vitest';
import { accountDisplay } from './account-display';

describe('accountDisplay (la persona en la barra de arriba)', () => {
  it('con nombre: el nombre primero y el correo debajo', () => {
    expect(accountDisplay('Laura Gómez', 'laura@agencia.com')).toEqual({
      primary: 'Laura Gómez',
      secondary: 'laura@agencia.com',
    });
  });

  it('sin nombre (o sólo espacios): el correo', () => {
    expect(accountDisplay(undefined, 'laura@agencia.com')).toEqual({
      primary: 'laura@agencia.com',
    });
    expect(accountDisplay('   ', 'laura@agencia.com')).toEqual({ primary: 'laura@agencia.com' });
  });

  it('sin nada: "Usuario"', () => {
    expect(accountDisplay(undefined, undefined)).toEqual({ primary: 'Usuario' });
    expect(accountDisplay('Laura', undefined)).toEqual({ primary: 'Laura' });
  });
});
