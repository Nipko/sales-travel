import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TestContentNotice } from '../../../../components/test-content-badge';
import { TEST_BOOKING_NOTICE } from '../../../../lib/test-content';

/*
 * El checkout de una tarifa del entorno de pruebas del proveedor: antes de cargar a un pasajero,
 * quien reserva lee que la reserva no genera un tiquete real. No bloquea: la cuenta de pruebas se
 * usa justamente para probar el flujo.
 *
 * La página pide la cotización al montar y no se puede pintar sin DOM; se pinta el aviso y se
 * verifica en el código dónde va.
 */

const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

describe('checkout de vuelos con una tarifa de pruebas', () => {
  it('el aviso dice que la reserva no genera un tiquete real, en tú', () => {
    const html = renderToStaticMarkup(createElement(TestContentNotice, null, TEST_BOOKING_NOTICE));

    expect(html).toContain('role="note"');
    expect(html).toContain(
      'Estás reservando en el entorno de pruebas del proveedor. La reserva no genera un tiquete real.',
    );
  });

  it('va justo encima del formulario de pasajeros, sólo con una tarifa de pruebas', () => {
    const aviso = page.indexOf('{TEST_BOOKING_NOTICE}');
    const formulario = page.indexOf('<PassengerForm');

    expect(aviso).toBeGreaterThan(-1);
    expect(aviso).toBeLessThan(formulario);
    expect(page.slice(aviso - 200, aviso)).toMatch(/\{testFare \? \(\s*<TestContentNotice/);
  });

  it('la marca sale de la oferta elegida (la revalidada, si ya se verificó el precio)', () => {
    expect(page).toContain('const testFare = isTestFare(selectedOffer);');
    expect(page).toContain('{testFare ? <TestContentBadge /> : null}');
  });

  it('no deja de reservar: el formulario no depende de la marca', () => {
    const formulario = page.slice(page.indexOf('<PassengerForm'));
    expect(formulario.slice(0, formulario.indexOf('/>'))).not.toContain('testFare');
  });
});
