import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEST_ORDER_DESCRIPTION, TEST_ORDER_EMAIL_NOTICE } from '../../../../lib/test-content';
import { TestOrderTag } from './test-order-tag';

/*
 * Una reserva hecha con la cuenta de pruebas del proveedor, en Reservas: «Prueba» en la lista y
 * «Reserva de prueba» en el detalle. La marca la decide el API (`testContent`).
 */

function tag(order: { testContent?: unknown }, detail = false): string {
  return renderToStaticMarkup(createElement(TestOrderTag, { order, detail }));
}

describe('TestOrderTag', () => {
  it('en la lista dice «Prueba» y explica que no es un tiquete válido', () => {
    const html = tag({ testContent: true });

    expect(html).toMatch(/>Prueba<span class="sr-only">/);
    expect(html).toContain(`title="${TEST_ORDER_DESCRIPTION}"`);
  });

  it('en el detalle dice «Reserva de prueba»', () => {
    const html = tag({ testContent: true }, true);

    expect(html).toMatch(/>Reserva de prueba<span class="sr-only">/);
  });

  it('una reserva real, de antes del campo o con un valor raro no se marca', () => {
    for (const order of [{ testContent: false }, {}, { testContent: 'true' }]) {
      expect(tag(order)).toBe('');
      expect(tag(order, true)).toBe('');
    }
  });
});

/*
 * La página de Reservas pide datos al montar y no se puede pintar sin DOM; se verifica en el código
 * que la lista, el detalle y el reenvío de la confirmación usan la marca.
 */
describe('Reservas usa la marca', () => {
  const page = readFileSync(fileURLToPath(new URL('../page.tsx', import.meta.url)), 'utf8');

  it('en la fila de cada reserva y en la cabecera del detalle', () => {
    expect(page).toContain('<TestOrderTag order={order} />');
    expect(page).toContain('<TestOrderTag order={order} detail />');
  });

  it('y avisa cómo sale el correo si el vendedor reenvía la confirmación de una de prueba', () => {
    expect(page).toMatch(/isTestOrder\(order\) && \(\s*<p[^>]*>\s*\{TEST_ORDER_EMAIL_NOTICE\}/);
    expect(TEST_ORDER_EMAIL_NOTICE).toContain('[PRUEBA]');
  });
});
