import { describe, expect, it } from 'vitest';
import { brandInitials } from './brand-mark';

describe('brandInitials: la marca de una agencia que todavía no subió logo', () => {
  it('descarta la forma jurídica, que la comparte media red', () => {
    // El caso real del tenant de producción. «PS» sería la inicial de «S.A.S», que no
    // distingue a nadie: la mitad de las agencias colombianas de la red son S.A.S.
    expect(brandInitials('Planetour S.A.S')).toBe('PL');
    expect(brandInitials('Andes Travel SAS')).toBe('AT');
    expect(brandInitials('Turismo Global Ltda.')).toBe('TG');
    expect(brandInitials('Nexo SRL')).toBe('NE');
  });

  it('un solo nombre propio da dos letras, no una suelta', () => {
    // Una letra sola en un recuadro se lee como un ícono genérico, no como una marca.
    expect(brandInitials('Planetour')).toBe('PL');
    expect(brandInitials('Despegar')).toBe('DE');
  });

  it('dos nombres propios dan una inicial de cada uno', () => {
    expect(brandInitials('Mundo Joven')).toBe('MJ');
    expect(brandInitials('Aviatur Colombia')).toBe('AC');
  });

  it('las palabras del rubro SÍ cuentan: son parte del nombre comercial', () => {
    // La tentación es filtrar «Travel»/«Viajes» igual que la forma jurídica. No es lo mismo:
    // la agencia se anuncia con ellas, y quitarlas devolvía «AN» por «Andes Travel».
    expect(brandInitials('Viajes Alborada')).toBe('VA');
    expect(brandInitials('Grupo Cóndor')).toBe('GC');
    expect(brandInitials('Condor Tours')).toBe('CT');
  });

  it('la puntuación no se cuela en el monograma', () => {
    expect(brandInitials('  Planetour   S.A.S  ')).toBe('PL');
    expect(brandInitials('A&B Turismo')).toBe('AT');
  });

  it('acentos y caracteres no ASCII sobreviven', () => {
    expect(brandInitials('Ñandú Expediciones')).toBe('ÑE');
    expect(brandInitials('São Paulo Turismo')).toBe('SP');
  });

  it('sin nombre devuelve vacío: la marca de la plataforma, no dos letras inventadas', () => {
    // El componente usa el vacío para caer al ícono de plataforma. Devolver algo aquí
    // haría que el vendedor leyera como "su agencia" un monograma que no lo es.
    expect(brandInitials(undefined)).toBe('');
    expect(brandInitials(null)).toBe('');
    expect(brandInitials('')).toBe('');
    expect(brandInitials('   ')).toBe('');
  });

  it('un nombre que es SÓLO forma jurídica no inventa iniciales', () => {
    expect(brandInitials('S.A.S')).toBe('');
    expect(brandInitials('LTDA')).toBe('');
    expect(brandInitials('...')).toBe('');
  });
});
