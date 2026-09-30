import { describe, expect, it } from 'vitest';
import type { HotelContent } from '../../../../(app)/hoteles/[hotelKey]/_components/hotel-content-view';
import { VOUCHER_NON_REFUNDABLE, hotelVoucherOf, pdfText } from './hotel-voucher';

/**
 * U-15 (07 §8): el voucher lleva `ConfirmationNumber`, estado, HCN "pendiente", habitaciones,
 * huéspedes, política, `RateConditions` y suplementos `AtProperty`. Y ningún importe de la reserva:
 * lo recibe el cliente final.
 */

const TRACKING = {
  subStatus: null,
  providerStatus: 'Confirmed',
  providerStatusAt: '2026-10-01T15:04:00.000Z',
  providerStatusSource: 'book',
  refundAwaited: false,
  hotelConfirmationNumber: null,
  hcnState: 'scheduled',
};

function orden(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '5b2f9c1e-8a3d-4f6b-9c2e-1d4a7b8c9e0f',
    orderNumber: 42,
    status: 'confirmed',
    pnr: '1234567',
    provider: 'tbo-hotels',
    searchCriteria: {
      vertical: 'hotels',
      hotelId: '1402689',
      checkinDate: '2026-10-12',
      checkoutDate: '2026-10-15',
      rooms: [{ adults: 2, childrenAges: [] }],
    },
    selectedOffer: {
      vertical: 'hotels',
      roompack: {
        id: 'pack-1',
        provider: { name: 'tbo-hotels', offerRef: 'REF' },
        board: 'BB',
        rooms: [{ name: 'Deluxe King', reference: 1, bedOptions: [] }],
        cancellation: {
          refundable: true,
          status: 'partially_refundable',
          policySource: 'prebook-final',
          freeCancellationUntilLocal: '2026-10-09T23:59:00',
          rules: [
            {
              type: 'Fixed',
              penaltyAmount: { amountMinor: 15000, currency: 'USD' },
              fromLocalDateTime: '2026-10-10T00:00:00',
            },
          ],
        },
        price: { total: { amountMinor: 30000, currency: 'USD' }, taxesDetail: [] },
        pricing: { costMinor: 30000, finalMinor: 36000, ownMarkupMinor: 6000, currency: 'USD' },
        atPropertyCharges: [
          { description: 'City tax', amount: { amountMinor: 2000, currency: 'AED' } },
        ],
        includedSupplements: [
          { description: 'Desayuno', amount: { amountMinor: 2500, currency: 'USD' } },
        ],
      },
      rateConditions: [
        { category: 'checkIn', text: 'Check-in desde las 15:00', raw: '<b>15:00</b>' },
      ],
      pricing: { finalMinor: 36000, netMinor: 30000, totalMarkupMinor: 6000, currency: 'USD' },
    },
    passengers: [
      {
        room: 0,
        guests: [
          {
            paxType: 'ADT',
            title: 'Mr',
            firstName: 'José',
            lastName: 'Núñez',
            sent: { firstName: 'Jose', lastName: 'Nunez' },
          },
        ],
      },
    ],
    contactInfo: { email: 'huesped@example.test' },
    totalAmount: 36000,
    currency: 'USD',
    providerTracking: TRACKING,
    createdAt: '2026-10-01T15:00:00.000Z',
    ...over,
  };
}

const CONTENT: HotelContent = {
  providerCode: 'tbo-hotels',
  hotelId: '1402689',
  requestedLang: 'es',
  lang: 'es',
  origin: 'catalog',
  name: 'Hotel Andino',
  stars: 4,
  address: 'Calle 1 # 2-3, Bogotá',
  zipcode: '110111',
  countryCode: 'CO',
  location: null,
  descriptionHtml: null,
  sections: [],
  facilities: [],
  attractionsHtml: null,
  images: [],
  phone: '+57 601 555 0000',
  websiteUrl: null,
  checkInTime: '15:00',
  checkOutTime: '12:00',
};

