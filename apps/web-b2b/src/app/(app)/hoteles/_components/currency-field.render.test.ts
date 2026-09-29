import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrencyField } from './currency-field';

/*
 * El selector de moneda de la búsqueda (D-TBO-15) en su primer pintado: lo que anuncia un lector de
 * pantalla, qué viaja en el formulario y que nunca bloquea buscar.
 */

const noop = () => undefined;

function html(props: Parameters<typeof CurrencyField>[0]): string {
  return renderToStaticMarkup(createElement(CurrencyField, props));
}

describe('CurrencyField', () => {
  it('con la lista, un select con etiqueta, descripción y la moneda elegida', () => {
    const out = html({
      options: { defaultCurrency: 'COP', currencies: ['COP', 'USD'] },
      value: 'USD',
      onChange: noop,
    });
    const id = /<select[^>]*id="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeDefined();
    expect(out).toContain(`<label for="${id}"`);
    expect(out).toContain(`aria-describedby="${id}-message"`);
    expect(out).toContain('name="currency"');
    expect(out).not.toMatch(/<select[^>]*\sdisabled=""/);
    expect(out).toMatch(/<option value="COP">COP/);
    expect(out).toMatch(/<option value="USD" selected="">USD/);
    expect(out).toContain(
      'Sin conversión: se ven sólo las tarifas en USD. La de tu agencia es COP.',
    );
  });

  it('mientras carga queda deshabilitado: no viaja y la búsqueda sale en la de la agencia', () => {
    const out = html({ options: undefined, value: '', onChange: noop });
    expect(out).toMatch(/<select[^>]*\sdisabled=""/);
    expect(out).toContain('Cargando…');
  });

  it('si no se pudo leer la lista lo dice, y se puede buscar igual', () => {
    const out = html({ options: null, value: '', onChange: noop });
    expect(out).toMatch(/<select[^>]*\sdisabled=""/);
    expect(out).toContain('No pudimos leer las monedas: se busca en la de la agencia.');
  });

  it('el aviso de cartera se anuncia junto al campo y no bloquea buscar', () => {
    const notice =
      'Tu agencia no tiene cartera en USD: podés cotizar, pero no reservar. Pedile a Planetour que la habilite.';
    const out = html({
      options: { defaultCurrency: 'COP', currencies: ['COP', 'USD'] },
      value: 'USD',
      onChange: noop,
      walletNotice: notice,
    });
    const id = /<select[^>]*id="([^"]+)"/.exec(out)?.[1];
    expect(out).toContain(`aria-describedby="${id}-message ${id}-wallet"`);
    expect(out).toMatch(new RegExp(`id="${id}-wallet" role="status"`));
    expect(out).toContain(notice);
    expect(out).not.toMatch(/<select[^>]*\sdisabled=""/);
  });
});
