import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../actions';
import { atHotelCharges, hotelRateRows } from '../_components/hotel-rate-view';
import { BookingConfirm } from './_components/booking-confirm';
import { GuestForm } from './_components/guest-form';
import { emptyGuestDraft } from './_components/guest-form-view';

/*
 * D1 en la web (docs/tbo/03 §7; 09 PR-6.4): el checkout de hotel reserva con el crédito de la
 * cuenta (`Limit`) y la agencia paga con su cartera. No hay ningún campo de tarjeta: ni en lo que
 * se pinta ni en el código que arma y reenvía el Book. Y el formulario es el de U-12: un bloque por
 * habitación en el orden de la búsqueda, con el tipo de cada huésped fijo.
 */

const SRC = fileURLToPath(new URL('../../../..', import.meta.url));
const CHECKOUT = fileURLToPath(new URL('.', import.meta.url));

/** Las claves de tarjeta de la regla D1 (`eslint.config.mjs`) y los `autocomplete` de tarjeta. */
const CARD_TERMS =
  /\b(cardNumber|cardSecurityCode|cardHolder|cvv|cvc|securityCode|PaymentInfo|CardNumber|CvvNumber|CardExpirationMonth|CardExpirationYear|CardHolderFirstName|CardHolderLastName|secureToken|NewCard|SavedCard)\b|cc-(number|csc|exp|name|type)/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const ROOMPACK: HotelRoompack = {
  id: 'pack-1',
  provider: { name: 'tbo-hotels', offerRef: '1402689!TB!1!TB!3f9c', raw: { searchId: 's-1' } },
  board: 'RO',
  rooms: [
    { name: 'Deluxe King', reference: 1, bedOptions: [] },
    { name: 'Twin', reference: 2, bedOptions: [] },
  ],
  cancellation: {
    refundable: false,
    status: 'non_refundable',
    policySource: 'prebook-final',
    rules: [],
  },
  price: { total: { amountMinor: 30575, currency: 'USD' }, taxesDetail: [] },
  pricing: { costMinor: 30575, finalMinor: 32134, ownMarkupMinor: 0, currency: 'USD' },
  atPropertyCharges: [
    { roomIndex: 1, description: 'City tax', amount: { amountMinor: 2000, currency: 'AED' } },
  ],
};

function renderStep(): string {
  const draft = emptyGuestDraft(
    [
      { adults: 2, childrenAges: [7] },
      { adults: 1, childrenAges: [] },
    ],
    'CO',
  );
  const row = hotelRateRows({ roompacks: [ROOMPACK] }, false)[0]!;
  return (
    renderToStaticMarkup(
      createElement(GuestForm, {
        draft,
        onChange: () => undefined,
        errors: {},
        roomNames: ROOMPACK.rooms.map((r) => r.name),
        noNameChange: false,
      }),
    ) +
    renderToStaticMarkup(
      createElement(BookingConfirm, {
        row,
        total: row.sale,
        nights: 3,
        cancellation: { headline: 'No reembolsable.', refundable: false },
        atHotel: atHotelCharges(ROOMPACK),
        acknowledged: false,
        onAcknowledgedChange: () => undefined,
        acknowledgeError: undefined,
        nonRefundable: { reason: 'declared', penalty: row.sale },
        nonRefundableAcknowledged: false,
        onNonRefundableAcknowledgedChange: () => undefined,
        nonRefundableError: undefined,
        gate: { ok: true },
        onConfirm: () => undefined,
        onBack: () => undefined,
      }),
    )
  );
}

describe('checkout Limit — ningún campo de tarjeta (D1)', () => {
  it('el código del checkout, la ruta del Book y su contrato no nombran datos de tarjeta', () => {
    const files = [
      ...sources(CHECKOUT),
      ...sources(join(SRC, 'app', 'api', 'hotels')),
      join(SRC, 'lib', 'hotel-book.ts'),
    ];
    expect(files.length).toBeGreaterThan(15);
    const offenders = files
      .filter((file) => CARD_TERMS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('lo que se pinta en el paso 2 no tiene campos de tarjeta ni de documento', () => {
    const html = renderStep();
    expect(html).not.toMatch(CARD_TERMS);
    const types = [...html.matchAll(/<input[^>]*type="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(types)).toEqual(new Set(['radio', 'email', 'tel', 'checkbox']));
    // Los de nombre y apellido no llevan `type`: son texto.
    expect([...html.matchAll(/<input(?![^>]*type=)[^>]*>/g)]).toHaveLength(8);
  });
});

describe('U-12 — los huéspedes por habitación', () => {
  it('un bloque por habitación, en el orden de la búsqueda, con el tipo de cada huésped fijo', () => {
    const html = renderStep();
    const rooms = [...html.matchAll(/>(Habitación \d)</g)].map((m) => m[1]);
    expect(rooms).toEqual(['Habitación 1', 'Habitación 2']);
    const legends = [...html.matchAll(/<legend[^>]*>(.*?)<\/legend>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ''),
    );
    expect(legends).toEqual([
      'Habitación 1, Adulto 1 (titular)',
      'Habitación 1, Adulto 2',
      'Habitación 1, Niño 1 · 7 años',
      'Habitación 2, Adulto 1 (titular)',
      'Contacto del huésped',
    ]);
  });

  it('el título se elige entre Mr, Mrs y Ms, y ninguno arranca marcado', () => {
    const html = renderStep();
    expect([...html.matchAll(/role="radiogroup"/g)]).toHaveLength(4);
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(12);
    expect(html).not.toMatch(/type="radio"[^>]*checked/);
    expect(html).toContain('Sr. (Mr)');
    expect(html).not.toMatch(/value="Dr"/);
  });

  it('una no reembolsable lleva su casilla obligatoria con el 100 % exacto y el recordatorio', () => {
    const html = renderStep();
    expect(html).toContain('Tarifa no reembolsable');
    expect(html).toContain(
      'Entiendo que esta tarifa no es reembolsable: si se cancela, modifica o el pasajero no se presenta, se cobra el 100 %',
    );
    expect(html).toMatch(/se cobra el 100 % \(321,34\s(US\$|USD)\)/);
    expect(html).toContain('revisa los nombres de los huéspedes y las fechas');
    expect(html).toMatch(
      /<input(?=[^>]*name="nonRefundableAcknowledged")(?=[^>]*aria-required="true")[^>]*>/,
    );
  });

  it('los cargos en el hotel están en el paso de reserva, con su casilla (U-13; RF-10)', () => {
    const html = renderStep();
    expect(html).toContain('A pagar en el hotel, aparte del total');
    expect(html).toContain('City tax');
    expect(html).toContain('Le mostré al cliente estos cargos, que paga en el hotel.');
  });
});
