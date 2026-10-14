import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { voseoIn } from '../../../../lib/voseo';
import {
  TRAVELERS_UI,
  initialForm,
  parseTravelersView,
  type TravelerForm,
} from '../travelers-view';
import {
  EditTravelersSheet,
  TravelersSheetBody,
  type TravelersSheetPhase,
} from './edit-travelers-sheet';

/*
 * «Datos de pasajeros» (SAB-25): el primer pintado (consultando) y el cuerpo con la reserva leída
 * —enmascarada—, los campos con su etiqueta y los servicios especiales de la lista cerrada.
 */

function lista(extra: Record<string, unknown> = {}): TravelersSheetPhase {
  const view = parseTravelersView({
    kind: 'travelers',
    testContent: false,
    supported: ['identityDocuments', 'loyalty', 'specialServices'],
    blocked: null,
    travelers: [
      {
        index: 0,
        givenName: 'Ana',
        surname: 'Pérez',
        paxType: 'ADT',
        documents: [
          {
            type: 'PASSPORT',
            numberLast4: '6543',
            issuingCountry: 'CO',
            nationality: 'CO',
            expiryDate: '2031-05-01',
          },
        ],
        loyalty: [{ carrierCode: 'AV', numberLast4: '7788' }],
        specialServices: ['WCHR'],
      },
      {
        index: 1,
        givenName: 'Leo',
        surname: 'Pérez',
        paxType: 'INF',
        documents: [],
        loyalty: [],
        specialServices: [],
      },
    ],
    warnings: [],
    ...extra,
  });
  if (view === null) throw new Error('vista inválida');
  return { kind: 'ready', view };
}

function cuerpo(
  phase: TravelersSheetPhase,
  o: { errors?: Record<string, string>; busy?: boolean } = {},
): string {
  const forms: Record<number, TravelerForm> =
    phase.kind === 'ready'
      ? Object.fromEntries(phase.view.travelers.map((t) => [t.index, initialForm(t)]))
      : {};
  return renderToStaticMarkup(
    createElement(TravelersSheetBody, {
      phase,
      forms,
      errors: o.errors ?? {},
      busy: o.busy ?? false,
      notice: null,
      onChange: () => undefined,
    }),
  );
}

describe('EditTravelersSheet', () => {
  it('es un panel modal con nombre, arranca consultando y en «tú»', () => {
    const html = renderToStaticMarkup(
      createElement(EditTravelersSheet, {
        order: { id: 'o-1', orderNumber: 7 },
        onClose: () => undefined,
        onChanged: () => undefined,
      }),
    );
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toContain('Datos de pasajeros · Reserva #7');
    expect(html).toContain(TRAVELERS_UI.loading);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Guardar cambios/s);
    expect(voseoIn(html)).toEqual([]);
  });
});

describe('TravelersSheetBody', () => {
  it('por pasajero, lo que la reserva tiene, enmascarado, y los campos con su etiqueta', () => {
    const html = cuerpo(lista());
    expect(html).toContain('Ana Pérez · Adulto');
    expect(html).toContain('En la reserva: Pasaporte ••••6543 · CO · vence 2031-05-01');
    expect(html).toContain('AV ••••7788');
    expect(html).toContain(TRAVELERS_UI.documentHint);
    // Cada campo tiene su <label for>: el lector de pantalla lo nombra.
    for (const label of [
      TRAVELERS_UI.documentType,
      TRAVELERS_UI.documentNumber,
      TRAVELERS_UI.issuingCountry,
      TRAVELERS_UI.nationality,
      TRAVELERS_UI.expiryDate,
      TRAVELERS_UI.loyaltyCarrier,
      TRAVELERS_UI.loyaltyNumber,
    ]) {
      expect(html).toMatch(new RegExp(`<label for="[^"]+"[^>]*>${label}`));
    }
    expect(html).toContain('<fieldset');
    expect(html).toContain('Silla de ruedas (sube y baja escaleras)');
    expect(html).toContain('Comida para diabéticos');
    // La silla que ya tiene sale marcada; el número del documento, vacío.
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(voseoIn(html)).toEqual([]);
  });

  it('un infante no ofrece viajero frecuente ni servicios especiales, y lo dice', () => {
    const html = cuerpo(lista());
    expect(html).toContain('Leo Pérez · Infante');
    expect(html).toContain(TRAVELERS_UI.infantNote);
    expect(html.split(TRAVELERS_UI.loyaltyLegend)).toHaveLength(2);
  });

  it('una reserva que no admite servicios especiales lo dice en vez de ofrecerlos', () => {
    const html = cuerpo(lista({ supported: ['identityDocuments', 'loyalty'] }));
    expect(html).toContain(TRAVELERS_UI.specialNotSupported);
    expect(html).not.toContain('Comida vegetariana');
  });

  it('con otro cambio en curso, todo queda deshabilitado y se dice por qué', () => {
    const html = cuerpo(lista({ blocked: 'Ya hay un cambio en curso en esta reserva.' }));
    expect(html).toContain('Ya hay un cambio en curso en esta reserva.');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it('los errores se anuncian junto a su campo', () => {
    const html = cuerpo(lista(), {
      errors: { '0.documentNumber': 'Escribe sólo letras y números (4 a 20).' },
    });
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/role="alert"[^>]*>Escribe sólo letras y números/);
  });

  it('una reserva de pruebas se marca, y una lectura fallida se dice', () => {
    expect(cuerpo(lista({ testContent: true }))).toContain(TRAVELERS_UI.testNote);
    expect(cuerpo({ kind: 'failed', message: 'No pudimos consultar.' })).toMatch(
      /role="alert"[^>]*>.*No pudimos consultar\./s,
    );
  });
});
