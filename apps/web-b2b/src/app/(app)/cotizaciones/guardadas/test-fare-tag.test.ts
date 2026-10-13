import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTestFare } from '../../../../lib/test-content';

/*
 * La lista de cotizaciones guardadas marca las de una tarifa de pruebas, igual que la búsqueda y el
 * checkout: desde aquí el vendedor abre una cotización para mandársela a un cliente.
 *
 * La página pide las cotizaciones al montar y no se puede pintar sin DOM; se verifica en el código
 * que la fila usa la marca, y con la función que la lista recibe del API.
 */

const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

describe('cotizaciones guardadas con una tarifa de pruebas', () => {
  it('la fila lleva la etiqueta «Prueba» cuando la oferta guardada es de pruebas', () => {
    expect(page).toContain('{isTestFare(q.selectedOffer) ? <TestContentBadge /> : null}');
  });

  it('lee la forma en que el API devuelve la cotización', () => {
    const guardada = { provider: { name: 'alfa-air', environment: 'test' }, total: {} };

    expect(isTestFare(guardada)).toBe(true);
    expect(isTestFare({ ...guardada, provider: { name: 'alfa-air' } })).toBe(false);
  });
});
