import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { QR_QUIET_ZONE, QrCode, qrMatrix, qrModulesPath } from './qr-code';

const URI =
  'otpauth://totp/Planetour:ana%40agencia.co?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Planetour&algorithm=SHA1&digits=6&period=30';

describe('qrModulesPath', () => {
  it('un rectángulo por tramo horizontal de módulos oscuros', () => {
    expect(
      qrModulesPath([
        [true, true, false, true],
        [false, false, false, false],
        [false, true, true, true],
      ]),
    ).toBe('M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3z');
  });

  it('una matriz vacía no dibuja nada', () => {
    expect(qrModulesPath([])).toBe('');
    expect(qrModulesPath([[false, false]])).toBe('');
  });
});

describe('qrMatrix', () => {
  it('incluye el margen de 4 módulos alrededor', () => {
    const bare = encode(URI, { ecc: 'M', border: 0 });
    const matrix = qrMatrix(URI);
    expect(matrix?.size).toBe(bare.size + 2 * QR_QUIET_ZONE);
  });

  it('el margen queda en blanco y el patrón de posición arranca después de él', () => {
    const qr = encode(URI, { ecc: 'M', border: QR_QUIET_ZONE });
    for (let y = 0; y < QR_QUIET_ZONE; y += 1) {
      expect(qr.data[y]?.every((m) => !m)).toBe(true);
    }
    // Fila superior del patrón de posición de arriba a la izquierda: 7 módulos oscuros.
    expect(qr.data[QR_QUIET_ZONE]?.slice(QR_QUIET_ZONE, QR_QUIET_ZONE + 7)).toEqual(
      Array(7).fill(true),
    );
    // Ningún tramo del dibujo cae dentro del margen.
    const path = qrMatrix(URI)?.path ?? '';
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(Number(y)).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
    }
  });

  it('un texto que no entra en un QR devuelve null en vez de romper la pantalla', () => {
    expect(qrMatrix('x'.repeat(5000))).toBeNull();
  });
});

describe('QrCode', () => {
  const html = renderToStaticMarkup(
    createElement(QrCode, { value: URI, label: 'Código QR para tu app' }),
  );

  it('es una imagen con nombre accesible', () => {
    expect(html).toMatch(/^<svg role="img" aria-label="Código QR para tu app"/);
  });

  it('negro sobre blanco fijo, sin depender del tema, y bordes nítidos', () => {
    expect(html).toContain('fill="#ffffff"');
    expect(html).toContain('fill="#000000"');
    expect(html).not.toContain('var(--');
    expect(html).toContain('shape-rendering="crispEdges"');
  });

  it('se dibuja con path y rect desde la matriz, sin HTML inyectado', () => {
    const size = qrMatrix(URI)?.size;
    expect(html).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(html).toMatch(/<path d="M\d+ \d+h\d+v1h-\d+z/);
    expect(html).not.toContain('<image');
  });

  it('si no se puede dibujar, lo dice y remite a la clave manual', () => {
    const broken = renderToStaticMarkup(
      createElement(QrCode, { value: 'x'.repeat(5000), label: 'QR' }),
    );
    expect(broken).toContain('role="alert"');
    expect(broken).toContain('Ingresá la clave a mano');
  });
});
