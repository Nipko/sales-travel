import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../../actions';
import { hotelRateRows } from '../../_components/hotel-rate-view';
import { AgencyContactNotice, PrebookSummary, PrebookTotal } from './prebook-summary';
import { agencyContactNotice, continueGate, roomAmenitiesView } from './prebook-view';

/*
 * Sin el contacto de soporte que el Book manda al proveedor, el paso 1 lo dice arriba, con el
 * camino a Mi Agencia, y «Continuar con los huéspedes» queda deshabilitado con el motivo al lado.
 */

const ROOMPACK: HotelRoompack = {
  id: 'pack-1',
  provider: { name: 'tbo-hotels', offerRef: '1402689!TB!1!TB!3f9c', raw: { searchId: 's-1' } },
  board: 'RO',
  rooms: [{ name: 'Deluxe King', reference: 1, bedOptions: [] }],
  cancellation: {
    refundable: true,
    status: 'fully_refundable',
    policySource: 'prebook-final',
    rules: [],
  },
  price: { total: { amountMinor: 30575, currency: 'USD' }, taxesDetail: [] },
};

const ROW = hotelRateRows({ roompacks: [ROOMPACK] }, false)[0]!;

/** El texto pintado, sin etiquetas. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('AgencyContactNotice — falta el contacto de soporte de la agencia', () => {
  it('lo dice como un bloqueo, con el texto del Book y el enlace a Mi Agencia', () => {
    const out = renderToStaticMarkup(
      createElement(AgencyContactNotice, {
        view: agencyContactNotice({ agencyContact: 'missing' }),
      }),
    );
    expect(out).toContain('role="alert"');
    expect(text(out)).toContain('Falta el contacto de soporte de tu agencia.');
    expect(text(out)).toContain('formato internacional (por ejemplo, +57 300 123 4567)');
    expect(out).toContain('href="/configuracion"');
    expect(text(out)).toContain('Ir a Mi Agencia');
  });

  it('con el contacto completo, o sin saberlo, no pinta nada', () => {
    for (const view of [agencyContactNotice({ agencyContact: 'ok' }), undefined]) {
      expect(renderToStaticMarkup(createElement(AgencyContactNotice, { view }))).toBe('');
    }
  });
});

describe('PrebookSummary — los servicios de la habitación (TBO-12)', () => {
  /** Los 12 primeros servicios del PreBook de p. 28 del PDF de TBO. */
  const SERVICIOS = [
    'Non-Smoking',
    'Premium bedding',
    'Turndown service',
    'Iron/ironing board (on request)',
    'Satellite TV service',
    'Soundproofed rooms',
    'Room service',
    'In-room climate control (air conditioning)',
    'Blackout drapes/curtains',
    'Minibar',
    'Separate bathtub and shower',
    'Free wired internet',
  ];

  function resumen(roompack: HotelRoompack, roomAmenities?: readonly (readonly string[])[]) {
    const row = hotelRateRows({ roompacks: [roompack] }, false)[0]!;
    const amenities = roomAmenitiesView({
      roompack,
      ...(roomAmenities === undefined ? {} : { roomAmenities }),
    });
    return renderToStaticMarkup(
      createElement(PrebookSummary, {
        row,
        expired: false,
        ...(amenities === undefined ? {} : { amenities }),
      }),
    );
  }

  /** Las etiquetas de servicios pintadas, en orden. */
  function chips(html: string): string[] {
    return [...html.matchAll(/<li class="[^"]*rounded-full[^"]*">([^<]*)<\/li>/g)].map(
      (m) => m[1] ?? '',
    );
  }

  it('un bloque con título, 8 etiquetas a la vista y «Ver todos (12)» que controla la lista', () => {
    const out = resumen(ROOMPACK, [SERVICIOS]);

    expect(out).toMatch(/<section aria-labelledby="([^"]+)"[^>]*>.*<h3 id="\1"/);
    expect(text(out)).toContain('Servicios de la habitación');
    expect(text(out)).toContain('Como los informa el proveedor, en su idioma.');
    expect(chips(out)).toEqual(SERVICIOS.slice(0, 8));
    const listId = /<ul id="([^"]+)" class="flex flex-wrap/.exec(out)?.[1];
    expect(listId).toBeDefined();
    expect(out).toMatch(
      new RegExp(`<button type="button" aria-expanded="false" aria-controls="${listId}"`),
    );
    expect(text(out)).toContain('Ver todos (12)');
    expect(text(out)).not.toContain('Habitación 1');
  });

  it('con 8 o menos, todas a la vista y sin botón', () => {
    const out = resumen(ROOMPACK, [SERVICIOS.slice(0, 3)]);
    expect(chips(out)).toEqual(SERVICIOS.slice(0, 3));
    expect(out).not.toContain('aria-expanded');
  });

  it('dos habitaciones con servicios distintos: un bloque por habitación, «Habitación 2» con su nombre', () => {
    const out = resumen(
      {
        ...ROOMPACK,
        rooms: [
          { name: 'Deluxe King', reference: 1, bedOptions: [] },
          { name: 'Suite Junior', reference: 2, bedOptions: [] },
        ],
      },
      [['Free WiFi'], []],
    );
    expect(text(out)).toContain('Servicios de las habitaciones');
    expect(text(out)).toContain('Habitación 1 · Deluxe King');
    expect(text(out)).toContain('Habitación 2 · Suite Junior');
    expect(text(out)).toContain('El proveedor no informó servicios para esta habitación.');
    expect(chips(out)).toEqual(['Free WiFi']);
  });

  it('lo que parece marcado se pinta como texto (RF-16)', () => {
    const out = resumen(ROOMPACK, [['<img src=x onerror=alert(1)>']]);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('sin servicios, la tarifa se pinta igual y sin el bloque', () => {
    const out = resumen(ROOMPACK);
    expect(text(out)).toContain('Tarifa revalidada');
    expect(out).not.toContain('<section');
    expect(text(out)).not.toContain('Servicios de la habitación');
  });
});

describe('PrebookTotal — el paso siguiente sin el contacto de soporte', () => {
  function total(agencyContact: 'ok' | 'missing'): string {
    return renderToStaticMarkup(
      createElement(PrebookTotal, {
        row: ROW,
        nights: 2,
        gate: continueGate({
          expired: false,
          blocked: false,
          change: undefined,
          accepted: false,
          funding: { status: 'ok' },
          bookingReadiness: { agencyContact },
        }),
        onContinue: () => undefined,
      }),
    );
  }

  it('«Continuar con los huéspedes» queda deshabilitado, con el motivo como descripción', () => {
    const out = total('missing');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="[^"]+"/);
    expect(text(out)).toContain(
      'Falta el contacto de soporte de tu agencia: sin él, esta reserva se rechazaría.',
    );
    expect(text(out)).toContain('Continuar con los huéspedes');
  });

  it('con el contacto, sigue', () => {
    const out = total('ok');
    expect(out).not.toMatch(/<button[^>]*disabled=""/);
    expect(text(out)).not.toContain('contacto de soporte');
  });
});
