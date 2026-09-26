import { describe, expect, it } from 'vitest';
import {
  BookSchema,
  CancelBodySchema,
  GUEST_NATIONALITY_INVALID,
  HotelAvailabilityInputSchema,
  HotelDetailInputSchema,
  HotelSuggestQuerySchema,
  PLATFORM_OCCUPANCY_LIMITS,
  PaymentOptionsQuerySchema,
  PrebookSchema,
  RecoveryBodySchema,
  RoomDistributionSchema,
} from './hotels.schemas.js';

/**
 * Bordes de los esquemas de `/hotels/*` (PR-0.1).
 *
 * Son la única validación entre el browser y los proveedores: lo que pasa acá sale a alguno. Los
 * límites de ocupación (1-8 habitaciones, 1-8 adultos, hasta 6 niños de 0 a 17 años) son los de
 * la plataforma; desde PR-0.5 cada proveedor declara los suyos, más estrechos, y queda fuera de
 * la búsqueda con motivo (`hotel-search.aggregate.test.ts`). Lo que PR-0.5 cambió está marcado.
 */

const busqueda = {
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-13',
  rooms: [{ adults: 2, childrenAges: [7] }],
  destinationId: 2345,
};

function habitaciones(n: number) {
  return Array.from({ length: n }, () => ({ adults: 1 }));
}

function mensajesDe(r: { success: boolean; error?: { issues: { message: string }[] } }) {
  return r.error?.issues.map((i) => i.message) ?? [];
}

describe('PLATFORM_OCCUPANCY_LIMITS', () => {
  it('son los topes que aplica el borde', () => {
    expect(PLATFORM_OCCUPANCY_LIMITS).toEqual({
      maxRooms: 8,
      maxAdultsPerRoom: 8,
      maxChildrenPerRoom: 6,
      maxChildAge: 17,
    });
  });
});

describe('RoomDistributionSchema — ocupación de una habitación', () => {
  it.each([1, 8])('%i adultos pasa', (adults) => {
    expect(RoomDistributionSchema.safeParse({ adults }).success).toBe(true);
  });

  it.each([0, 9, 1.5])('%s adultos no pasa', (adults) => {
    expect(RoomDistributionSchema.safeParse({ adults }).success).toBe(false);
  });

  it('sin niños, `childrenAges` queda en []', () => {
    expect(RoomDistributionSchema.parse({ adults: 2 })).toEqual({ adults: 2, childrenAges: [] });
  });

  it('hasta 6 niños', () => {
    const seis = [1, 2, 3, 4, 5, 6];
    expect(RoomDistributionSchema.safeParse({ adults: 2, childrenAges: seis }).success).toBe(true);
    expect(
      RoomDistributionSchema.safeParse({ adults: 2, childrenAges: [...seis, 7] }).success,
    ).toBe(false);
  });

  it.each([0, 17])('edad %i pasa', (edad) => {
    expect(RoomDistributionSchema.safeParse({ adults: 1, childrenAges: [edad] }).success).toBe(
      true,
    );
  });

  it.each([-1, 18, 3.5])('edad %s no pasa', (edad) => {
    expect(RoomDistributionSchema.safeParse({ adults: 1, childrenAges: [edad] }).success).toBe(
      false,
    );
  });
});

