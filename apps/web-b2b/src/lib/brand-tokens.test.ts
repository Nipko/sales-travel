import { describe, expect, it } from 'vitest';
import {
  brandStyleSheet,
  contrastRatio,
  deriveBrandTokens,
  isValidHex,
  readableForeground,
} from './brand-tokens';

describe('contrastRatio', () => {
  // Valores de referencia de WCAG 2.x: el rango va de 1 (idénticos) a 21 (blanco/negro).
  it('da 21 entre blanco y negro', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('da 1 para el mismo color', () => {
    expect(contrastRatio('#e37b23', '#e37b23')).toBeCloseTo(1, 5);
  });

  it('es simétrico', () => {
    expect(contrastRatio('#e37b23', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#e37b23'),
      10,
    );
  });
});

describe('readableForeground', () => {
  it('elige texto oscuro sobre colores claros (el caso que rompía la UI)', () => {
    // Amarillo y lima con texto blanco son ilegibles; antes se forzaba blanco siempre.
    for (const bright of ['#ffff00', '#c8f542', '#ffd400', '#ffffff']) {
      expect(readableForeground(bright)).toBe('#141519');
    }
  });

  it('elige texto blanco sobre colores oscuros', () => {
    for (const dark of ['#0b1220', '#2b3a67', '#000000', '#7a1f1f']) {
      expect(readableForeground(dark)).toBe('#ffffff');
    }
  });

  it('siempre devuelve la opción de mayor contraste', () => {
    for (const color of ['#e37b23', '#3b82f6', '#10b981', '#888888', '#7f7f7f']) {
      const chosen = readableForeground(color);
      const other = chosen === '#ffffff' ? '#141519' : '#ffffff';
      expect(contrastRatio(color, chosen)).toBeGreaterThanOrEqual(contrastRatio(color, other));
    }
  });
});

describe('deriveBrandTokens', () => {
  it('el hover NUNCA es igual al color base (era el bug de app-shell)', () => {
    for (const color of ['#e37b23', '#3b82f6', '#000000', '#ffffff', '#10b981']) {
      expect(deriveBrandTokens(color).primaryHover).not.toBe(color);
    }
  });

  it('oscurece un color normal y aclara uno casi negro', () => {
    expect(deriveBrandTokens('#3b82f6').primaryHover < '#3b82f6').toBe(true);
    // Con un primario casi negro, oscurecer más sería imperceptible.
    const nearBlack = deriveBrandTokens('#050505');
    expect(nearBlack.primaryHover).not.toBe('#050505');
    expect(contrastRatio(nearBlack.primaryHover, '#000000')).toBeGreaterThan(
      contrastRatio('#050505', '#000000'),
    );
  });

  it('reporta el contraste real para poder avisar cuando no llega a AA', () => {
    const amarillo = deriveBrandTokens('#ffff00');
    expect(amarillo.primaryFg).toBe('#141519');
    expect(amarillo.contrastRatio).toBeGreaterThan(4.5);

    const naranjaPlanetour = deriveBrandTokens('#e37b23');
    expect(naranjaPlanetour.contrastRatio).toBeGreaterThan(1);
  });

  it('emite hex válidos', () => {
    for (const color of ['#e37b23', '#000000', '#ffffff']) {
      const t = deriveBrandTokens(color);
      expect(isValidHex(t.primaryHover)).toBe(true);
      expect(isValidHex(t.primaryFg)).toBe(true);
    }
  });
});

describe('brandStyleSheet', () => {
  it('devuelve null sin colores configurados', () => {
    expect(brandStyleSheet(null, null)).toBeNull();
    expect(brandStyleSheet(undefined, undefined)).toBeNull();
  });

  it('usa :root para que los Portals también reciban la marca', () => {
    const css = brandStyleSheet('#e37b23', null);
    expect(css).toContain(':root{');
    expect(css).toContain('--color-primary:#e37b23');
    expect(css).toContain('--color-primary-hover:');
    expect(css).toContain('--color-primary-fg:');
  });

  it('DESCARTA valores que no son hex estricto (no llegan al <style>)', () => {
    // Defensa en profundidad: esta cadena se interpola en el DOM.
    for (const malicious of [
      'red;}</style><script>alert(1)</script>',
      'javascript:alert(1)',
      '#fff',
      'rgb(1,2,3)',
      '',
      '#12345g',
    ]) {
      expect(brandStyleSheet(malicious, null)).toBeNull();
    }
  });

  it('acepta el acento por separado y le deriva su propio foreground', () => {
    const css = brandStyleSheet(null, '#ffd400');
    expect(css).toContain('--color-accent:#ffd400');
    expect(css).toContain('--color-accent-fg:#141519');
  });
});
