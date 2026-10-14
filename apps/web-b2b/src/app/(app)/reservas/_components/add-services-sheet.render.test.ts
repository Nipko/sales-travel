import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SERVICES_UI, parseServicesCatalog, selectionKey } from '../services-view';
import { AddServicesSheet, ServicesSheetBody, type ServicesSheetPhase } from './add-services-sheet';

/*
 * El panel de maletas y servicios (SAB-20): el primer pintado (consultando), y el cuerpo con un
 * catálogo —por pasajero, por tramo, con precio, lo agregado con «Quitar» y lo que no se puede
 * agregar deshabilitado con su motivo—.
 */

const PASAJEROS = [
  { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' },
  { givenName: 'Leo', surname: 'Pérez', paxType: 'CHD' },
];

function catalogo(extra: Record<string, unknown> = {}): ServicesSheetPhase {
  const catalog = parseServicesCatalog({
    kind: 'ancillaries',
    currency: 'USD',
    orderTotalMinor: 100000,
    testContent: false,
    segments: [{ index: 0, origin: 'BOG', destination: 'LIM', carrier: 'AV', flightNumber: '123' }],
    offers: [
      {
        serviceOfferItemId: 'BAG-1',
        category: 'BAGGAGE',
        name: 'Maleta 23 kg',
        segmentRefs: [0],
        weights: [{ value: 23, unit: 'KG' }],
        passengers: [
          { passengerIndex: 0, amountMinor: 4500, included: false },
          { passengerIndex: 1, amountMinor: 3000, included: false },
        ],
        addable: true,
        notAddableText: null,
      },
      {
        serviceOfferItemId: 'PET-1',
        category: 'PET',
        name: 'Mascota en cabina',
        segmentRefs: [0],
        weights: [],
        passengers: [{ passengerIndex: 0, amountMinor: 9000, included: false }],
        addable: false,
        notAddableText: 'Se compra directo con la aerolínea.',
      },
    ],
    added: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        passengerIndex: 1,
        name: 'Comida caliente',
        category: 'MEAL',
        segments: [{ origin: 'BOG', destination: 'LIM' }],
        amountMinor: 1500,
        currency: 'USD',
        status: 'active',
        removable: true,
        removalGroup: null,
      },
    ],
    warnings: [],
    blocked: null,
    ...extra,
  });
  if (catalog === null) throw new Error('catálogo inválido');
  return { kind: 'ready', catalog };
}

function cuerpo(phase: ServicesSheetPhase, selected: string[] = []): string {
  return renderToStaticMarkup(
    createElement(ServicesSheetBody, {
      phase,
      passengers: PASAJEROS,
      selected: new Set(selected),
      busy: null,
      notice: null,
      onToggle: () => undefined,
      onRemove: () => undefined,
    }),
  );
}

describe('AddServicesSheet', () => {
  it('es un panel modal con nombre, y arranca consultando, con «Agregar» deshabilitado', () => {
    const html = renderToStaticMarkup(
      createElement(AddServicesSheet, {
        order: { id: 'o-1', orderNumber: 7, passengers: PASAJEROS },
        onClose: () => undefined,
        onChanged: () => undefined,
      }),
    );
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toContain('Servicios adicionales · Reserva #7');
    expect(html).toContain(SERVICES_UI.loading);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Agregar a la reserva/s);
  });
});

describe('ServicesSheetBody', () => {
  it('por pasajero, por tramo y con precio; cada casilla con su etiqueta', () => {
    const html = cuerpo(catalogo());
    expect(html).toContain('Pasajero 1 · Ana Pérez (adulto)');
    expect(html).toContain('Pasajero 2 · Leo Pérez (niño)');
    expect(html).toContain('BOG → LIM');
    expect(html).toContain('Maleta 23 kg');
    expect(html).toContain('23 KG');
    expect(html).toContain('45,00');
    expect(html).toContain('30,00');
    // Las casillas viven dentro de su <label>: el lector de pantalla lee el nombre y el precio.
    expect(html).toMatch(/<label[^>]*><input type="checkbox"/);
    expect(html).toContain('<fieldset');
    expect(html).toContain(SERVICES_UI.paymentNote);
  });

  it('lo que no se puede agregar se ve deshabilitado, con el motivo', () => {
    const html = cuerpo(catalogo());
    expect(html).toContain('Mascota en cabina');
    expect(html).toContain('Se compra directo con la aerolínea.');
    expect(html).toMatch(/<input type="checkbox" disabled=""/);
  });

  it('lo agregado se lista con su estado y un «Quitar» que nombra el servicio', () => {
    const html = cuerpo(catalogo());
    expect(html).toContain(SERVICES_UI.added);
    expect(html).toContain('Comida caliente');
    expect(html).toContain('Agregado');
    expect(html).toContain('aria-label="Quitar Comida caliente"');
  });

  it('lo marcado sale marcado', () => {
    const html = cuerpo(catalogo(), [selectionKey('BAG-1', 0)]);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
  });

  it('con un cambio en curso o en duda, nada se puede tocar y se dice por qué', () => {
    const html = cuerpo(
      catalogo({ blocked: 'Un cambio de servicios anterior quedó sin confirmar.' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('quedó sin confirmar');
    expect(html).not.toMatch(/<input type="checkbox"(?![^>]*disabled)/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Quitar Comida caliente"/);
  });

  it('una reserva de prueba lo avisa', () => {
    expect(cuerpo(catalogo({ testContent: true }))).toContain(SERVICES_UI.testNote);
  });

  it('sin nada publicado lo dice, en vez de una lista vacía', () => {
    expect(cuerpo(catalogo({ offers: [], added: [] }))).toContain(SERVICES_UI.empty);
  });

  it('si no se pudo consultar, el motivo en una alerta', () => {
    const html = cuerpo({ kind: 'failed', message: SERVICES_UI.loadFailed });
    expect(html).toContain('role="alert"');
    expect(html).toContain(SERVICES_UI.loadFailed);
  });
});
