import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HotelAccountEnvironment, HotelRoompack } from '../../actions';
import { hotelRateRows } from '../../_components/hotel-rate-view';
import { BookingConfirm } from './booking-confirm';
import { ConfirmedPanel } from './booking-panels';
import { PrebookSummary } from './prebook-summary';

/*
 * El checkout con la cuenta de prueba de TBO (el PreBook lo dice en `providerEnvironment`): la
 * tarifa revalidada, el paso que reserva y la reserva confirmada (con su voucher) avisan que la
 * reserva no es real. Con la cuenta de producción, o sin saberlo, nada cambia.
 */

const AVISO =
  'Cuenta de prueba: esta reserva no es real y no le asegura una habitación a tu cliente.';

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

/** El texto pintado, sin etiquetas: el aviso lleva su comienzo en negrita. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function summary(providerEnvironment?: HotelAccountEnvironment): string {
  return renderToStaticMarkup(
    createElement(PrebookSummary, {
      row: ROW,
      expired: false,
      ...(providerEnvironment === undefined ? {} : { providerEnvironment }),
    }),
  );
}

function confirm(providerEnvironment?: HotelAccountEnvironment): string {
  return renderToStaticMarkup(
    createElement(BookingConfirm, {
      row: ROW,
      total: ROW.sale,
      nights: 2,
      cancellation: { headline: 'Cancelación gratis hasta el 10 oct.', refundable: true },
      atHotel: [],
      acknowledged: false,
      onAcknowledgedChange: () => undefined,
      acknowledgeError: undefined,
      nonRefundable: undefined,
      nonRefundableAcknowledged: false,
      onNonRefundableAcknowledgedChange: () => undefined,
      nonRefundableError: undefined,
      ...(providerEnvironment === undefined ? {} : { providerEnvironment }),
      gate: { ok: true },
      onConfirm: () => undefined,
      onBack: () => undefined,
    }),
  );
}

function confirmed(providerEnvironment?: HotelAccountEnvironment): string {
  return renderToStaticMarkup(
    createElement(ConfirmedPanel, {
      view: { orderId: 'ord-1', orderNumber: 1042, providerBookingId: 'TBO-778' },
      atHotel: [],
      headingRef: createRef<HTMLHeadingElement>(),
      ...(providerEnvironment === undefined ? {} : { providerEnvironment }),
    }),
  );
}

describe('checkout con la cuenta de prueba', () => {
  it('la tarifa revalidada lo avisa', () => {
    const html = summary('test');
    expect(html).toContain('role="note"');
    expect(text(html)).toContain(AVISO);
  });

  it('el paso que reserva lo avisa antes del botón «Confirmar reserva»', () => {
    const plain = text(confirm('test'));
    expect(plain).toContain(AVISO);
    expect(plain.indexOf(AVISO)).toBeLessThan(plain.lastIndexOf('Confirmar reserva'));
  });

  it('la reserva confirmada lo sigue diciendo, antes del voucher que se le podría mandar al cliente', () => {
    const plain = text(confirmed('test'));
    expect(plain).toContain('Reserva confirmada');
    expect(plain).toContain(AVISO);
    expect(plain.indexOf(AVISO)).toBeLessThan(plain.indexOf('Voucher (PDF)'));
  });

  it('con la cuenta de producción, o sin saberlo, no hay aviso', () => {
    for (const html of [
      summary('live'),
      summary(),
      confirm('live'),
      confirm(),
      confirmed('live'),
      confirmed(),
    ]) {
      expect(text(html)).not.toContain('Cuenta de prueba');
    }
  });
});
