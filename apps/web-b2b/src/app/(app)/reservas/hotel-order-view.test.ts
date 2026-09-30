import { describe, expect, it } from 'vitest';
import {
  guestContactOf,
  hcnViewOf,
  hotelConditionsOf,
  hotelNonRefundableOf,
  hotelOrderRowOf,
  hotelOrderStateOf,
  hotelPackOf,
  hotelReadResultOf,
  hotelRefOf,
  hotelRoomsOf,
  hotelStayOf,
  hotelVoucherAvailable,
  leadGuestOf,
  parseHotelTracking,
  providerStatusViewOf,
  type HotelOrderInput,
} from './hotel-order-view';

/**
 * Una orden de hotel como la devuelve `GET /orders` (docs/tbo/09 PR-6.5): `selectedOffer` y
 * `passengers` como los escribe `hotel-booking.service.ts`, y `providerTracking` como
 * `publicHotelOrderTracking`.
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

function orden(over: Partial<HotelOrderInput> = {}): HotelOrderInput {
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
      rooms: [
        { adults: 2, childrenAges: [7] },
        { adults: 1, childrenAges: [] },
      ],
      guestNationality: 'CO',
    },
    selectedOffer: {
      vertical: 'hotels',
      providerCode: 'tbo-hotels',
      hotelId: '1402689',
      checkinDate: '2026-10-12',
      checkoutDate: '2026-10-15',
      roompack: {
        id: 'pack-1',
        provider: { name: 'tbo-hotels', offerRef: 'REF' },
        board: 'RO',
        boardLabel: 'Solo habitación',
        rooms: [
          { name: 'Deluxe King', reference: 1, bedOptions: [] },
          { name: 'Twin', reference: 2, bedOptions: [] },
        ],
        cancellation: {
          refundable: true,
          status: 'partially_refundable',
          policySource: 'prebook-final',
          rules: [
            { type: 'Percentage', penaltyPercentage: 50, fromLocalDateTime: '2026-10-10T00:00:00' },
          ],
        },
        price: { total: { amountMinor: 30000, currency: 'USD' }, taxesDetail: [] },
        pricing: { costMinor: 30000, finalMinor: 36000, ownMarkupMinor: 6000, currency: 'USD' },
        atPropertyCharges: [
          { roomIndex: 1, description: 'City tax', amount: { amountMinor: 2000, currency: 'AED' } },
        ],
      },
      rateConditions: [
        { category: 'checkIn', text: 'Check-in desde las 15:00', raw: '<b>Check-in</b> 15:00' },
        { category: 'inventada', text: 'Mascotas no', raw: 'x' },
        { category: 'other', text: '   ', raw: '' },
      ],
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
          {
            paxType: 'CHD',
            title: 'Ms',
            firstName: 'Ana',
            lastName: 'Núñez',
            sent: { firstName: 'Ana', lastName: 'Nunez' },
          },
        ],
      },
      {
        room: 1,
        guests: [
          {
            paxType: 'ADT',
            title: 'Mrs',
            firstName: 'Laura',
            lastName: 'Gómez',
            sent: { firstName: 'LAURA', lastName: 'GOMEZ' },
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

function conSeguimiento(patch: Record<string, unknown>, over: Partial<HotelOrderInput> = {}) {
  return orden({ ...over, providerTracking: { ...TRACKING, ...patch } });
}

describe('hotelOrderStateOf — "Verificando" y "Cancelación en curso" (D-TBO-25 A, U-14)', () => {
  it('confirmada', () => {
    expect(hotelOrderStateOf(orden())).toMatchObject({
      label: 'Confirmada',
      tone: 'confirmed',
      cancelInProgress: false,
    });
  });

  it('un Book incierto se ve "Verificando", nunca "Fallida"', () => {
    const state = hotelOrderStateOf(
      conSeguimiento(
        { subStatus: 'create-uncertain', providerStatus: null },
        { status: 'pending' },
      ),
    );
    expect(state.label).toBe('Verificando');
    expect(state.notice?.title).toBe('Verificando con el proveedor');
    expect(state.notice?.detail).toMatch(/No la repitas/);
  });

  it('la recuperación que todavía no la encuentra: verificando, en revisión', () => {
    expect(
      hotelOrderStateOf(
        conSeguimiento({ subStatus: 'create-not-found-yet' }, { status: 'pending' }),
      ),
    ).toMatchObject({ label: 'Verificando', tone: 'review' });
  });

  it('confirmada con la lectura de cierre pendiente: confirmada, con la marca "Verificando"', () => {
    expect(hotelOrderStateOf(conSeguimiento({ subStatus: 'unverified-read' }))).toMatchObject({
      label: 'Confirmada',
      flag: 'Verificando',
    });
  });

  it('el claim de cancelación y el desenlace sin verificar: "Cancelación en curso"', () => {
    for (const subStatus of ['cancel-requested', 'cancel-unverified']) {
      expect(hotelOrderStateOf(conSeguimiento({ subStatus }, { status: 'pending' }))).toMatchObject(
        { label: 'Cancelación en curso', tone: 'progress', cancelInProgress: true },
      );
    }
    expect(
      hotelOrderStateOf(conSeguimiento({ subStatus: 'cancel-unverified' }, { status: 'pending' }))
        .notice?.title,
    ).toBe('Cancelación sin confirmar');
  });

  it('el proveedor procesando la cancelación, sin subestado: "Cancelación en curso"', () => {
    for (const providerStatus of [
      'CancellationInProgress',
      'CancelPending',
      'CxlRequestSentToHotel',
    ]) {
      expect(
        hotelOrderStateOf(conSeguimiento({ providerStatus }, { status: 'pending' })).label,
      ).toBe('Cancelación en curso');
    }
  });

  it('cancelada con el reembolso del proveedor pendiente lo explica', () => {
    const state = hotelOrderStateOf(
      conSeguimiento(
        { providerStatus: 'CancelledAndRefundAwaited', refundAwaited: true },
        { status: 'cancelled' },
      ),
    );
    expect(state).toMatchObject({ label: 'Cancelada', tone: 'cancelled' });
    expect(state.notice?.detail).toMatch(/reembolso/);
  });

  it('fallida con el mensaje de la orden; un estado desconocido va a revisión', () => {
    expect(
      hotelOrderStateOf(orden({ status: 'failed', errorMessage: 'Sin disponibilidad.' })).notice,
    ).toEqual({ title: 'La reserva no se hizo', detail: 'Sin disponibilidad.' });
    expect(
      hotelOrderStateOf(conSeguimiento({ subStatus: 'unknown' }, { status: 'pending' })).label,
    ).toBe('En revisión');
  });

  it('sin seguimiento, el estado de la orden a secas', () => {
    expect(hotelOrderStateOf(orden({ status: 'pending', providerTracking: null })).label).toBe(
      'Pendiente',
    );
  });
});

describe('seguimiento y HCN, sin PII (RF-26, RF-27)', () => {
  it('parseHotelTracking descarta lo que no es un código', () => {
    expect(
      parseHotelTracking({
        ...TRACKING,
        providerStatus: '<script>',
        subStatus: 'cancel requested',
      }),
    ).toMatchObject({ providerStatus: null, subStatus: null });
    expect(parseHotelTracking('roto')).toBeNull();
  });

  it('el estado del proveedor legible, con su código y cuándo y dónde se leyó', () => {
    const view = providerStatusViewOf(
      parseHotelTracking({ ...TRACKING, providerStatusSource: 'reconciliation' }),
      'UTC',
    );
    expect(view).toEqual({
      label: 'Confirmada',
      code: 'Confirmed',
      seen: '1 oct 2026, 15:04 · en la conciliación diaria',
    });
    expect(
      providerStatusViewOf(parseHotelTracking({ ...TRACKING, providerStatus: 'unknown' }))?.label,
    ).toBe('Estado que no reconocemos');
    expect(providerStatusViewOf(null)).toBeUndefined();
  });

  it('HCN "pendiente" hasta que llega (U-15), con lo que pasa en cada estado del seguimiento', () => {
    expect(hcnViewOf(orden())).toMatchObject({ label: 'Pendiente' });
    expect(hcnViewOf(conSeguimiento({ hcnState: 'out-of-window' }))?.detail).toMatch(
      /más cerca de la fecha de entrada/,
    );
    expect(hcnViewOf(conSeguimiento({ hcnState: 'missing' }))?.detail).toMatch(/operaciones/);
    expect(
      hcnViewOf(conSeguimiento({ hotelConfirmationNumber: 'HCN-778', hcnState: 'received' })),
    ).toEqual({
      value: 'HCN-778',
      label: 'HCN-778',
    });
  });

  it('sin HCN para una reserva que no se hizo o todavía se está confirmando', () => {
    expect(hcnViewOf(orden({ status: 'failed' }))).toBeUndefined();
    expect(hcnViewOf(orden({ status: 'pending', pnr: null }))).toBeUndefined();
    expect(hcnViewOf(orden({ status: 'cancelled' }))?.label).toBe('No disponible');
  });
});

describe('estadía, habitaciones y huéspedes (U-15)', () => {
  it('la estadía con noches y ocupación', () => {
    expect(hotelStayOf(orden())).toMatchObject({
      checkinDate: '2026-10-12',
      checkoutDate: '2026-10-15',
      dates: '12 oct 2026 → 15 oct 2026',
      nights: 3,
      rooms: 2,
      summary: '3 noches · 2 habitaciones · 3 adultos · 1 niño',
    });
    expect(hotelStayOf(orden({ searchCriteria: {}, selectedOffer: {} }))).toBeUndefined();
  });

  it('una habitación por cada una de la búsqueda, con su nombre, ocupación y huéspedes', () => {
    const rooms = hotelRoomsOf(orden());
    expect(rooms).toHaveLength(2);
    expect(rooms[0]).toEqual({
      number: 1,
      name: 'Deluxe King',
      occupancy: '2 adultos · 1 niño (7 años)',
      guests: [
        { name: 'Sr. José Núñez', type: 'Adulto', registeredAs: 'Jose Nunez' },
        { name: 'Srta. Ana Núñez', type: 'Niño', registeredAs: 'Ana Nunez' },
      ],
    });
    // Los acentos cambian cómo figura en el hotel; las mayúsculas solas, no.
    expect(rooms[1]?.guests[0]).toEqual({
      name: 'Sra. Laura Gómez',
      type: 'Adulto',
      registeredAs: 'LAURA GOMEZ',
    });
    const soloMayusculas = hotelRoomsOf(
      orden({
        passengers: [
          {
            room: 0,
            guests: [
              {
                paxType: 'ADT',
                title: 'Mr',
                firstName: 'Pedro',
                lastName: 'Ruiz',
                sent: { firstName: 'PEDRO', lastName: 'RUIZ' },
              },
            ],
          },
        ],
      }),
    );
    expect(soloMayusculas[0]?.guests[0]).toEqual({ name: 'Sr. Pedro Ruiz', type: 'Adulto' });
  });

  it('el titular sin tratamiento; el contacto con el prefijo', () => {
    expect(leadGuestOf(orden())).toBe('José Núñez');
    expect(guestContactOf(orden())).toEqual({
      email: 'huesped@example.test',
      phone: '+57 3001234567',
    });
  });

  it('condiciones saneadas, sin la versión cruda y sin vacías', () => {
    expect(hotelConditionsOf(orden())).toEqual([
      { category: 'checkIn', text: 'Check-in desde las 15:00' },
      { category: 'other', text: 'Mascotas no' },
    ]);
  });

  it('la ficha del hotel se pide con el proveedor y el id de la orden, si son válidos', () => {
    expect(hotelRefOf(orden())).toEqual({ provider: 'tbo-hotels', hotelId: '1402689' });
    expect(hotelRefOf(orden({ searchCriteria: { hotelId: '../x' } }))).toBeUndefined();
    expect(hotelRefOf(orden({ provider: 'TBO Hotels' }))).toBeUndefined();
  });

  it('una tarifa ilegible no se pinta', () => {
    expect(hotelPackOf(orden())).toBeDefined();
    expect(hotelPackOf(orden({ selectedOffer: { roompack: { rooms: [] } } }))).toBeUndefined();
  });
});

describe('la fila de la lista y el voucher', () => {
  it('fechas, noches, habitaciones y titular; se busca por localizador, HCN y huésped', () => {
    const row = hotelOrderRowOf(
      conSeguimiento({ hotelConfirmationNumber: 'HCN-778', hcnState: 'received' }),
    );
    expect(row.title).toBe('Hotel · 12 oct 2026 → 15 oct 2026');
    expect(row.detail).toBe('3 noches · 2 habitaciones · José Núñez');
    for (const q of ['42', '1234567', 'hcn-778', 'gómez', 'gomez', '2026-10-12']) {
      expect(row.searchText).toContain(q);
    }
  });

  it('voucher sólo para una reserva confirmada con localizador y sin cancelación en curso', () => {
    expect(hotelVoucherAvailable(orden())).toBe(true);
    expect(hotelVoucherAvailable(orden({ pnr: null }))).toBe(false);
    expect(hotelVoucherAvailable(orden({ status: 'pending' }))).toBe(false);
    expect(hotelVoucherAvailable(orden({ status: 'cancelled' }))).toBe(false);
    expect(
      hotelVoucherAvailable(conSeguimiento({ providerStatus: 'CancellationInProgress' })),
    ).toBe(false);
  });
});

describe('hotelReadResultOf — "Actualizar estado" (U-16)', () => {
  it('lo que informa el proveedor, con el HCN si llegó, y el seguimiento nuevo', () => {
    const result = hotelReadResultOf(200, {
      vertical: 'hotels',
      orderId: 'x',
      found: true,
      providerStatus: 'Vouchered',
      hotelConfirmationNumber: 'HCN-1',
      refundAwaited: false,
      warnings: [],
      tracking: { ...TRACKING, providerStatus: 'Vouchered', hotelConfirmationNumber: 'HCN-1' },
    });
    expect(result).toMatchObject({
      ok: true,
      message:
        'El proveedor la informa como «Confirmada, con voucher emitido». Número de confirmación del hotel: HCN-1.',
    });
    expect(result.ok && result.tracking?.hotelConfirmationNumber).toBe('HCN-1');
  });

  it('no encontrada: no se vuelve a reservar', () => {
    expect(
      hotelReadResultOf(200, { vertical: 'hotels', found: false, tracking: null }).message,
    ).toMatch(/no la vuelvas a reservar/);
  });

  it('un error del API con su mensaje; un 5xx o una respuesta rara, genéricos', () => {
    expect(hotelReadResultOf(409, { error: 'La cuenta de la reserva ya no está.' })).toEqual({
      ok: false,
      message: 'La cuenta de la reserva ya no está.',
    });
    expect(hotelReadResultOf(502, { error: 'Bad gateway' }).message).toMatch(/Prueba de nuevo/);
    expect(hotelReadResultOf(200, { found: true }).ok).toBe(false);
  });
});

describe('hotelNonRefundableOf — "No reembolsable" en la orden (pedido del 2026-09-29, punto d)', () => {
  const NO_REEMBOLSABLE = {
    refundable: false,
    status: 'non_refundable',
    policySource: 'prebook-final',
    rules: [],
  };

  function conOferta(patch: Record<string, unknown>, roompack?: Record<string, unknown>) {
    const base = orden();
    const offer = base.selectedOffer as Record<string, unknown>;
    return orden({
      selectedOffer: {
        ...offer,
        ...(roompack === undefined
          ? {}
          : { roompack: { ...(offer['roompack'] as Record<string, unknown>), ...roompack } }),
        ...patch,
      },
    });
  }

  it('lo que la orden guardó al reservar: por qué, el 100 % y cuándo lo aceptó el vendedor', () => {
    const order = conOferta({
      nonRefundable: {
        reason: 'full-penalty-in-force',
        penalty: { amountMinor: 36000, currency: 'USD' },
        fullPenaltySinceLocal: '2026-10-10T00:00:00',
        acknowledgedBy: '55555555-5555-4555-8555-555555555555',
        acknowledgedAt: '2026-10-01T15:04:00.000Z',
        acknowledgedAmount: { amountMinor: 36000, currency: 'USD' },
      },
    });
    expect(hotelNonRefundableOf(order, 'UTC')).toEqual({
      reason: 'full-penalty-in-force',
      penalty: { amountMinor: 36000, currency: 'USD' },
      fullPenaltySinceLocal: '2026-10-10T00:00:00',
      acknowledgedAt: formatReadAtForTest('2026-10-01T15:04:00.000Z'),
    });
  });

  it('una orden de antes con la política declarada no reembolsable: el total de la venta', () => {
    expect(hotelNonRefundableOf(conOferta({}, { cancellation: NO_REEMBOLSABLE }))).toEqual({
      reason: 'declared',
      penalty: { amountMinor: 36000, currency: 'USD' },
    });
  });

  it('una reembolsable no lo es; sin tarifa legible, tampoco se inventa', () => {
    expect(hotelNonRefundableOf(orden())).toBeUndefined();
    expect(hotelNonRefundableOf(orden({ selectedOffer: null }))).toBeUndefined();
  });
});

function formatReadAtForTest(iso: string): string {
  return new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
    .format(new Date(iso))
    .replace(/\./g, '');
}
