import { describe, expect, it } from 'vitest';
import { splitFullName } from './full-name';

describe('splitFullName: partir un nombre para el billete', () => {
  it('dos palabras: uno y uno', () => {
    expect(splitFullName('Juan Pérez')).toEqual({ givenName: 'Juan', surname: 'Pérez' });
  });

  it('cuatro palabras: los DOS últimos son apellidos', () => {
    // La forma canónica en LATAM. La regla anglosajona «la última palabra» emitía apellido
    // «Gómez» y metía «Pérez» dentro del nombre de pila — un nombre que no coincide con el
    // documento y una aerolínea que puede negar el embarque.
    expect(splitFullName('Juan Carlos Pérez Gómez')).toEqual({
      givenName: 'Juan Carlos',
      surname: 'Pérez Gómez',
    });
  });

  it('tres palabras: un nombre y dos apellidos, que es lo más frecuente acá', () => {
    expect(splitFullName('Juan Pérez Gómez')).toEqual({
      givenName: 'Juan',
      surname: 'Pérez Gómez',
    });
  });

  it('cinco o más: sólo los dos últimos son apellidos', () => {
    expect(splitFullName('María de los Ángeles Rojas Silva')).toEqual({
      givenName: 'María de los Ángeles',
      surname: 'Rojas Silva',
    });
  });

  it('una sola palabra no inventa un apellido', () => {
    // Un apellido inventado viaja al billete igual que uno real.
    expect(splitFullName('Madonna')).toEqual({ givenName: 'Madonna', surname: '' });
  });

  it('espacios de más no cuentan como palabras', () => {
    expect(splitFullName('  Juan   Pérez  ')).toEqual({ givenName: 'Juan', surname: 'Pérez' });
  });

  it('vacío da vacío, sin reventar', () => {
    expect(splitFullName('')).toEqual({ givenName: '', surname: '' });
    expect(splitFullName('   ')).toEqual({ givenName: '', surname: '' });
  });
});