describe('HotelAvailabilityInputSchema', () => {
  it('el cuerpo que manda la web pasa', () => {
    expect(HotelAvailabilityInputSchema.safeParse(busqueda).success).toBe(true);
  });

  it.each([1, 8])('%i habitaciones pasa', (n) => {
    const r = HotelAvailabilityInputSchema.safeParse({ ...busqueda, rooms: habitaciones(n) });
    expect(r.success).toBe(true);
  });

  it.each([0, 9])('%i habitaciones no pasa', (n) => {
    const r = HotelAvailabilityInputSchema.safeParse({ ...busqueda, rooms: habitaciones(n) });
    expect(r.success).toBe(false);
  });

  it('sin destino ni IDs de hotel no pasa, y el error se cuelga de `destinationId`', () => {
    const { destinationId: _sinDestino, ...resto } = busqueda;
    const r = HotelAvailabilityInputSchema.safeParse(resto);

    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({
        path: ['destinationId'],
        message: 'Indicá un destino o al menos un ID de hotel.',
      }),
    ]);
  });

  it('una lista de IDs vacía no reemplaza al destino', () => {
    const { destinationId: _sinDestino, ...resto } = busqueda;
    expect(HotelAvailabilityInputSchema.safeParse({ ...resto, hotelIds: [] }).success).toBe(false);
  });

  it('IDs de hotel sin destino pasa', () => {
    const { destinationId: _sinDestino, ...resto } = busqueda;
    expect(HotelAvailabilityInputSchema.safeParse({ ...resto, hotelIds: ['101'] }).success).toBe(
      true,
    );
  });

  it('hasta 100 IDs de hotel', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
    expect(
      HotelAvailabilityInputSchema.safeParse({ ...busqueda, hotelIds: ids(100) }).success,
    ).toBe(true);
    expect(
      HotelAvailabilityInputSchema.safeParse({ ...busqueda, hotelIds: ids(101) }).success,
    ).toBe(false);
  });

  it('un ID de hotel vacío no pasa', () => {
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, hotelIds: [''] }).success).toBe(
      false,
    );
  });

  it('el destino se coacciona desde texto', () => {
    const r = HotelAvailabilityInputSchema.parse({ ...busqueda, destinationId: '2345' });
    expect(r.destinationId).toBe(2345);
  });

  it.each([0, -5, 1.5, 'abc'])('destino %s no pasa', (destinationId) => {
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, destinationId }).success).toBe(
      false,
    );
  });

  it.each(['2026-1-10', '10/11/2026', '2026-11-10T00:00:00Z'])(
    'fecha %s no pasa: se exige YYYY-MM-DD',
    (checkinDate) => {
      const r = HotelAvailabilityInputSchema.safeParse({ ...busqueda, checkinDate });
      expect(r.success).toBe(false);
      expect(mensajesDe(r)).toContain('fecha esperada YYYY-MM-DD');
    },
  );

  it('la forma de la fecha es todo lo que se valida: un mes 13 o una salida antes de la entrada pasan', () => {
    // Discutible: el esquema no valida el calendario ni el orden de las fechas. La web sí lo
    // hace antes de llamar (`hoteles/actions.ts`), pero la API no.
    expect(
      HotelAvailabilityInputSchema.safeParse({ ...busqueda, checkinDate: '2026-13-45' }).success,
    ).toBe(true);
    expect(
      HotelAvailabilityInputSchema.safeParse({
        ...busqueda,
        checkinDate: '2026-11-13',
        checkoutDate: '2026-11-10',
      }).success,
    ).toBe(true);
  });

  it('PR-0.5: la moneda de VENTA se normaliza a mayúsculas; el país del punto de venta, no', () => {
    // La puerta de moneda compara contra la moneda de cada tarifa, que llega en mayúsculas: un
    // `cop` sin normalizar las descartaría todas. El país sigue yendo tal cual al proveedor.
    const r = HotelAvailabilityInputSchema.parse({
      ...busqueda,
      currency: ' cop ',
      countryCode: 'co',
    });
    expect(r.currency).toBe('COP');
    expect(r.countryCode).toBe('co');
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, currency: 'C0P' }).success).toBe(
      false,
    );
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, currency: 'CO' }).success).toBe(
      false,
    );
    expect(
      HotelAvailabilityInputSchema.safeParse({ ...busqueda, countryCode: 'COL' }).success,
    ).toBe(false);
  });

  it('idioma sólo EN, ES o PT, en mayúsculas', () => {
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, language: 'ES' }).success).toBe(
      true,
    );
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, language: 'es' }).success).toBe(
      false,
    );
    expect(HotelAvailabilityInputSchema.safeParse({ ...busqueda, language: 'FR' }).success).toBe(
      false,
    );
  });

  it('PR-0.5: el TTL ya no es parte del borde: se descarta como cualquier clave desconocida', () => {
    // Era un parámetro de Despegar que la web nunca mandó y que el contrato neutral no tiene.
    const r = HotelAvailabilityInputSchema.parse({ ...busqueda, ttl: 30 });
    expect(r).not.toHaveProperty('ttl');
  });

  it('PR-0.5: nacionalidad del huésped principal, ISO alfa-2, normalizada a mayúsculas', () => {
    const r = HotelAvailabilityInputSchema.parse({ ...busqueda, guestNationality: 'ar' });
    expect(r.guestNationality).toBe('AR');
    expect(HotelAvailabilityInputSchema.parse(busqueda)).not.toHaveProperty('guestNationality');
  });
});

