import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildEmptyPassengers,
  PassengerForm,
  titleForGender,
  withCustomerAsFirstPassenger,
} from './passenger-form';
import { PaymentForm } from './payment-form';

describe('buildEmptyPassengers', () => {
  it('asigna el índice global que Sabre Offer Price usa en orden ADT → CHD → INF', () => {
    const passengers = buildEmptyPassengers({ adults: 2, children: 1, infants: 1 });

    expect(
      passengers.map(({ paxType, requestedTravelerIndex }) => ({
        paxType,
        requestedTravelerIndex,
      })),
    ).toEqual([
      { paxType: 'ADT', requestedTravelerIndex: 0 },
      { paxType: 'ADT', requestedTravelerIndex: 1 },
      { paxType: 'CHD', requestedTravelerIndex: 2 },
      { paxType: 'INF', requestedTravelerIndex: 3 },
    ]);
  });
});

/*
 * D1: la plataforma nunca recibe un PAN ni un CVV. createOrder no cobra y el API rechaza
 * `payment` (`orders/dto.ts`, schema strict), así que el checkout de vuelos no puede tener ni un
 * campo capaz de recibir una tarjeta. Había uno escondido detrás de `paymentSupported`, una prop
 * que nadie pasaba: código muerto que bastaba con encender para que un PAN viajara al servidor.
 */

/** Rastros de un formulario de tarjeta en el HTML pintado. */
const CARD_MARKERS: readonly RegExp[] = [
  /autocomplete="cc-/i,
  /tarjeta/i,
  /\bcvv\b/i,
  /c[oó]digo de seguridad/i,
  /datos de pago/i,
  /pagar ahora/i,
];

function cardTraces(html: string): string[] {
  return CARD_MARKERS.filter((re) => re.test(html)).map((re) => re.source);
}

function renderCheckout(paxCount = { adults: 2, children: 1, infants: 1 }): string {
  return renderToStaticMarkup(
    createElement(PassengerForm, {
      paxCount,
      customerName: 'Juan Carlos Pérez Gómez',
      contactEmail: 'juan@example.com',
      contactPhone: '3001234567',
      onSubmit: async () => {},
    }),
  );
}