describe('hotelVoucherOf', () => {
  it('lleva todo lo de U-15', () => {
    const result = hotelVoucherOf(orden(), CONTENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.voucher;
    expect(v).toMatchObject({
      orderNumber: 42,
      locator: '1234567',
      hcn: { label: 'Pendiente' },
      statusLabel: 'Confirmada',
      hotel: {
        name: 'Hotel Andino',
        stars: 4,
        address: 'Calle 1 # 2-3, Bogotá (110111)',
        checkInTime: '15:00',
        checkOutTime: '12:00',
      },
      board: 'Desayuno',
    });
    expect(v.stay?.nights).toBe(3);
    expect(v.rooms[0]).toMatchObject({
      name: 'Deluxe King',
      guests: [{ name: 'Sr. José Núñez', registeredAs: 'Jose Nunez' }],
    });
    expect(v.policy).toMatchObject({ final: true, hotelLocalTime: true });
    expect(v.policy?.headline).toMatch(/sin cargo hasta el 9 oct 2026, 23:59/i);
    expect(v.conditions).toEqual([
      { category: 'checkIn', label: 'Check-in', items: ['Check-in desde las 15:00'] },
    ]);
    expect(v.atHotel).toHaveLength(1);
    expect(v.atHotel[0]?.description).toBe('City tax');
    expect(v.included).toEqual(['Desayuno']);
  });

  it('el HCN, cuando llegó', () => {
    const result = hotelVoucherOf(
      orden({
        providerTracking: { ...TRACKING, hotelConfirmationNumber: 'HCN-9', hcnState: 'received' },
      }),
    );
    expect(result.ok && result.voucher.hcn).toEqual({ value: 'HCN-9', label: 'HCN-9' });
  });

  it('ningún importe de la reserva: ni la venta, ni el neto, ni la penalidad estimada', () => {
    const result = hotelVoucherOf(orden(), CONTENT);
    const text = JSON.stringify(result);
    for (const amount of ['360,00', '300,00', '150,00', '180,00', '60,00', '25,00']) {
      expect(text).not.toContain(amount);
    }
    // La proporción del tramo sí: es la política, no un precio.
    expect(result.ok && result.voucher.policy?.tiers[0]?.charge).toMatch(/50 % del total/);
  });

  it('una reembolsable no lleva el aviso de no reembolsable', () => {
    const result = hotelVoucherOf(orden(), CONTENT);
    expect(result.ok && result.voucher.nonRefundable).toBe(false);
  });

  it('no reembolsable (punto d): lo dice, sin importes, y la política no promete nada gratis', () => {
    const base = orden();
    const offer = base['selectedOffer'] as Record<string, unknown>;
    const result = hotelVoucherOf(
      orden({
        selectedOffer: {
          ...offer,
          nonRefundable: {
            reason: 'full-penalty-in-force',
            penalty: { amountMinor: 36000, currency: 'USD' },
            fullPenaltySinceLocal: '2026-10-10T00:00:00',
            acknowledgedAt: '2026-10-01T15:04:00.000Z',
          },
        },
      }),
      CONTENT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher.nonRefundable).toBe(true);
    expect(result.voucher.policy?.headline).toBe('No reembolsable: el cargo del 100 % ya rige.');
    expect(JSON.stringify(result)).not.toContain('360,00');
    expect(VOUCHER_NON_REFUNDABLE.detail).toMatch(/no hay reembolso/);
  });

  it('sin la ficha del hotel, el voucher sale igual', () => {
    const result = hotelVoucherOf(orden());
    expect(result.ok && result.voucher.hotel).toEqual({});
  });

  it('sólo para una reserva de hotel confirmada', () => {
    expect(hotelVoucherOf(orden({ status: 'pending' }))).toMatchObject({ ok: false, status: 409 });
    expect(hotelVoucherOf(orden({ status: 'cancelled' }))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      hotelVoucherOf(
        orden({ providerTracking: { ...TRACKING, providerStatus: 'CancellationInProgress' } }),
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(hotelVoucherOf(orden({ searchCriteria: { origin: 'BOG' } }))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(hotelVoucherOf(null)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('pdfText', () => {
  it('reescribe los símbolos que la fuente del PDF no tiene', () => {
    expect(pdfText('≈ 50 % del total')).toBe('aprox. 50 % del total');
    expect(pdfText('12 oct → 15 oct')).toBe('12 oct - 15 oct');
  });
});