describe('guestNationality — nacionalidad del pasajero principal (RF-06, PR-2.4)', () => {
  function nacionalidad(valor: unknown) {
    return HotelAvailabilityInputSchema.safeParse({ ...busqueda, guestNationality: valor });
  }

  it("RF-06 CA 2: el alfa-3 del CRM se convierte: 'COL' → 'CO'", () => {
    expect(nacionalidad('COL').data?.guestNationality).toBe('CO');
  });

  it('PR-2.4 cambia PR-0.5: un alfa-3 ya no se rechaza, se convierte', () => {
    expect(nacionalidad('ARG').data?.guestNationality).toBe('AR');
    expect(nacionalidad(' ven ').data?.guestNationality).toBe('VE');
  });

  it.each(['Colombia', 'colombiano', 'XX', 'XKX', 'C0', '12', 'COLO', 'ß'])(
    'RF-06 CA 2: "%s" no convierte, no se envía y se le pide al vendedor',
    (valor) => {
      const r = nacionalidad(valor);
      expect(r.success).toBe(false);
      expect(r.error?.issues).toEqual([
        expect.objectContaining({ path: ['guestNationality'], message: GUEST_NATIONALITY_INVALID }),
      ]);
    },
  );

  it('el mensaje le dice al vendedor qué escribir y no repite lo que escribió', () => {
    expect(GUEST_NATIONALITY_INVALID).toContain('CO o COL');
    expect(nacionalidad('colombiano').error?.message).not.toContain('colombiano');
  });

  it.each(['', '   '])(
    'vacía ("%s") cuenta como ausente: el proveedor que la exige queda fuera',
    (valor) => {
      const r = nacionalidad(valor);
      expect(r.success).toBe(true);
      expect(r.data?.guestNationality).toBeUndefined();
    },
  );

  it('un valor que no es texto no pasa', () => {
    expect(nacionalidad(57).success).toBe(false);
  });

  it('el país del punto de venta no se convierte en nacionalidad', () => {
    const r = HotelAvailabilityInputSchema.parse({ ...busqueda, countryCode: 'CO' });
    expect(r.guestNationality).toBeUndefined();
  });

  it('el detalle aplica la misma regla', () => {
    const detalle = {
      hotelId: '101',
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-13',
      rooms: [{ adults: 2 }],
    };
    expect(
      HotelDetailInputSchema.parse({ ...detalle, guestNationality: 'per' }).guestNationality,
    ).toBe('PE');
    expect(HotelDetailInputSchema.safeParse({ ...detalle, guestNationality: 'Perú' }).success).toBe(
      false,
    );
  });
});

describe('HotelDetailInputSchema', () => {
  const detalle = {
    hotelId: '101',
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-13',
    rooms: [{ adults: 2 }],
  };

  it('pasa con hotel, fechas y habitaciones', () => {
    expect(HotelDetailInputSchema.parse(detalle)).toEqual({
      ...detalle,
      rooms: [{ adults: 2, childrenAges: [] }],
    });
  });

  it('el hotel es obligatorio', () => {
    expect(HotelDetailInputSchema.safeParse({ ...detalle, hotelId: '' }).success).toBe(false);
  });

  it('PR-0.5: el proveedor, si se nombra, es un código del registry', () => {
    expect(HotelDetailInputSchema.parse({ ...detalle, provider: 'despegar-hotels' }).provider).toBe(
      'despegar-hotels',
    );
    expect(
      HotelDetailInputSchema.safeParse({ ...detalle, provider: 'Despegar Hotels' }).success,
    ).toBe(false);
  });

  it('PR-0.5: moneda y nacionalidad normalizadas como en la búsqueda', () => {
    const r = HotelDetailInputSchema.parse({ ...detalle, currency: 'brl', guestNationality: 'pe' });
    expect(r.currency).toBe('BRL');
    expect(r.guestNationality).toBe('PE');
  });

  it('mismos límites de habitaciones que la búsqueda', () => {
    expect(HotelDetailInputSchema.safeParse({ ...detalle, rooms: habitaciones(8) }).success).toBe(
      true,
    );
    expect(HotelDetailInputSchema.safeParse({ ...detalle, rooms: habitaciones(9) }).success).toBe(
      false,
    );
    expect(HotelDetailInputSchema.safeParse({ ...detalle, rooms: [] }).success).toBe(false);
  });
});

