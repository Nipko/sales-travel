import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { testAccountView } from './hotel-provider-view';
import { TestAccountNotice, TestAccountTag, TestBookingNotice } from './test-account-notice';

/*
 * Los avisos de una cuenta de prueba del proveedor: que nadie confunda una reserva hecha con la
 * cuenta TEST de TBO con una habitación de verdad. El aviso va siempre; la divulgación sólo decide si
 * nombra al proveedor.
 */

const TBO_PRUEBA = [{ code: 'tbo-hotels', accountEnvironment: 'test' as const }];

function notice(showProvider: boolean, providers = TBO_PRUEBA): string {
  return renderToStaticMarkup(
    createElement(TestAccountNotice, { view: testAccountView(providers, showProvider) }),
  );
}

describe('TestAccountNotice — arriba de resultados y ficha', () => {
  it('con la divulgación encendida nombra a TBO Holidays', () => {
    const html = notice(true);
    expect(html).toContain('role="note"');
    expect(html).toContain('var(--color-warning)');
    expect(html).toContain(
      'Las tarifas de TBO Holidays vienen de una cuenta de prueba: puedes reservarlas para probar el flujo, pero no son habitaciones reales para un cliente.',
    );
  });

  it('con la divulgación apagada avisa igual, sin nombrar al proveedor', () => {
    const html = notice(false);
    expect(html).toContain(
      'Algunas tarifas vienen de una cuenta de prueba de un proveedor: puedes reservarlas para probar el flujo, pero no son habitaciones reales para un cliente.',
    );
    expect(html).not.toContain('TBO');
  });

  it('sin tarifas de prueba no pinta nada', () => {
    expect(notice(true, [])).toBe('');
    expect(renderToStaticMarkup(createElement(TestAccountNotice, { view: undefined }))).toBe('');
  });
});

describe('TestAccountTag — la etiqueta de cada plan', () => {
  it('dice «Prueba» a la vista y qué es a un lector de pantalla', () => {
    const html = renderToStaticMarkup(createElement(TestAccountTag));
    expect(html).toContain('>Prueba</span>');
    expect(html).toContain('<span class="sr-only">Tarifa de una cuenta de </span>');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('TestBookingNotice — en el checkout', () => {
  it('con la cuenta de prueba dice que la reserva no es real', () => {
    const html = renderToStaticMarkup(createElement(TestBookingNotice, { environment: 'test' }));
    expect(html).toContain('role="note"');
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      'Cuenta de prueba: esta reserva no es real y no le asegura una habitación a tu cliente.',
    );
  });

  it('con la de producción, o sin saberlo, no pinta nada', () => {
    expect(renderToStaticMarkup(createElement(TestBookingNotice, { environment: 'live' }))).toBe(
      '',
    );
    expect(renderToStaticMarkup(createElement(TestBookingNotice, { environment: undefined }))).toBe(
      '',
    );
  });
});
