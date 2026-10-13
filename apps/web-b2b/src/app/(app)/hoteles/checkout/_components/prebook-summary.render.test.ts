import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../../actions';
import { hotelRateRows } from '../../_components/hotel-rate-view';
import { AgencyContactNotice, PrebookTotal } from './prebook-summary';
import { agencyContactNotice, continueGate } from './prebook-view';

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