describe('HotelSuggestQuerySchema', () => {
  it('texto de 1 a 120 caracteres', () => {
    expect(HotelSuggestQuerySchema.safeParse({ q: 'b' }).success).toBe(true);
    expect(HotelSuggestQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(HotelSuggestQuerySchema.safeParse({ q: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('PrebookSchema', () => {
  it('idioma en minúsculas (al revés que la búsqueda)', () => {
    expect(PrebookSchema.safeParse({ choiceId: 'CH-1', lang: 'es' }).success).toBe(true);
    expect(PrebookSchema.safeParse({ choiceId: 'CH-1', lang: 'ES' }).success).toBe(false);
  });

  it('`include` sólo admite las tres secciones de Despegar', () => {
    expect(
      PrebookSchema.safeParse({
        choiceId: 'CH-1',
        include: ['EXCHANGE_POLICIES', 'IMPORTANT_DATA', 'HINTS'],
      }).success,
    ).toBe(true);
    expect(PrebookSchema.safeParse({ choiceId: 'CH-1', include: ['OTHER'] }).success).toBe(false);
  });

  it('sin `choiceId` no pasa', () => {
    expect(PrebookSchema.safeParse({}).success).toBe(false);
  });
});

describe('PaymentOptionsQuerySchema', () => {
  it('los números del query string se coaccionan', () => {
    expect(PaymentOptionsQuerySchema.parse({ prebookId: 'PB-1', inputPoints: '10' })).toEqual({
      prebookId: 'PB-1',
      inputPoints: 10,
    });
  });

  it('`includeHints=false` en el query string llega como `true`', () => {
    // Discutible: `z.coerce.boolean()` convierte cualquier texto no vacío en `true`. Queda fijado
    // para que el arreglo sea una decisión visible.
    expect(PaymentOptionsQuerySchema.parse({ prebookId: 'PB-1', includeHints: 'false' })).toEqual({
      prebookId: 'PB-1',
      includeHints: true,
    });
  });

  it('puntos negativos no pasan', () => {
    expect(
      PaymentOptionsQuerySchema.safeParse({ prebookId: 'PB-1', inputPoints: -1 }).success,
    ).toBe(false);
  });
});

describe('BookSchema', () => {
  const reserva = {
    prebookId: 'PB-0001',
    externalBookingReference: 'ISO-0001',
    contact: { email: 'reservas@agencia.example' },
    travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
    payment: { optionType: 'ONE_CARD', units: [{ planId: 'PL-1', secureToken: 'tok_hosted' }] },
  };

  it('la reserva mínima pasa', () => {
    expect(BookSchema.safeParse(reserva).success).toBe(true);
  });

  it('al menos un viajero y una unidad de pago', () => {
    expect(BookSchema.safeParse({ ...reserva, travelers: [] }).success).toBe(false);
    expect(
      BookSchema.safeParse({ ...reserva, payment: { ...reserva.payment, units: [] } }).success,
    ).toBe(false);
  });

  it('nombre hasta 28 caracteres y apellido hasta 29 (límites de Despegar)', () => {
    const viajero = (firstName: string, lastName: string) => ({
      ...reserva,
      travelers: [{ referenceId: '1', firstName, lastName }],
    });
    expect(BookSchema.safeParse(viajero('a'.repeat(28), 'b'.repeat(29))).success).toBe(true);
    expect(BookSchema.safeParse(viajero('a'.repeat(29), 'b')).success).toBe(false);
    expect(BookSchema.safeParse(viajero('a', 'b'.repeat(30))).success).toBe(false);
  });

  it('el email de contacto se valida', () => {
    expect(BookSchema.safeParse({ ...reserva, contact: { email: 'no-es-email' } }).success).toBe(
      false,
    );
  });

  it('la unidad de pago exige el token del checkout hosted', () => {
    const sinToken = { ...reserva, payment: { ...reserva.payment, units: [{ planId: 'PL-1' }] } };
    expect(BookSchema.safeParse(sinToken).success).toBe(false);
  });

  it('una clave con forma de tarjeta en la unidad de pago no sobrevive al esquema', () => {
    // PCI SAQ-A: el esquema descarta lo que no declara, así que un dato de tarjeta que llegue
    // del browser no viaja a Despegar.
    const conTarjeta = {
      ...reserva,
      payment: {
        ...reserva.payment,
        units: [{ planId: 'PL-1', secureToken: 'tok_hosted', cardNumber: '4111111111111111' }],
      },
    };
    const r = BookSchema.parse(conTarjeta);
    expect(r.payment.units[0]).toEqual({ planId: 'PL-1', secureToken: 'tok_hosted' });
  });

  it('`testCase` sólo admite el escenario de sandbox `pricejump`', () => {
    expect(BookSchema.safeParse({ ...reserva, testCase: 'pricejump' }).success).toBe(true);
    expect(BookSchema.safeParse({ ...reserva, testCase: 'otro' }).success).toBe(false);
  });
});

describe('CancelBodySchema', () => {
  it('el motivo es opcional', () => {
    expect(CancelBodySchema.parse({})).toEqual({});
  });

  it('sólo motivos del catálogo de Despegar', () => {
    expect(CancelBodySchema.safeParse({ reason: 'ILLNESS' }).success).toBe(true);
    expect(CancelBodySchema.safeParse({ reason: 'CAPRICHO' }).success).toBe(false);
  });
});

describe('RecoveryBodySchema', () => {
  it('al menos una confirmación', () => {
    const base = { messageType: 'PRICE_JUMP' };
    expect(
      RecoveryBodySchema.safeParse({ ...base, confirmations: [{ flavorId: 'H0', confirm: true }] })
        .success,
    ).toBe(true);
    expect(RecoveryBodySchema.safeParse({ ...base, confirmations: [] }).success).toBe(false);
  });
});