describe('PassengerForm — el checkout de vuelos no pide tarjeta (D1)', () => {
  it('no pinta ningún campo de tarjeta', () => {
    expect(cardTraces(renderCheckout())).toEqual([]);
  });

  it('CONTROL: el detector sí ve el formulario de tarjeta que había', () => {
    const tarjeta = renderToStaticMarkup(
      createElement(PaymentForm, {
        totalAmountMinor: 120_000,
        currency: 'USD',
        onPaymentChange: () => {},
      }),
    );
    expect(cardTraces(tarjeta)).toEqual(
      expect.arrayContaining(['autocomplete="cc-', 'tarjeta', '\\bcvv\\b']),
    );
  });

  it('dice que la reserva sale sin cobro y que el pago y la emisión se hacen en Reservas', () => {
    const html = renderCheckout({ adults: 1, children: 0, infants: 0 });
    expect(html).toContain('Pago y emisión');
    expect(html).toContain('Reserva sin cobro');
    expect(html).toContain('El pago y la emisión se hacen después desde');
    expect(html).toMatch(/<button[^>]*>.*Crear reserva<\/button>/);
    expect(html).not.toContain('BNPL');
  });

  it('el único campo de teclado numérico es la fecha de nacimiento', () => {
    const html = renderCheckout({ adults: 1, children: 0, infants: 0 });
    const numericos = html.match(/<input[^>]*inputmode="numeric"[^>]*>/gi) ?? [];
    expect(numericos).toHaveLength(1);
    expect(numericos[0]).toMatch(/autocomplete="bday"/i);
  });

  it('ni el formulario ni la página del checkout importan el formulario de tarjeta', () => {
    for (const file of ['./passenger-form.tsx', './page.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/payment-form/);
      // Sin comentarios, que sí explican por qué no hay `payment`: en el código no puede quedar
      // ni el campo (tampoco abreviado, `{ ...body, payment }`) ni los tipos de la tarjeta.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      expect(code, file).not.toMatch(/payment/i);
    }
  });
});

describe('withCustomerAsFirstPassenger — «El cliente es quien viaja»', () => {
  const vacios = () => buildEmptyPassengers({ adults: 2, children: 0, infants: 0 });

  it('marcado, el pasajero 1 toma nombre y apellidos del cliente con el reparto LATAM', () => {
    const out = withCustomerAsFirstPassenger(vacios(), 'Juan Carlos Pérez Gómez', true);
    expect(out[0]).toMatchObject({ givenName: 'Juan Carlos', surname: 'Pérez Gómez' });
    expect(out[1]).toMatchObject({ givenName: '', surname: '' });
  });

  it('sigue al cliente: si su nombre cambia, cambia el pasajero 1', () => {
    const pax = vacios();
    expect(withCustomerAsFirstPassenger(pax, 'Ana Ruiz', true)[0]?.surname).toBe('Ruiz');
    expect(withCustomerAsFirstPassenger(pax, 'Ana Ruiz Toro', true)[0]?.surname).toBe('Ruiz Toro');
  });

  it('desmarcado o sin cliente, deja lo tecleado tal cual', () => {
    const pax = vacios();
    pax[0] = { ...pax[0]!, givenName: 'MARIA', surname: 'LOPEZ' };
    for (const [nombre, marcado] of [
      ['Juan Pérez', false],
      ['   ', true],
      [undefined, true],
    ] as const) {
      expect(withCustomerAsFirstPassenger(pax, nombre, marcado)[0]).toMatchObject({
        givenName: 'MARIA',
        surname: 'LOPEZ',
      });
    }
  });

  it('el tratamiento por defecto acompaña al género; uno elegido a mano se respeta', () => {
    expect(titleForGender('Mr', 'F')).toBe('Mrs');
    expect(titleForGender('Mrs', 'M')).toBe('Mr');
    expect(titleForGender('Miss', 'M')).toBe('Miss');
    expect(titleForGender('Dr', 'F')).toBe('Dr');
  });
});

describe('PassengerForm — sólo lo necesario', () => {
  function render(props: { customerName?: string; priceChangeTotal?: string } = {}): string {
    return renderToStaticMarkup(
      createElement(PassengerForm, {
        paxCount: { adults: 1, children: 0, infants: 0 },
        contactEmail: 'juan@example.com',
        contactPhone: '3001234567',
        onSubmit: async () => {},
        ...props,
      }),
    );
  }

  it('con cliente, marca «El cliente es quien viaja» y cambia los campos de nombre por una línea', () => {
    const html = render({ customerName: 'Juan Carlos Pérez Gómez' });
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*checked=""[^>]*>El cliente es quien viaja/,
    );
    expect(html).toContain('Nombre en el documento:');
    expect(html).toContain('>Juan Carlos Pérez Gómez</span>');
    expect(html).toMatch(/<button[^>]*>Editar<\/button>/);
    expect(html).not.toContain('placeholder="OLIVER"');
  });

  it('sin cliente no hay casilla y los nombres se escriben a mano', () => {
    const html = render();
    expect(html).not.toContain('El cliente es quien viaja');
    expect(html).toContain('placeholder="OLIVER"');
    expect(html).toContain('placeholder="JACKSON"');
  });

  it('el tratamiento va plegado en «Más datos (opcional)»; lo obligatorio queda a la vista', () => {
    const html = render();
    const plegado = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? '';
    expect(plegado).toContain('Más datos (opcional)');
    expect(plegado).toContain('Tratamiento');
    const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
    for (const campo of [
      'Fecha de nacimiento',
      'Género',
      'Tipo de documento',
      'Número de documento',
      'Nacionalidad',
      'País emisor doc.',
    ]) {
      expect(visible, campo).toContain(campo);
    }
    expect(visible).not.toContain('Tratamiento');
    // Las etiquetas apuntan a su campo.
    expect(html).toMatch(/<label[^>]*for="pax-ADT_1-doc-number"/);
    expect(html).toMatch(/<input[^>]*id="pax-ADT_1-doc-number"/);
  });

  it('con un precio nuevo pregunta junto al botón en vez de ofrecer «Crear reserva»', () => {
    const html = render({ priceChangeTotal: 'USD 1.250,00' });
    expect(html).toContain('El precio cambió a USD 1.250,00. ¿Reservar con el nuevo precio?');
    expect(html).toMatch(/<button[^>]*>.*Reservar con el nuevo precio<\/button>/);
    expect(html).not.toMatch(/Crear reserva<\/button>/);
  });

  it('sin cambio de precio el formulario no está deshabilitado esperando una verificación', () => {
    const html = render({ customerName: 'Ana Ruiz' });
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain('Verifica el precio');
  });
});
