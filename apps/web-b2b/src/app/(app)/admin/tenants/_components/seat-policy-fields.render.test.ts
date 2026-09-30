import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SeatPolicyFields } from './seat-policy-fields';

function render(required: boolean): string {
  return renderToStaticMarkup(
    createElement(SeatPolicyFields, {
      seats: '',
      idle: '',
      onSeats: () => {},
      onIdle: () => {},
      required,
      parentName: 'Planetour',
      errors: {},
    }),
  );
}

function seatsInput(html: string): string {
  const input = html.match(/<input[^>]*inputmode="numeric"[^>]*>/i)?.[0];
  if (input === undefined) throw new Error('no se dibujó el campo de puestos');
  return input;
}

describe('SeatPolicyFields', () => {
  it('bajo la plataforma, el lector de pantalla sabe que los puestos son obligatorios', () => {
    // El asterisco visible es aria-hidden: el campo tiene que decirlo por su cuenta.
    expect(seatsInput(render(true))).toContain('aria-required="true"');
  });

  it('más abajo es opcional (vacío = heredar) y no se anuncia como obligatorio', () => {
    expect(seatsInput(render(false))).not.toContain('aria-required');
  });
});
