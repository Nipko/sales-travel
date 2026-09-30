import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// La ficha del hotel es una acción del servidor: en el primer pintado no se llama.
vi.mock('../../../../lib/api', () => ({ api: vi.fn() }));

import { HotelCancelDialog } from './hotel-cancel-dialog';
import { HotelOrderDetail, type HotelOrderDetailOrder } from './hotel-order-detail';

/*
 * El detalle y la cancelación de una reserva de hotel como los ve el vendedor, en su primer pintado
 * (U-15 a U-17): lo que se muestra y lo que no se ofrece según el estado.
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

function orden(over: Partial<HotelOrderDetailOrder> = {}): HotelOrderDetailOrder {
  return {
    id: '5b2f9c1e-8a3d-4f6b-9c2e-1d4a7b8c9e0f',
    orderNumber: 42,
    status: 'confirmed',
    pnr: '1234567',
    provider: 'tbo-hotels',
    capabilities: { retrieve: true, cancel: true, pay: false, services: false, reshop: false },
    searchCriteria: {
      vertical: 'hotels',
      hotelId: '1402689',
      checkinDate: '2026-10-12',
      checkoutDate: '2026-10-15',
      rooms: [{ adults: 2, childrenAges: [] }],
    },
    selectedOffer: {
      roompack: {
        id: 'pack-1',
        provider: { name: 'tbo-hotels', offerRef: 'REF' },
        board: 'RO',
        rooms: [{ name: 'Deluxe King', reference: 1, bedOptions: [] }],
        cancellation: {
          refundable: true,
          status: 'partially_refundable',
          policySource: 'prebook-final',
          rules: [
            {
              type: 'Percentage',
              penaltyPercentage: 50,
              fromLocalDateTime: '2026-10-10T00:00:00',
            },
          ],
        },
        price: { total: { amountMinor: 30000, currency: 'USD' }, taxesDetail: [] },
        pricing: { costMinor: 30000, finalMinor: 36000, ownMarkupMinor: 6000, currency: 'USD' },
        atPropertyCharges: [
          { description: 'City tax', amount: { amountMinor: 2000, currency: 'AED' } },
        ],
      },
      rateConditions: [{ category: 'checkIn', text: 'Check-in 15:00', raw: '<b>15:00</b>' }],
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
    contactInfo: {
      email: 'huesped@example.test',
      phone: { countryCode: '57', number: '3001234567' },
    },
    totalAmount: 36000,
    currency: 'USD',
    errorMessage: null,
    providerTracking: TRACKING,
    createdAt: '2026-10-01T15:00:00.000Z',
    ...over,
  };
}

function detalle(order: HotelOrderDetailOrder): string {
  return renderToStaticMarkup(
    createElement(HotelOrderDetail, {
      order,
      suspended: false,
      onClose: () => undefined,
      onCancelRequest: () => undefined,
      onTrackingChange: () => undefined,
    }),
  );
}

describe('HotelOrderDetail', () => {
  it('confirmada: localizador, HCN pendiente, huéspedes, política, cargos en el hotel y voucher', () => {
    const html = detalle(orden());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Reserva #42');
    expect(html).toContain('1234567');
    expect(html).toContain('Confirmación del hotel (HCN)');
    expect(html).toContain('Pendiente');
    expect(html).toContain('Sr. José Núñez');
    expect(html).toContain('En la reserva del hotel: Jose Nunez');
    expect(html).toContain('Política de cancelación');
    expect(html).toContain('City tax');
    expect(html).toContain('/voucher');
    expect(html).toContain('Actualizar estado');
  });

  it('muestra el precio de venta, nunca el neto del proveedor (G3)', () => {
    const html = detalle(orden());
    expect(html).toMatch(/360,00/);
    expect(html).not.toMatch(/300,00/);
  });

  it('"Cancelación en curso": lo dice y no ofrece otra cancelación ni el voucher', () => {
    const html = detalle(
      orden({
        status: 'pending',
        providerTracking: { ...TRACKING, subStatus: 'cancel-requested' },
      }),
    );
    expect(html).toContain('Cancelación en curso');
    expect(html).not.toContain('Cancelar reserva');
    expect(html).not.toContain('/voucher');
  });

  it('"Verificando": un Book incierto no se ve como fallido', () => {
    const html = detalle(
      orden({
        status: 'pending',
        pnr: null,
        providerTracking: { ...TRACKING, subStatus: 'create-uncertain', providerStatus: null },
      }),
    );
    expect(html).toContain('Verificando');
    expect(html).not.toContain('Fallida');
    expect(html).toContain('Todavía sin localizador');
  });
});

describe('HotelOrderDetail — tarifa no reembolsable (punto d)', () => {
  const noReembolsable = (over: Partial<HotelOrderDetailOrder> = {}) =>
    orden({
      selectedOffer: {
        ...(orden().selectedOffer as Record<string, unknown>),
        nonRefundable: {
          reason: 'declared',
          penalty: { amountMinor: 36000, currency: 'USD' },
          acknowledgedAt: '2026-10-01T15:04:00.000Z',
        },
      },
      ...over,
    });

  it('lo dice arriba, con el 100 % y cuándo lo confirmó el vendedor', () => {
    const html = detalle(noReembolsable());
    expect(html).toContain('No reembolsable');
    expect(html).toContain('Tarifa no reembolsable');
    expect(html).toContain('se cobra el 100 %');
    expect(html).toMatch(/360,00/);
    expect(html).toContain('El vendedor lo confirmó al reservar');
    expect(html).toContain('Enviar confirmación');
  });

  it('cancelada: queda la etiqueta, sin el aviso grande', () => {
    const html = detalle(noReembolsable({ status: 'cancelled' }));
    expect(html).toContain('No reembolsable');
    expect(html).not.toContain('Tarifa no reembolsable');
  });

  it('una reembolsable no lleva ni la etiqueta ni el aviso', () => {
    const html = detalle(orden());
    expect(html).not.toContain('No reembolsable');
  });
});

describe('HotelCancelDialog', () => {
  it('arranca calculando la penalidad, sin ofrecer confirmar todavía', () => {
    const html = renderToStaticMarkup(
      createElement(HotelCancelDialog, { order: orden(), onClose: () => undefined }),
    );
    expect(html).toContain('Cancelar reserva #42');
    expect(html).toContain('Calculando la penalidad estimada');
    expect(html).toContain('No, volver');
    expect(html).not.toContain('Sí, cancelar reserva');
  });

  it('el reintento del historial se confirma igual, con su propio título', () => {
    const html = renderToStaticMarkup(
      createElement(HotelCancelDialog, {
        order: orden(),
        retryOperationId: 'op-1',
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('Reintentar la cancelación de la reserva #42');
    expect(html).toContain('Calculando la penalidad estimada');
    expect(html).not.toContain('Sí, reintentar la cancelación');
  });
});
