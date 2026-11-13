import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildEmptyPassengers,
  PassengerForm,
  passengerLabel,
  titleForGender,
  withCustomerFill,
} from './passenger-form';
import { passengerFromCustomer, type CrmCustomer } from '../../../../lib/customer-search';
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

  it('dice que la reserva sale sin cobro y que el pago y la emisión se hacen en el detalle de la reserva', () => {
    const html = renderCheckout({ adults: 1, children: 0, infants: 0 });
    expect(html).toContain('Pago y emisión');
    expect(html).toContain('Reserva sin cobro');
    expect(html).toContain('El pago y la emisión se hacen después desde');
    expect(html).toMatch(/<button[^>]*>.*Reservar<\/button>/);
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

const ANA: CrmCustomer = {
  id: '3f1c2b4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c',
  customerType: 'person',
  firstName: 'Ana María',
  lastName: 'Ruiz Toro',
  email: 'ana@example.com',
  phone: '3001112233',
  documentType: 'PASAPORTE',
  documentNumber: 'AB123456',
  documentIssuingCountry: 'COL',
  birthdate: '1985-03-09T00:00:00.000Z',
  gender: 'F',
  nationality: 'COL',
  passportExpiry: '2031-01-31',
  address: null,
  city: null,
  countryCode: null,
};

describe('withCustomerFill — «Buscar cliente registrado» en un pasajero', () => {
  it('vuelca nombre, nacimiento, género, nacionalidad y pasaporte de la ficha', () => {
    const [pax] = buildEmptyPassengers({ adults: 1, children: 0, infants: 0 });
    const out = withCustomerFill(pax!, passengerFromCustomer(ANA));
    expect(out).toMatchObject({
      givenName: 'Ana María',
      surname: 'Ruiz Toro',
      birthdate: '1985-03-09',
      gender: 'F',
      title: 'Mrs',
      citizenshipCountryCode: 'CO',
      identityDoc: {
        type: 'P',
        number: 'AB123456',
        issuingCountryCode: 'CO',
        expiryDate: '2031-01-31',
      },
    });
    expect(out.paxId).toBe('ADT_1');
  });

  it('lo que la ficha no trae se conserva', () => {
    const [pax] = buildEmptyPassengers({ adults: 1, children: 0, infants: 0 });
    const typed = { ...pax!, birthdate: '1990-01-01', citizenshipCountryCode: 'PE' };
    const out = withCustomerFill(
      typed,
      passengerFromCustomer({ ...ANA, birthdate: null, nationality: 'Colombia', gender: null }),
    );
    expect(out.birthdate).toBe('1990-01-01');
    expect(out.citizenshipCountryCode).toBe('PE');
    expect(out.gender).toBe('M');
  });

  it('nombra a cada pasajero por tipo y número', () => {
    expect(passengerLabel({ paxType: 'CHD', paxId: 'CHD_2' })).toBe('Niño 2');
  });

  it('el tratamiento por defecto acompaña al género; uno elegido a mano se respeta', () => {
    expect(titleForGender('Mr', 'F')).toBe('Mrs');
    expect(titleForGender('Mrs', 'M')).toBe('Mr');
    expect(titleForGender('Miss', 'M')).toBe('Miss');
    expect(titleForGender('Dr', 'F')).toBe('Dr');
  });
});

describe('PassengerForm — sólo lo necesario', () => {
  function render(
    props: {
      priceChangeTotal?: string;
      billingProblems?: readonly string[];
      onSaveToCrmChange?: (v: boolean) => void;
      saveToCrm?: boolean;
      billingSection?: (state: { attempted: boolean }) => ReactNode;
    } = {},
  ): string {
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

  it('cada pasajero tiene «Buscar cliente registrado» y ya no hay «El cliente es quien viaja»', () => {
    const html = renderToStaticMarkup(
      createElement(PassengerForm, {
        paxCount: { adults: 2, children: 0, infants: 0 },
        onSubmit: async () => {},
      }),
    );
    expect(html.match(/>Buscar cliente registrado<\/label>/g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*role="combobox"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/<label[^>]*for="pax-ADT_1-crm-search"/);
    expect(html).not.toContain('El cliente es quien viaja');
    expect(html).toContain('placeholder="OLIVER"');
    expect(html).toContain('placeholder="JACKSON"');
  });

  it('«Facturación» va entre los pasajeros y el pago, y la casilla de Clientes junto al botón', () => {
    const html = render({
      billingSection: () => createElement('p', null, 'BLOQUE-FACTURACION'),
      saveToCrm: true,
      onSaveToCrmChange: () => {},
    });
    const pasajeros = html.indexOf('pax-ADT_1-doc-number');
    const factura = html.indexOf('BLOQUE-FACTURACION');
    const pago = html.indexOf('Pago y emisión');
    expect(pasajeros).toBeLessThan(factura);
    expect(factura).toBeLessThan(pago);
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*checked=""[^>]*>[\s\S]*Guardar pasajeros y facturador en Clientes/,
    );
  });

  it('sin `onSaveToCrmChange` no pinta la casilla de Clientes', () => {
    expect(render()).not.toContain('Guardar pasajeros y facturador en Clientes');
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
      'País que emitió el documento',
    ]) {
      expect(visible, campo).toContain(campo);
    }
    expect(visible).not.toContain('Tratamiento');
    // Las etiquetas apuntan a su campo.
    expect(html).toMatch(/<label[^>]*for="pax-ADT_1-doc-number"/);
    expect(html).toMatch(/<input[^>]*id="pax-ADT_1-doc-number"/);
  });

  it('con un precio nuevo pregunta junto al botón en vez de ofrecer «Reservar»', () => {
    const html = render({ priceChangeTotal: 'USD 1.250,00' });
    expect(html).toContain('El precio cambió a USD 1.250,00. ¿Reservar con el nuevo precio?');
    expect(html).toMatch(/<button[^>]*>.*Reservar con el nuevo precio<\/button>/);
    expect(html).not.toMatch(/>Reservar<\/button>/);
  });

  it('sin cambio de precio el formulario no está deshabilitado esperando una verificación', () => {
    const html = render();
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain('Verifica el precio');
  });
});
