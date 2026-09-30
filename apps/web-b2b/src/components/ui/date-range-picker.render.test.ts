import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DateRangePicker, type DateRangePickerProps } from './date-range-picker';

/*
 * El disparador del calendario en su primer pintado: el talón alto de vuelos, que no cambia, y el
 * campo de formulario de hoteles y autos, con las dos fechas en un solo control.
 */

const noop = () => undefined;

function picker(props: Partial<DateRangePickerProps>): string {
  return renderToStaticMarkup(
    createElement(DateRangePicker, {
      mode: 'roundtrip',
      value: { start: null, end: null },
      onChange: noop,
      min: '2026-10-01',
      ...props,
    }),
  );
}

describe('vuelos: el talón de siempre', () => {
  it('rótulos Ida y Vuelta dentro de las mitades y los campos de siempre', () => {
    const html = picker({ value: { start: '2026-10-12', end: '2026-10-19' } });
    expect(html).toContain('>Ida</span>');
    expect(html).toContain('>Vuelta</span>');
    expect(html).toContain('name="departureDate" value="2026-10-12"');
    expect(html).toContain('name="returnDate" value="2026-10-19"');
    expect(html).toContain('h-14');
    expect(html).toContain('lun 12 oct');
  });

  it('sin fechas, en tú', () => {
    const html = picker({});
    expect(html).toContain('Elige fecha');
    expect(html).toContain('Agregar vuelta');
    expect(html).not.toContain('Elija');
  });
});

describe('hoteles: entrada y salida en un solo campo', () => {
  it('manda checkinDate y checkoutDate como fechas de calendario, sin hora ni huso', () => {
    const html = picker({
      purpose: 'stay',
      size: 'md',
      startName: 'checkinDate',
      endName: 'checkoutDate',
      value: { start: '2026-10-12', end: '2026-10-15' },
    });
    expect(html).toContain('name="checkinDate" value="2026-10-12"');
    expect(html).toContain('name="checkoutDate" value="2026-10-15"');
  });

  it('el alto de un campo de formulario, con cada mitad nombrada', () => {
    const html = picker({
      purpose: 'stay',
      size: 'md',
      value: { start: '2026-10-12', end: '2026-10-15' },
    });
    expect(html).toContain('h-10');
    expect(html).not.toContain('h-14');
    expect(html).toContain('Entrada: ');
    expect(html).toContain('Salida: ');
    // Las noches van en el rótulo del campo (hoteles/page), no dentro: adentro no cabían y
    // cortaban las fechas entre 1024 y 1200 px y a 320 px.
    expect(html).not.toContain('noches');
  });

  it('con fecha, lo que se ve forma parte del nombre de cada mitad (se puede decir por voz)', () => {
    const html = picker({
      purpose: 'stay',
      size: 'md',
      value: { start: '2026-10-12', end: '2026-10-15' },
    });
    const visible = /<span class="truncate text-sm[^"]*"([^>]*)>lun 12 oct<\/span>/.exec(html);
    expect(visible).not.toBeNull();
    expect(visible?.[1]).not.toContain('aria-hidden');
  });

  it('el rango confirmado se anuncia desde una región viva que queda montada', () => {
    const html = picker({ purpose: 'stay', size: 'md' });
    expect(html).toContain('<p class="sr-only" aria-live="polite" aria-atomic="true"></p>');
  });

  it('el aro de foco se dibuja hacia adentro: el talón recorta lo que sale', () => {
    const html = picker({ purpose: 'stay', size: 'md' });
    expect(html.match(/focus-visible:-outline-offset-2!/g)).toHaveLength(2);
  });

  it('sin fechas, cada mitad dice cuál es', () => {
    const html = picker({ purpose: 'stay', size: 'md' });
    expect(html).toContain('>Entrada</span>');
    expect(html).toContain('>Salida</span>');
    expect(html).not.toContain('noches');
  });

  it('marcado como problema: borde de error y el mensaje asociado a las dos mitades', () => {
    const html = picker({ purpose: 'stay', size: 'md', invalid: true, describedBy: 'err' });
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
    expect(html.match(/aria-describedby="err"/g)).toHaveLength(2);
    expect(html).toContain('border-[var(--color-danger)]');
  });

  it('el rótulo del campo nombra al grupo', () => {
    const html = picker({ purpose: 'stay', size: 'md', labelledBy: 'fechas' });
    expect(html).toContain('role="group" aria-labelledby="fechas"');
  });
});

describe('autos: recogida y devolución', () => {
  it('rótulos de autos y sin conteo de noches (los días dependen de las horas)', () => {
    const html = picker({
      purpose: 'rental',
      size: 'md',
      value: { start: '2026-10-12', end: '2026-10-15' },
    });
    expect(html).toContain('Recogida: ');
    expect(html).toContain('Devolución: ');
    expect(html).not.toContain('noches');
  });
});
